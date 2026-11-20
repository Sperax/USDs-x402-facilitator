/**
 * Cloud Run, Cloudflare and other proxies terminate TLS in front of the app,
 * so the request URL the server sees starts with http://. x402 publishes that
 * URL as the 402's resource.url, which must be the one clients actually call,
 * so rebuild it from the proxy's X-Forwarded-Proto.
 */
export function withForwardedProto(req: Request): Request {
  const proto = req.headers.get('x-forwarded-proto')?.split(',')[0]?.trim();
  if (proto !== 'https' || !req.url.startsWith('http://')) return req;
  const url = `https://${req.url.slice('http://'.length)}`;
  const init: RequestInit & { duplex?: 'half' } = { method: req.method, headers: req.headers, redirect: req.redirect };
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    init.body = req.body;
    init.duplex = 'half';
  }
  return new Request(url, init);
}

/**
 * The client address to rate-limit on. Each proxy in front of the app appends
 * the address it received the connection from to X-Forwarded-For, so only the
 * last `trustedHops` entries were written by infrastructure; anything before
 * them is whatever the client chose to send. Cloud Run's front end appends one
 * entry (the default); an external HTTPS load balancer in front of Cloud Run
 * appends two. With zero trusted hops, or a header shorter than the hop count,
 * no forwarded address is trusted.
 */
export function clientAddress(forwardedFor: string | undefined, trustedHops: number): string {
  if (trustedHops <= 0 || !forwardedFor) return 'direct';
  const hops = forwardedFor.split(',').map((s) => s.trim()).filter(Boolean);
  if (hops.length < trustedHops) return 'direct';
  return hops[hops.length - trustedHops];
}
