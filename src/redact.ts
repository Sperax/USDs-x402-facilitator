/**
 * Strip URLs out of error text before it leaves the process.
 *
 * viem and the x402 facilitator library put the failing RPC endpoint into their
 * error messages ("URL: https://arb-mainnet.g.alchemy.com/v2/<key>"). Those
 * messages reached clients through /verify and /settle failure reasons, /ready
 * checks and the /stats staleness header. With a keyed RPC provider that is a
 * credential leak, so every URL is reduced to its origin: the provider host
 * stays visible for debugging, while path, query and userinfo (where providers
 * put API keys) are dropped.
 */
const URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>`)\]]+/gi;

export function redact(text: string): string {
  return text.replace(URL_PATTERN, (match) => {
    try {
      const url = new URL(match);
      return url.pathname === '/' && !url.search && !url.username && !url.password ? url.origin : `${url.origin}/[redacted]`;
    } catch {
      return '[redacted-url]';
    }
  });
}

/** The message of an unknown thrown value, redacted. */
export function errorText(err: unknown): string {
  return redact(err instanceof Error ? err.message : String(err));
}

const REASON_FIELDS = ['invalidReason', 'invalidMessage', 'errorReason', 'errorMessage'] as const;

/** Redact the free-text reason fields of a verify or settle result. */
export function redactResult<T extends object>(result: T): T {
  const out: Record<string, unknown> = { ...(result as Record<string, unknown>) };
  for (const field of REASON_FIELDS) {
    if (typeof out[field] === 'string') out[field] = redact(out[field] as string);
  }
  return out as T;
}
