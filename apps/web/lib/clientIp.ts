/**
 * Client IP for the per-IP rate limiters (drip and host auth), review H5.
 *
 * Order: `cf-connecting-ip` (set only by the Cloudflare tunnel the demo runs through),
 * then the right-most `x-forwarded-for` hop (appended by the nearest proxy; earlier
 * entries are client-controlled), then "unknown". `x-real-ip` is never consulted: the
 * tunnel does not set it, so a client can send a fresh value per request and bypass the
 * cap. Behind no proxy at all (local dev) the value is spoofable, which is why the drip
 * service also has a global cap.
 */
export function clientIp(request: Request): string {
  const cf = request.headers.get('cf-connecting-ip')?.trim();
  if (cf) return cf;
  const last = request.headers.get('x-forwarded-for')?.split(',').at(-1)?.trim();
  return last || 'unknown';
}
