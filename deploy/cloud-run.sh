#!/usr/bin/env bash
# Build the image on Cloud Build and deploy the facilitator to Cloud Run.
#
#   deploy/cloud-run.sh                  build + deploy the current commit
#   SKIP_BUILD=1 deploy/cloud-run.sh     redeploy the image tagged IMAGE_TAG (default: latest)
#
# The deploy is declarative: it sets the service's complete env and secret
# configuration, so a redeploy always lands the same configuration and never
# keeps a setting someone changed by hand. Put a persistent extra setting in
# EXTRA_ENV_VARS ('|'-separated, e.g. EXTRA_ENV_VARS='MIN_GAS_BALANCE_WEI=300000000000000|CONTACT_EMAIL=ops@example.com').
#
# Secrets (Secret Manager, read at revision start, never in env files or the image):
#   KEY_SECRET           settlement wallet private key  -> FACILITATOR_PRIVATE_KEY
#   ARBITRUM_RPC_SECRET  Arbitrum One RPC URL(s)        -> ARBITRUM_RPC_URL
#   BASE_RPC_SECRET      Base RPC URL(s)                -> BASE_RPC_URL
#
# Prerequisites (one time per secret): the runtime service account can read it:
#   gcloud secrets add-iam-policy-binding <secret> --project $PROJECT \
#     --member=serviceAccount:$RUNTIME_SA --role=roles/secretmanager.secretAccessor
set -euo pipefail

cd "$(dirname "$0")/.."

PROJECT="${PROJECT:-aerial-vehicle-466722-p5}"
REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-sperax-x402-facilitator}"
IMAGE="${IMAGE:-us-central1-docker.pkg.dev/$PROJECT/containers/sperax-x402-facilitator}"
RUNTIME_SA="${RUNTIME_SA:-three-ws@$PROJECT.iam.gserviceaccount.com}"
KEY_SECRET="${KEY_SECRET:-sperax-x402-facilitator-key-20261121}"
ARBITRUM_RPC_SECRET="${ARBITRUM_RPC_SECRET:-sperax-facilitator-arbitrum-rpc-url}"
BASE_RPC_SECRET="${BASE_RPC_SECRET:-sperax-facilitator-base-rpc-url}"
DEMO_PAY_TO="${DEMO_PAY_TO:-0x40252CFDF8B20Ed757D61ff157719F33Ec332402}"
EXTRA_ENV_VARS="${EXTRA_ENV_VARS:-}"

if [ -n "${SKIP_BUILD:-}" ]; then
  IMAGE_TAG="${IMAGE_TAG:-latest}"
else
  if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
    echo "Refusing to build: the working tree has uncommitted changes, so the image would not match its tag." >&2
    exit 1
  fi
  IMAGE_TAG="$(git rev-parse --short HEAD)"
fi

# Fail before touching the service when a secret is missing, has no enabled
# version, or the runtime account cannot read it.
for secret in "$KEY_SECRET" "$ARBITRUM_RPC_SECRET" "$BASE_RPC_SECRET"; do
  if ! gcloud secrets versions describe latest --secret "$secret" --project "$PROJECT" \
      --format 'value(state)' 2>/dev/null | grep -qx ENABLED; then
    echo "Secret $secret has no enabled latest version in $PROJECT." >&2
    exit 1
  fi
  if ! gcloud secrets get-iam-policy "$secret" --project "$PROJECT" \
      --flatten 'bindings[].members' \
      --filter "bindings.role=roles/secretmanager.secretAccessor AND bindings.members=serviceAccount:$RUNTIME_SA" \
      --format 'value(bindings.members)' | grep -q .; then
    # Access may also come from a project-level grant; warn instead of failing.
    echo "Warning: no secret-level accessor binding for $RUNTIME_SA on $secret; relying on project-level IAM." >&2
  fi
done

if [ -z "${SKIP_BUILD:-}" ]; then
  gcloud builds submit --project "$PROJECT" --region "$REGION" \
    --config deploy/cloudbuild.yaml --substitutions "_IMAGE=$IMAGE,_TAG=$IMAGE_TAG" .
fi

ENV_VARS="ENABLE_BASE=true|LOG_LEVEL=info|CONFIRMATION_TIMEOUT_MS=60000|DEMO_PAY_TO=$DEMO_PAY_TO${EXTRA_ENV_VARS:+|$EXTRA_ENV_VARS}"
SECRETS="FACILITATOR_PRIVATE_KEY=$KEY_SECRET:latest,ARBITRUM_RPC_URL=$ARBITRUM_RPC_SECRET:latest,BASE_RPC_URL=$BASE_RPC_SECRET:latest"

# One instance: pending settlements are tracked in memory, and a single
# signer keeps nonces sequential. Raise max-instances only after moving the
# pending-settlement store to shared storage.
gcloud run deploy "$SERVICE" --project "$PROJECT" --region "$REGION" \
  --image "$IMAGE:$IMAGE_TAG" \
  --service-account "$RUNTIME_SA" \
  --allow-unauthenticated \
  --min-instances 1 --max-instances 1 \
  --cpu 1 --memory 512Mi --timeout 120 \
  --set-secrets "$SECRETS" \
  --set-env-vars "^|^$ENV_VARS"

URL="$(gcloud run services describe "$SERVICE" --project "$PROJECT" --region "$REGION" --format 'value(status.url)')"
echo "Deployed: $URL"
curl -fsS "$URL/supported" && echo
# /ready is 503 when an RPC is down or signer gas is below MIN_GAS_BALANCE_WEI.
curl -fsS "$URL/ready" && echo
