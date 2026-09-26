import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Hash } from 'viem';
import { HostError, type HostService } from '@/lib/host/service';
import { HOST_HEADER } from '@/lib/host/auth';

const TX = `0x${'cd'.repeat(32)}` as Hash;
const startSession = vi.fn<HostService['startSession']>();
const finalize = vi.fn<HostService['finalize']>();
vi.mock('@/lib/host/runtime', () => ({ getHostService: (): HostService => ({ startSession, finalize, claimHost: vi.fn() }) }));
const stopForSession = vi.fn(async () => ({ running: false }));
vi.mock('@/lib/agent/runtime', () => ({ getAgentManager: () => ({ stopForSession }) }));
const stopCrowdForSession = vi.fn(async () => ({ running: false }));
vi.mock('@/lib/crowd/runtime', () => ({ getCrowdManager: () => ({ stopForSession: stopCrowdForSession }) }));

const { POST } = await import('./route');

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/session/finalize', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('POST /api/session/finalize', () => {
  beforeEach(() => {
    finalize.mockReset();
    vi.stubEnv('HOST_SECRET', 'top');
    vi.stubEnv('HOST_PRIVATE_KEY', '');
    vi.stubEnv('NEXT_PUBLIC_BLOCKBEAT_MOCK', '');
    vi.stubEnv('NEXT_PUBLIC_BLOCKBEAT_ADDRESS', '0x5FbDB2315678afecb367f032d93F642f64180aa3');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('rejects a wrong secret before parsing the body', async () => {
    expect((await POST(post('{garbage', { [HOST_HEADER]: 'nope' }))).status).toBe(401);
    expect(finalize).not.toHaveBeenCalled();
  });

  it('validates the session id', async () => {
    for (const body of ['{nope', {}, { sessionId: 0 }, { sessionId: '0' }, { sessionId: 'abc' }, { sessionId: '-1' }]) {
      const res = await POST(post(body, { [HOST_HEADER]: 'top' }));
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(finalize).not.toHaveBeenCalled();
  });

  it('rejects an oversized declared body with 413 before reading it', async () => {
    const res = await POST(post({ sessionId: '7' }, { [HOST_HEADER]: 'top', 'content-length': '5000' }));
    expect(res.status).toBe(413);
    expect(finalize).not.toHaveBeenCalled();
  });

  it('finalizes and returns tokenId, contributors and tx as strings', async () => {
    finalize.mockResolvedValueOnce({ sessionId: 7n, tokenId: 3n, contributors: 12n, txHash: TX });
    const res = await POST(post({ sessionId: '7' }, { [HOST_HEADER]: 'top' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sessionId: '7', tokenId: '3', contributors: '12', txHash: TX });
    expect(finalize).toHaveBeenCalledWith(7n);
  });

  it('stops the resident DJ of that session before finalizing (review H4, W12)', async () => {
    const order: string[] = [];
    stopForSession.mockImplementationOnce(async () => {
      order.push('stop');
      return { running: false };
    });
    finalize.mockImplementationOnce(async () => {
      order.push('finalize');
      return { sessionId: 7n, tokenId: 3n, contributors: 12n, txHash: TX };
    });
    await POST(post({ sessionId: '7' }, { [HOST_HEADER]: 'top' }));
    expect(stopForSession).toHaveBeenCalledWith(7n, 'session finalized');
    expect(order).toEqual(['stop', 'finalize']);
  });

  it('stops the simulated crowd of that session before finalizing (W19)', async () => {
    const order: string[] = [];
    stopCrowdForSession.mockImplementationOnce(async () => {
      order.push('crowd');
      return { running: false };
    });
    finalize.mockImplementationOnce(async () => {
      order.push('finalize');
      return { sessionId: 7n, tokenId: 3n, contributors: 12n, txHash: TX };
    });
    await POST(post({ sessionId: '7' }, { [HOST_HEADER]: 'top' }));
    expect(stopCrowdForSession).toHaveBeenCalledWith(7n, 'session finalized');
    expect(order).toEqual(['crowd', 'finalize']);
  });

  it('maps a reverted finalize to 409', async () => {
    finalize.mockRejectedValueOnce(new HostError('TX_REVERTED', 'finalize reverted'));
    const res = await POST(post({ sessionId: 7 }, { [HOST_HEADER]: 'top' }));
    expect(res.status).toBe(409);
  });
});
