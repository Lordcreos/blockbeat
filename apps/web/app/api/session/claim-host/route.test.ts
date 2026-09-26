import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Hash } from 'viem';
import { HostError, type HostService } from '@/lib/host/service';
import { HOST_HEADER } from '@/lib/host/auth';

const TX = `0x${'cd'.repeat(32)}` as Hash;
const claimHost = vi.fn<HostService['claimHost']>();
vi.mock('@/lib/host/runtime', () => ({ getHostService: (): HostService => ({ startSession: vi.fn(), finalize: vi.fn(), claimHost }) }));

const { POST } = await import('./route');

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/session/claim-host', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('POST /api/session/claim-host (W21b)', () => {
  beforeEach(() => {
    claimHost.mockReset();
    vi.stubEnv('HOST_SECRET', 'top');
    vi.stubEnv('HOST_PRIVATE_KEY', '');
    vi.stubEnv('NEXT_PUBLIC_BLOCKBEAT_MOCK', '');
    vi.stubEnv('NEXT_PUBLIC_BLOCKBEAT_ADDRESS', '0x5FbDB2315678afecb367f032d93F642f64180aa3');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('refuses a missing or wrong host secret before touching the service', async () => {
    expect((await POST(post({ sessionId: '7' }))).status).toBe(401);
    expect((await POST(post({ sessionId: '7' }, { [HOST_HEADER]: 'nope' }))).status).toBe(401);
    expect(claimHost).not.toHaveBeenCalled();
  });

  it('refuses when HOST_SECRET is not configured outside mock mode', async () => {
    vi.stubEnv('HOST_SECRET', '');
    expect((await POST(post({ sessionId: '7' }, { [HOST_HEADER]: 'top' }))).status).toBe(503);
    expect(claimHost).not.toHaveBeenCalled();
  });

  it('validates the session id and the body size', async () => {
    for (const body of ['{nope', {}, { sessionId: 0 }, { sessionId: 'abc' }]) {
      expect((await POST(post(body, { [HOST_HEADER]: 'top' }))).status, JSON.stringify(body)).toBe(400);
    }
    expect((await POST(post({ sessionId: '7' }, { [HOST_HEADER]: 'top', 'content-length': '5000' }))).status).toBe(413);
    expect(claimHost).not.toHaveBeenCalled();
  });

  it('pulls the host share and returns the amount and tx as strings', async () => {
    claimHost.mockResolvedValueOnce({ sessionId: 7n, amountWei: 4_000_000_000_000_000n, txHash: TX });
    const res = await POST(post({ sessionId: '7' }, { [HOST_HEADER]: 'top' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sessionId: '7', amountWei: '4000000000000000', txHash: TX });
    expect(claimHost).toHaveBeenCalledWith(7n);
  });

  it('maps a revert (nothing to claim) to 409 and hides unexpected errors', async () => {
    claimHost.mockRejectedValueOnce(new HostError('TX_REVERTED', 'claimHost reverted'));
    expect((await POST(post({ sessionId: 7 }, { [HOST_HEADER]: 'top' }))).status).toBe(409);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    claimHost.mockRejectedValueOnce(new Error('rpc https://x/key=secret'));
    const res = await POST(post({ sessionId: 7 }, { [HOST_HEADER]: 'top' }));
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain('secret');
    spy.mockRestore();
  });
});
