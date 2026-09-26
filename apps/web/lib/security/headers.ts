/**
 * Baseline security headers for every route (review M7). The burner private key lives in
 * localStorage and the page is public through a tunnel for the whole evening, so the CSP
 * limits where scripts, styles and connections may come from. Inline scripts stay allowed
 * (Next.js hydration payloads are inline and this app uses no nonces); eval is dev-only
 * for the Next dev overlay and React refresh.
 *
 * connect-src must cover every RPC the phones may talk to: the Monad testnet endpoints and
 * whatever NEXT_PUBLIC_MONAD_RPC_URL / NEXT_PUBLIC_MONAD_WS_URL point at (origins only, so a
 * provider key in the path never reaches a response header). Only in dev (`next dev`, which
 * is what the demo runs) it also allows a local anvil and cloudflared quick tunnels, so an
 * anvil fallback exposed to phones works; a production build never carries the wildcard.
 */
import { MONAD_TESTNET_RPC_HTTP, MONAD_TESTNET_RPC_WS } from '@blockbeat/shared';

export interface SecurityHeader {
  key: string;
  value: string;
}

export interface HeaderOptions {
  dev: boolean;
}

type Env = Record<string, string | undefined>;

const STATIC_CONNECT = ["'self'", MONAD_TESTNET_RPC_HTTP, MONAD_TESTNET_RPC_WS];
const DEV_CONNECT = [
  'http://127.0.0.1:*',
  'ws://127.0.0.1:*',
  'http://localhost:*',
  'ws://localhost:*',
  'https://*.trycloudflare.com',
  'wss://*.trycloudflare.com',
];

function originOf(env: Env, name: string): string | null {
  const raw = env[name]?.trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} is not a valid URL (needed for the Content-Security-Policy connect-src)`);
  }
  return url.origin;
}

export function buildContentSecurityPolicy(env: Env, { dev }: HeaderOptions): string {
  const connect = new Set([...STATIC_CONNECT, ...(dev ? DEV_CONNECT : [])]);
  for (const name of ['NEXT_PUBLIC_MONAD_RPC_URL', 'NEXT_PUBLIC_MONAD_WS_URL']) {
    const origin = originOf(env, name);
    if (origin) connect.add(origin);
  }
  const script = ["'self'", "'unsafe-inline'", ...(dev ? ["'unsafe-eval'"] : [])];
  const directives = [
    "default-src 'self'",
    `script-src ${script.join(' ')}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src ${[...connect].join(' ')}`,
    "media-src 'self' blob: data:",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ];
  return directives.join('; ');
}

export function buildSecurityHeaders(env: Env, options: HeaderOptions): SecurityHeader[] {
  return [
    { key: 'Content-Security-Policy', value: buildContentSecurityPolicy(env, options) },
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'X-Frame-Options', value: 'DENY' },
    { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
  ];
}
