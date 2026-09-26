import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Hash } from 'viem';
import { DripError, type DripService } from '@/lib/drip/service';
import { TipperDripError, type TipperDripService } from '@/lib/drip/tipper';

const TX = `0x${'cd'.repeat(32)}` as Hash;
const A1 = '0x1111111111111111111111111111111111111111';

const dripFn = vi.fn<DripService['drip']>();
const tipperFn = vi.fn<TipperDripService['drip']>();
vi.mock('@/lib/drip/runtime', () => ({
  getDripService: (): DripService => ({ drip: dripFn, stats: () => ({ fundedAddresses: 0, ipBuckets: 0 }) }),
  getTipperDripService: (): TipperDripService => ({ drip: tipperFn, stats: () => ({ funded: 0, remaining: 0 }) }),
}));

const { POST } = await import('./route');

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/drip', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('POST /api/drip', () => {
  beforeEach(() => {
    dripFn.mockReset();
    tipperFn.mockReset();
  });

  it('returns 400 on malformed JSON', async () => {
    const res = await POST(post('{not json'));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('INVALID_JSON');
    expect(dripFn).not.toHaveBeenCalled();
  });

  it('returns 400 when address is missing or not a string', async () => {
    expect((await POST(post({}))).status).toBe(400);
    expect((await POST(post({ address: 42 }))).status).toBe(400);
    expect(dripFn).not.toHaveBeenCalled();
  });

  it('returns 400 when the service rejects the address', async () => {
    dripFn.mockRejectedValueOnce(new DripError('INVALID_ADDRESS', 'bad address'));
    const res = await POST(post({ address: '0x1' }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('INVALID_ADDRESS');
  });

  it('rate-limits by cf-connecting-ip and ignores the client-controlled x-real-ip (review H5)', async () => {
    dripFn.mockResolvedValueOnce({ txHash: TX, track: 3, alreadyFunded: false });
    const res = await POST(post({ address: A1 }, { 'x-forwarded-for': 'spoofed, 203.0.113.5', 'x-real-ip': '1.2.3.4', 'cf-connecting-ip': '198.51.100.7' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ txHash: TX, track: 3, alreadyFunded: false });
    expect(dripFn).toHaveBeenCalledWith({ address: A1, ip: '198.51.100.7' });
    dripFn.mockResolvedValueOnce({ txHash: TX, track: 3, alreadyFunded: false });
    await POST(post({ address: A1 }, { 'x-real-ip': '1.2.3.4' }));
    expect(dripFn).toHaveBeenLastCalledWith({ address: A1, ip: 'unknown' });
  });

  it('uses the right-most x-forwarded-for hop (appended by the nearest proxy), never the first', async () => {
    dripFn.mockResolvedValue({ txHash: null, track: 0, alreadyFunded: true });
    await POST(post({ address: A1 }, { 'x-forwarded-for': 'spoofed, 203.0.113.5' }));
    expect(dripFn).toHaveBeenLastCalledWith({ address: A1, ip: '203.0.113.5' });
    await POST(post({ address: A1 }));
    expect(dripFn).toHaveBeenLastCalledWith({ address: A1, ip: 'unknown' });
  });

  it('rejects oversized bodies and over-long address strings before parsing them as addresses', async () => {
    const big = await POST(post({ address: 'x'.repeat(5000) }));
    expect(big.status).toBe(413);
    const long = await POST(post({ address: `0x${'1'.repeat(100)}` }));
    expect(long.status).toBe(400);
    expect(dripFn).not.toHaveBeenCalled();
  });

  it('returns 429 with Retry-After when rate limited', async () => {
    dripFn.mockRejectedValueOnce(new DripError('RATE_LIMITED', 'slow down', { retryAfterMs: 12_000 }));
    const res = await POST(post({ address: A1 }));
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('12');
  });

  it('returns 502 with a generic message when the send fails', async () => {
    dripFn.mockRejectedValueOnce(new DripError('DRIP_FAILED', 'drip transaction failed', { cause: new Error('secret rpc detail') }));
    const res = await POST(post({ address: A1 }));
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).not.toContain('secret rpc detail');
    expect(text).toContain('DRIP_FAILED');
  });

  it('returns 500 with no internals for unexpected errors', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    dripFn.mockRejectedValueOnce(new TypeError('cannot read properties of undefined'));
    const res = await POST(post({ address: A1 }));
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain('cannot read');
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
  it('passes { topUp: true } through and answers the top-up result (W12)', async () => {
    dripFn.mockResolvedValueOnce({ txHash: TX, track: 3, alreadyFunded: false, topUp: true, topUpsLeft: 1 });
    const res = await POST(post({ address: A1, topUp: true }, { 'cf-connecting-ip': '198.51.100.7' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ txHash: TX, track: 3, alreadyFunded: false, topUp: true, topUpsLeft: 1 });
    expect(dripFn).toHaveBeenCalledWith({ address: A1, ip: '198.51.100.7', topUp: true });
  });

  it('keeps a plain drip a plain drip and rejects a non-boolean topUp (W12)', async () => {
    dripFn.mockResolvedValue({ txHash: TX, track: 3, alreadyFunded: false });
    await POST(post({ address: A1, topUp: false }));
    expect(dripFn).toHaveBeenLastCalledWith({ address: A1, ip: 'unknown' });
    const bad = await POST(post({ address: A1, topUp: 'yes' }));
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe('INVALID_TOPUP');
    expect(dripFn).toHaveBeenCalledTimes(1);
  });

  it('maps top-up refusals to 409 and a balance read failure to 503 (W12)', async () => {
    for (const code of ['NOT_FUNDED_YET', 'BALANCE_NOT_LOW', 'TOPUP_LIMIT_REACHED'] as const) {
      dripFn.mockRejectedValueOnce(new DripError(code, `refused: ${code}`));
      const res = await POST(post({ address: A1, topUp: true }));
      expect(res.status, code).toBe(409);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(code);
    }
    dripFn.mockRejectedValueOnce(new DripError('BALANCE_UNAVAILABLE', 'could not read the wallet balance; try again', { cause: new Error('secret rpc url') }));
    const res = await POST(post({ address: A1, topUp: true }));
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain('secret rpc url');
  });

  it('W19: passes the session id on for the room cap, validates it, and maps ROOM_FULL to 409', async () => {
    dripFn.mockResolvedValue({ txHash: TX, track: 1, alreadyFunded: false });
    await POST(post({ address: A1, sessionId: '12' }));
    expect(dripFn).toHaveBeenLastCalledWith(expect.objectContaining({ address: A1, sessionId: '12' }));
    await POST(post({ address: A1, sessionId: 13 }));
    expect(dripFn).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: '13' }));
    await POST(post({ address: A1 }));
    expect(dripFn.mock.lastCall?.[0]).not.toHaveProperty('sessionId');
    for (const sessionId of [0, -1, 'abc', '1e3', 1.5, true, 'x'.repeat(100)]) {
      const res = await POST(post({ address: A1, sessionId }));
      expect(res.status, JSON.stringify(sessionId)).toBe(400);
    }
    dripFn.mockRejectedValueOnce(new DripError('ROOM_FULL', 'the room is full: 20 players are already funded in this session'));
    const full = await POST(post({ address: A1, sessionId: '12' }));
    expect(full.status).toBe(409);
    expect(((await full.json()) as { error: { code: string } }).error.code).toBe('ROOM_FULL');
  });
});

