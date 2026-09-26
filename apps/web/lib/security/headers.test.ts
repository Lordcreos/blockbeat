import { describe, expect, it } from 'vitest';
import { buildContentSecurityPolicy, buildSecurityHeaders } from './headers';

function directive(csp: string, name: string): string {
  const found = csp.split(';').map((d) => d.trim()).find((d) => d.startsWith(`${name} `) || d === name);
  if (!found) throw new Error(`no ${name} directive in ${csp}`);
  return found;
}

describe('security headers (review M7)', () => {
  it('lets the page reach the testnet RPC over https and wss; a local anvil and a cloudflared tunnel only in dev', () => {
    const prod = directive(buildContentSecurityPolicy({}, { dev: false }), 'connect-src');
    for (const origin of ["'self'", 'https://testnet-rpc.monad.xyz', 'wss://testnet-rpc.monad.xyz']) expect(prod).toContain(origin);
    // A production build never carries a wildcard an attacker could register a subdomain under.
    expect(prod).not.toContain('trycloudflare');
    expect(prod).not.toContain('localhost');
    const dev = directive(buildContentSecurityPolicy({}, { dev: true }), 'connect-src');
    for (const origin of ['http://127.0.0.1:*', 'ws://127.0.0.1:*', 'http://localhost:*', 'ws://localhost:*', 'https://*.trycloudflare.com', 'wss://*.trycloudflare.com']) {
      expect(dev).toContain(origin);
    }
  });

  it('adds the RPC origins configured in the env (a provider endpoint, an anvil tunnel)', () => {
    const csp = buildContentSecurityPolicy(
      { NEXT_PUBLIC_MONAD_RPC_URL: 'https://monad-testnet.g.alchemy.com/v2/secret-key', NEXT_PUBLIC_MONAD_WS_URL: 'wss://monad-testnet.g.alchemy.com/v2/secret-key' },
      { dev: false },
    );
    const connect = directive(csp, 'connect-src');
    expect(connect).toContain('https://monad-testnet.g.alchemy.com');
    expect(connect).toContain('wss://monad-testnet.g.alchemy.com');
    // Origins only: the provider key in the path never lands in a response header.
    expect(csp).not.toContain('secret-key');
  });

  it('rejects a malformed RPC url at build time', () => {
    expect(() => buildContentSecurityPolicy({ NEXT_PUBLIC_MONAD_RPC_URL: 'not a url' }, { dev: false })).toThrow(/NEXT_PUBLIC_MONAD_RPC_URL/);
  });

  it('locks down everything else and only relaxes eval for the dev overlay', () => {
    const prod = buildContentSecurityPolicy({}, { dev: false });
    expect(directive(prod, 'default-src')).toBe("default-src 'self'");
    expect(directive(prod, 'object-src')).toBe("object-src 'none'");
    expect(directive(prod, 'frame-ancestors')).toBe("frame-ancestors 'none'");
    expect(directive(prod, 'base-uri')).toBe("base-uri 'self'");
    expect(directive(prod, 'form-action')).toBe("form-action 'self'");
    expect(directive(prod, 'script-src')).not.toContain("'unsafe-eval'");
    expect(directive(prod, 'img-src')).toContain('data:');
    expect(directive(prod, 'worker-src')).toContain('blob:');
    const dev = buildContentSecurityPolicy({}, { dev: true });
    expect(directive(dev, 'script-src')).toContain("'unsafe-eval'");
  });

  it('ships the baseline headers for every route', () => {
    const headers = buildSecurityHeaders({}, { dev: false });
    const byKey = Object.fromEntries(headers.map((h) => [h.key, h.value]));
    expect(byKey['Content-Security-Policy']).toContain('connect-src');
    expect(byKey['X-Content-Type-Options']).toBe('nosniff');
    expect(byKey['X-Frame-Options']).toBe('DENY');
    expect(byKey['Referrer-Policy']).toBe('strict-origin-when-cross-origin');
    expect(byKey['Permissions-Policy']).toContain('camera=()');
  });
});
