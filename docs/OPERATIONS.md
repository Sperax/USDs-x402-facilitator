# Operations: the live Sperax x402 facilitator

How the production facilitator at https://x402.sperax.io is deployed, what it is connected to, and how to run it. Facts are as of 2026-11-22.

## At a glance

| | |
|---|---|
| Public URL | https://x402.sperax.io |
| Demo page | https://x402.sperax.io/demo |
| Discovery document | https://x402.sperax.io/openapi.json |
| Health | https://x402.sperax.io/ready (per-network RPC and signer gas) |
| Networks | Arbitrum One `eip155:42161` (USDs via Permit2, USDC via EIP-3009), Base `eip155:8453` (USDC via EIP-3009) |
| Signer wallet | `0x402BB1A2B614E4FBa1a19b270fb8183FA7E18402` (pays settlement gas and sponsored approvals on both chains) |
| Demo payee | `0x40252CFDF8B20Ed757D61ff157719F33Ec332402` (`DEMO_PAY_TO`) |
| First mainnet USDs payment over x402 | [0x4b95dec2...d3f2](https://arbiscan.io/tx/0x4b95dec2536a2911cab43f494d299d2093406b8f1576c84b4a7935106221d3f2) (0.001 USDs for `/demo/usds-snapshot`, settled through the canonical x402 Permit2 proxy) |

## Hosting

- **Google Cloud Run** service `sperax-x402-facilitator`, project `aerial-vehicle-466722-p5`, region `us-central1`.
- One instance (`min-instances 1`, `max-instances 1`). Pending settlements are tracked in memory and a single signer keeps nonces sequential; raise the instance count only after moving the pending-settlement store to shared storage.
- Image: `us-central1-docker.pkg.dev/aerial-vehicle-466722-p5/containers/sperax-x402-facilitator:<git short sha>`, built on Cloud Build by [`deploy/cloud-run.sh`](../deploy/cloud-run.sh) with the build service account `three-ws-build@`, running as `three-ws@`.
- Secrets are **never** in env files or the image. Cloud Run reads them from Secret Manager at revision start:

  | Env var | Secret | Holds |
  |---|---|---|
  | `FACILITATOR_PRIVATE_KEY` | `sperax-x402-facilitator-key-20261121` | Signer key |
  | `ARBITRUM_RPC_URL` | `sperax-facilitator-arbitrum-rpc-url` | Keyed Arbitrum One RPC URL(s), comma-separated for failover |
  | `BASE_RPC_URL` | `sperax-facilitator-base-rpc-url` | Keyed Base RPC URL(s) |

- Plain settings: `ENABLE_BASE=true`, `DEMO_PAY_TO=0x40252CFDF8B20Ed757D61ff157719F33Ec332402`, `LOG_LEVEL=info`, `CONFIRMATION_TIMEOUT_MS=60000`.
- The deploy script is declarative: it sets the complete env and secret configuration with `--set-env-vars` and `--set-secrets`, so a setting changed by hand is reset on the next deploy. Make a persistent change in the script, or pass it as `EXTRA_ENV_VARS` (`|`-separated). Before it deploys, the script checks that each secret has an enabled latest version, and it refuses to build from a dirty working tree.

## Domain

`x402.sperax.io` is a **Cloud Run domain mapping** with a Google-managed certificate.

- `sperax.io` is verified in Google Search Console (DNS TXT record added through Cloudflare's one-click flow). Do not remove the `google-site-verification` TXT record at the zone apex, or the mapping loses its verification.
- The sperax.io DNS zone is in the Cloudflare account **Engineering_team@sperax.io**. The record is:

  | Type | Name | Target | Proxy |
  |---|---|---|---|
  | CNAME | `x402` | `ghs.googlehosted.com` | DNS only (grey cloud) |

  Keep it DNS only. A proxied (orange cloud) record hides it from Google and certificate renewal fails.
- The domain previously pointed at a Railway app (`bxx3kffr.up.railway.app`) that no longer exists.

## Registry listings

### x402scan

- **Listed** on 2026-09-18: 1 paid route (`GET /demo/usds-snapshot`, $0.001) and 4 free routes, 0 failures.
- x402scan reads `/openapi.json`, then probes each paid route for its 402. It only indexes **Base and Solana**, so the paid route offers USDC on Base after USDs on Arbitrum. Payments settled on Arbitrum are not counted in x402scan's volume; `/stats` and `/demo` here count them.
- Re-register after adding or changing paid routes:

  ```bash
  REGISTRAR_PRIVATE_KEY=0x... pnpm register:x402scan https://x402.sperax.io
  ```

  The wallet only signs a Sign-In-With-X login message; no funds move. Setting `CONTACT_EMAIL` publishes `info.contact.email`, which x402scan uses for ownership verification and the merchant page.

### agentic.market (Coinbase Bazaar)

Not listed yet. agentic.market is fed by Coinbase's Bazaar, which catalogs a route only after a paid call settles through the **CDP facilitator** (there is no submission form). The demo route already declares the Bazaar discovery extension; listing needs a route whose seller settles through CDP, which needs a Sperax CDP API key.

### Upstream x402 SDKs

Branch [`nirholas/x402:feat/arbitrum-usds-default-asset`](https://github.com/nirholas/x402/tree/feat/arbitrum-usds-default-asset) adds USDs on Arbitrum One as a Permit2 default asset in the TypeScript, Go and Python SDKs, so every x402 client recognizes USDs without a manual spend-control opt-in. Tests pass in all three SDKs. It was opened upstream as [x402-foundation/x402#3513](https://github.com/x402-foundation/x402/pull/3513), whose description cites the mainnet settlement above, and closed unmerged on 2026-09-18 because upstream requires signed commits. To land it, re-sign the branch's commits (`git rebase --exec 'git commit --amend --no-edit -S' upstream/main`), force-push the branch and open a new pull request with the description in [upstream-default-asset-pr.md](upstream-default-asset-pr.md). Until then, clients opt in to USDs with `usdsSpendControl()` from `src/assets.ts`.

## Wallets and funding

| Wallet | Role | Funds |
|---|---|---|
| `0x402BB1A2B614E4FBa1a19b270fb8183FA7E18402` | Facilitator signer | ETH on Arbitrum One and Base for gas |
| `0x40252CFDF8B20Ed757D61ff157719F33Ec332402` | Demo payee (`DEMO_PAY_TO`) | Receives demo payments |
| `0x562435c6f3853D742F9F1FbE6f5AEc414eE7721F` | Test buyer | USDs on Arbitrum One |

Keys live in Secret Manager (`sperax-x402-facilitator-key-20261121`, `sperax-x402-test-buyer-key`). `/ready` returns 503 when the signer's gas on any enabled network drops below `MIN_GAS_BALANCE_WEI` (0.0002 ETH by default); top it up before that. Each settlement costs a few cents of gas at most on either chain; a sponsored first-time approval adds about 0.00007 ETH on Arbitrum.

## Runbook

| Task | Command |
|---|---|
| Build and deploy | `./deploy/cloud-run.sh` |
| Redeploy the last built image | `SKIP_BUILD=1 ./deploy/cloud-run.sh` (`IMAGE_TAG=<sha>` to roll back) |
| Persistent extra setting | `EXTRA_ENV_VARS='MIN_GAS_BALANCE_WEI=300000000000000' ./deploy/cloud-run.sh` |
| Change an RPC URL | `printf %s "$URL" \| gcloud secrets versions add sperax-facilitator-arbitrum-rpc-url --data-file=- --project aerial-vehicle-466722-p5`, then `SKIP_BUILD=1 ./deploy/cloud-run.sh` |
| Health | `curl https://x402.sperax.io/ready` |
| Logs | `gcloud logging read 'resource.type="cloud_run_revision" resource.labels.service_name="sperax-x402-facilitator"' --project aerial-vehicle-466722-p5 --freshness=1h` |
| Domain and certificate state | `gcloud beta run domain-mappings describe --domain x402.sperax.io --region us-central1 --project aerial-vehicle-466722-p5` |
| Verify end to end locally | `pnpm test && pnpm test:fork` |

Logs are one JSON object per line: `verify`, `settle` (with transaction hash), `sponsored approve gas`, `sponsored approval already landed; settling through the existing allowance` (a parallel first payment reusing another payment's approval), and `payment rejected before chain interaction` (the USDs permit guard).

## Alerting

- Cloud Monitoring uptime check "Sperax x402 facilitator /ready" (`uptimeCheckConfigs/sperax-x402-facilitator-ready-6gDBH3cct7w`) requests `https://x402.sperax.io/ready` every 60 s from Oregon, Iowa, Virginia and Europe. It expects a 2xx with `"status":"ready"` in the body.
- Alert policy `alertPolicies/16154984759970592663` fires when more than one region fails for 2 minutes. It emails the existing project notification channel `notificationChannels/18412267498156506146`.
- The three.ws uptime policy (`alertPolicies/13045175392198891564`) excludes this check, so one outage sends one alert.
- When it fires: `curl -s https://x402.sperax.io/ready` shows which network failed. `rpc` failing means the keyed RPC is down or out of quota, so rotate the RPC secret (runbook above). `gas` below the minimum means the signer needs ETH on that chain.

## Key rotation history

| Date | Change |
|---|---|
| 2026-11-21 | Signer rotated to `0x402BB1A2B614E4FBa1a19b270fb8183FA7E18402` (secret `sperax-x402-facilitator-key-20261121`) after the previous key was exposed in a local transcript. The previous signers `0x4028…3402` (`sperax-x402-facilitator-key-402`) and `0x42FfaFb149655407AAFD63628275fce64232EE21` (`sperax-x402-facilitator-key`) were swept to dust, and their secret versions are disabled. Settlement through the new signer was verified on mainnet on both chains. |

To rotate: generate the key offline and add it to a new dated secret without printing it. Grant `three-ws@` `secretAccessor`, fund the address with ETH on both chains, and deploy with `KEY_SECRET=<new secret>`. Confirm `/ready` and one paid call on each chain. Then sweep the old address and disable the old secret's versions (`gcloud secrets versions disable`). Update `KEY_SECRET`'s default in `deploy/cloud-run.sh` and this document.