describe('POST /api/drip mode "tipper" (W21b)', () => {
  beforeEach(() => {
    dripFn.mockReset();
    tipperFn.mockReset();
  });

  it('funds a tipper wallet through the tipper service, never the player drip', async () => {
    tipperFn.mockResolvedValueOnce({ txHash: TX, alreadyFunded: false, amountWei: '100000000000000000' });
    const res = await POST(post({ address: A1, mode: 'tipper', sessionId: '7' }, { 'cf-connecting-ip': '198.51.100.7' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ txHash: TX, alreadyFunded: false, amountWei: '100000000000000000' });
    expect(tipperFn).toHaveBeenCalledWith({ address: A1, ip: '198.51.100.7', sessionId: 7n });
    expect(dripFn).not.toHaveBeenCalled();
  });

  it('refuses an unknown mode and a tipper top-up', async () => {
    const bad = await POST(post({ address: A1, mode: 'faucet' }));
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe('INVALID_MODE');
    expect((await POST(post({ address: A1, mode: 'tipper', topUp: true, sessionId: '7' }))).status).toBe(400);
    const noSession = await POST(post({ address: A1, mode: 'tipper' }));
    expect(noSession.status).toBe(400);
    expect(((await noSession.json()) as { error: { code: string } }).error.code).toBe('INVALID_SESSION');
    expect(tipperFn).not.toHaveBeenCalled();
  });

  it('maps tipper errors with Retry-After', async () => {
    tipperFn.mockRejectedValueOnce(new TipperDripError('RATE_LIMITED', 'too many', { retryAfterMs: 2_500 }));
    const res = await POST(post({ address: A1, mode: 'tipper', sessionId: 7 }));
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('3');
    tipperFn.mockRejectedValueOnce(new TipperDripError('TIPPERS_EXHAUSTED', 'no more'));
    expect((await POST(post({ address: A1, mode: 'tipper', sessionId: 7 }))).status).toBe(503);
  });
});
