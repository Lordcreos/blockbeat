import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Hash } from 'viem';
import { HostError, type HostService } from '@/lib/host/service';
import { HOST_HEADER } from '@/lib/host/auth';
import { MAX_AUTH_FAILURES_PER_MINUTE } from '@/lib/host/http';

const TX = `0x${'cd'.repeat(32)}` as Hash;
const startSession = vi.fn<HostService['startSession']>();
const finalize = vi.fn<HostService['finalize']>();
vi.mock('@/lib/host/runtime', () => ({ getHostService: (): HostService => ({ startSession, finalize }) }));

const { POST } = await import('./route');

function post(headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/session/start', { method: 'POST', headers });
}

describe('POST /api/session/start', () => {
  beforeEach(() => {
    startSession.mockReset();
    finalize.mockReset();
    vi.stubEnv('HOST_SECRET', 'top');
    vi.stubEnv('HOST_PRIVATE_KEY', '');
    vi.stubEnv('NEXT_PUBLIC_BLOCKBEAT_MOCK', '');
    vi.stubEnv('NEXT_PUBLIC_BLOCKBEAT_ADDRESS', '0x5FbDB2315678afecb367f032d93F642f64180aa3');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('rejects a missing or wrong secret with 401 and never touches the service', async () => {
    expect((await POST(post())).status).toBe(401);
    expect((await POST(post({ [HOST_HEADER]: 'nope' }))).status).toBe(401);
    expect(startSession).not.toHaveBeenCalled();
  });

  it('returns 503 HOST_NOT_CONFIGURED when no secret is configured in chain mode', async () => {
    vi.stubEnv('HOST_SECRET', '');
    const res = await POST(post({ [HOST_HEADER]: '' }));
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('HOST_NOT_CONFIGURED');
    expect(startSession).not.toHaveBeenCalled();
  });

  it('fails closed in mock mode when a host key is configured but no secret is', async () => {
    vi.stubEnv('HOST_SECRET', '');
    vi.stubEnv('NEXT_PUBLIC_BLOCKBEAT_MOCK', '1');
    vi.stubEnv('HOST_PRIVATE_KEY', `0x${'11'.repeat(32)}`);
    const res = await POST(post());
    expect(res.status).toBe(503);
    expect(startSession).not.toHaveBeenCalled();
  });

  it('rate-limits repeated wrong secrets per IP with 429, keyed by cf-connecting-ip and never x-real-ip (review H5)', async () => {
    expect(MAX_AUTH_FAILURES_PER_MINUTE).toBe(30); // review L1: typos on stage must not lock the presenter out
    const statuses: number[] = [];
    for (let i = 0; i < 32; i++) {
      // A rotating x-real-ip must not reset the bucket.
      statuses.push((await POST(post({ [HOST_HEADER]: 'nope', 'cf-connecting-ip': '203.0.113.9', 'x-real-ip': `10.0.0.${i}` }))).status);
    }
    expect(statuses.slice(0, 30).every((s) => s === 401)).toBe(true);
    expect(statuses.slice(30)).toEqual([429, 429]);
    // Other IPs and the right secret are unaffected.
    startSession.mockResolvedValueOnce({ sessionId: 1n, txHash: null });
    expect((await POST(post({ [HOST_HEADER]: 'top', 'cf-connecting-ip': '203.0.113.10' }))).status).toBe(200);
  });

  it('lets an unconfigured secret through in mock mode only', async () => {
    vi.stubEnv('HOST_SECRET', '');
    vi.stubEnv('NEXT_PUBLIC_BLOCKBEAT_MOCK', '1');
    startSession.mockResolvedValueOnce({ sessionId: 1n, txHash: null });
    const res = await POST(post());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sessionId: '1', txHash: null });
  });

  it('starts a session and returns the id as a string', async () => {
    startSession.mockResolvedValueOnce({ sessionId: 42n, txHash: TX });
    const res = await POST(post({ [HOST_HEADER]: 'top' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sessionId: '42', txHash: TX });
  });

  it('maps HostError codes to statuses and hides unexpected errors', async () => {
    startSession.mockRejectedValueOnce(new HostError('SEND_FAILED', 'rpc down'));
    const res = await POST(post({ [HOST_HEADER]: 'top' }));
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('SEND_FAILED');
    startSession.mockRejectedValueOnce(new Error('secret key 0xdeadbeef leaked'));
    const boom = await POST(post({ [HOST_HEADER]: 'top' }));
    expect(boom.status).toBe(500);
    expect(JSON.stringify(await boom.json())).not.toContain('deadbeef');
  });
});
