import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseEther, type Hash } from 'viem';
import { DEFAULT_MAX_PER_MINUTE_GLOBAL, DEFAULT_MAX_PER_MINUTE_PER_IP, createDripService, DripError, DripRevertedError, dripLimitsFromEnv, type DripSender } from './service';

const TX = `0x${'cd'.repeat(32)}` as Hash;
const A1 = '0x1111111111111111111111111111111111111111';
const A2 = '0x2222222222222222222222222222222222222222';
const A3 = '0x3333333333333333333333333333333333333333';

function addr(i: number): `0x${string}` {
  return `0x${i.toString(16).padStart(40, '0')}`;
}

function sender(overrides: Partial<DripSender> = {}): DripSender & { send: ReturnType<typeof vi.fn> } {
  return { send: vi.fn(async () => TX), ...overrides } as DripSender & { send: ReturnType<typeof vi.fn> };
}

describe('createDripService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('funds a new address and assigns tracks round robin over 8', async () => {
    const s = sender();
    const drip = createDripService({ sender: s });
    const tracks: number[] = [];
    for (let i = 1; i <= 9; i++) {
      const r = await drip.drip({ address: addr(i), ip: `10.0.0.${i}` });
      expect(r.txHash).toBe(TX);
      expect(r.alreadyFunded).toBe(false);
      tracks.push(r.track);
    }
    expect(tracks).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 0]);
    expect(s.send).toHaveBeenCalledTimes(9);
    expect(s.send).toHaveBeenCalledWith(addr(1));
  });

  it('reports the reserve-pacing queue position and ETA when the sender has a backlog (W11)', async () => {
    const drip = createDripService({ sender: sender({ backlog: () => ({ ahead: 3, etaMs: 4_500 }) }) });
    const r = await drip.drip({ address: A1, ip: '1.1.1.1' });
    expect(r).toMatchObject({ txHash: TX, alreadyFunded: false, queuedAhead: 3, etaMs: 4_500 });
    const plain = await createDripService({ sender: sender() }).drip({ address: A2, ip: '1.1.1.1' });
    expect(plain).not.toHaveProperty('queuedAhead');
  });

  it('drips once per address ever and returns the same track afterwards', async () => {
    const s = sender();
    const drip = createDripService({ sender: s });
    const first = await drip.drip({ address: A1, ip: '1.1.1.1' });
    const again = await drip.drip({ address: A1.toUpperCase().replace('0X', '0x'), ip: '2.2.2.2' });
    expect(again).toEqual({ txHash: null, track: first.track, alreadyFunded: true });
    expect(s.send).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    expect((await drip.drip({ address: A1, ip: '1.1.1.1' })).alreadyFunded).toBe(true);
  });

  it('rejects the 21st drip from one IP within a minute and recovers after the window', async () => {
    const s = sender();
    const drip = createDripService({ sender: s, maxPerMinutePerIp: 20 });
    for (let i = 1; i <= 20; i++) await drip.drip({ address: addr(i), ip: '9.9.9.9' });
    const p = drip.drip({ address: addr(21), ip: '9.9.9.9' });
    await expect(p).rejects.toBeInstanceOf(DripError);
    await expect(p).rejects.toMatchObject({ code: 'RATE_LIMITED', status: 429 });
    const err = (await p.catch((e: unknown) => e)) as DripError;
    expect(err.retryAfterMs).toBeGreaterThan(0);
    expect(err.retryAfterMs).toBeLessThanOrEqual(60_000);
    // Other IPs are unaffected.
    await expect(drip.drip({ address: addr(22), ip: '8.8.8.8' })).resolves.toMatchObject({ alreadyFunded: false });
    vi.advanceTimersByTime(60_001);
    await expect(drip.drip({ address: addr(21), ip: '9.9.9.9' })).resolves.toMatchObject({ alreadyFunded: false });
    expect(s.send).toHaveBeenCalledTimes(22);
  });

  it('defaults to 60 per minute per IP and 300 per minute globally for a room behind carrier NAT (review C4)', async () => {
    expect(DEFAULT_MAX_PER_MINUTE_PER_IP).toBe(60);
    expect(DEFAULT_MAX_PER_MINUTE_GLOBAL).toBe(300);
    const drip = createDripService({ sender: sender() });
    for (let i = 1; i <= 60; i++) await drip.drip({ address: addr(i), ip: '9.9.9.9' });
    await expect(drip.drip({ address: addr(61), ip: '9.9.9.9' })).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    for (let i = 61; i <= 300; i++) await drip.drip({ address: addr(i), ip: `ip-${i % 7}` });
    await expect(drip.drip({ address: addr(301), ip: 'ip-new' })).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });

  it('does not burn a rate-limit slot when the send fails (review C4)', async () => {
    const s = sender({ send: vi.fn().mockRejectedValueOnce(new Error('nonce too low')).mockResolvedValue(TX) });
    const drip = createDripService({ sender: s, log: vi.fn(), maxPerMinutePerIp: 1, maxPerMinuteGlobal: 1 });
    await expect(drip.drip({ address: A1, ip: '1.1.1.1' })).rejects.toMatchObject({ code: 'DRIP_FAILED' });
    await expect(drip.drip({ address: A2, ip: '1.1.1.1' })).resolves.toMatchObject({ alreadyFunded: false });
    await expect(drip.drip({ address: A3, ip: '1.1.1.1' })).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });

  it('counts in-flight drips against the cap so a burst cannot overshoot it before any send finishes', async () => {
    const pending: Array<(h: Hash) => void> = [];
    const s = sender({ send: vi.fn(() => new Promise<Hash>((r) => pending.push(r))) });
    const drip = createDripService({ sender: s, maxPerMinutePerIp: 2, maxPerMinuteGlobal: 100 });
    const a = drip.drip({ address: A1, ip: '1.1.1.1' });
    const b = drip.drip({ address: A2, ip: '1.1.1.1' });
    await expect(drip.drip({ address: A3, ip: '1.1.1.1' })).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    pending.forEach((r) => r(TX));
    await Promise.all([a, b]);
    expect(s.send).toHaveBeenCalledTimes(2);
  });

  it('enforces a global drips-per-minute cap regardless of IP (defence against IP spoofing)', async () => {
    const s = sender();
    const drip = createDripService({ sender: s, maxPerMinutePerIp: 1000, maxPerMinuteGlobal: 3 });
    for (let i = 1; i <= 3; i++) await drip.drip({ address: addr(i), ip: `spoof-${i}` });
    await expect(drip.drip({ address: addr(4), ip: 'spoof-4' })).rejects.toMatchObject({ code: 'RATE_LIMITED', status: 429 });
    vi.advanceTimersByTime(60_001);
    await expect(drip.drip({ address: addr(4), ip: 'spoof-4' })).resolves.toMatchObject({ alreadyFunded: false });
    expect(s.send).toHaveBeenCalledTimes(4);
  });

  it('sheds idle IP buckets so the in-memory map does not grow without bound', async () => {
    const drip = createDripService({ sender: sender(), maxPerMinuteGlobal: 1_000_000 });
    for (let i = 1; i <= 500; i++) await drip.drip({ address: addr(i), ip: `ip-${i}` });
    expect(drip.stats().ipBuckets).toBe(500);
    vi.advanceTimersByTime(60_001);
    await drip.drip({ address: addr(501), ip: 'ip-501' });
    expect(drip.stats().ipBuckets).toBe(1);
  });

  it('caps the number of remembered addresses', async () => {
    const drip = createDripService({ sender: sender(), maxRememberedAddresses: 3, maxPerMinutePerIp: 100, maxPerMinuteGlobal: 100 });
    for (let i = 1; i <= 4; i++) await drip.drip({ address: addr(i), ip: '1.1.1.1' });
    expect(drip.stats().fundedAddresses).toBe(3);
    // The oldest was evicted; the newest are still remembered.
    expect((await drip.drip({ address: addr(4), ip: '1.1.1.1' })).alreadyFunded).toBe(true);
  });

  it('does not count an already-funded lookup against the IP budget', async () => {
    const drip = createDripService({ sender: sender(), maxPerMinutePerIp: 1 });
    await drip.drip({ address: A1, ip: '1.1.1.1' });
    await expect(drip.drip({ address: A1, ip: '1.1.1.1' })).resolves.toMatchObject({ alreadyFunded: true });
    await expect(drip.drip({ address: A2, ip: '1.1.1.1' })).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });

  it('reads the caps from env with sane defaults and rejects garbage (review C4)', () => {
    expect(dripLimitsFromEnv({})).toEqual({ maxPerMinutePerIp: 60, maxPerMinuteGlobal: 300, maxPlayersPerSession: 20 });
    expect(dripLimitsFromEnv({ DRIP_MAX_PER_MINUTE_PER_IP: '80', DRIP_MAX_PER_MINUTE_GLOBAL: ' 500 ' })).toEqual({ maxPerMinutePerIp: 80, maxPerMinuteGlobal: 500, maxPlayersPerSession: 20 });
    expect(() => dripLimitsFromEnv({ DRIP_MAX_PER_MINUTE_PER_IP: 'lots' })).toThrow(/DRIP_MAX_PER_MINUTE_PER_IP/);
    expect(() => dripLimitsFromEnv({ DRIP_MAX_PER_MINUTE_GLOBAL: '0' })).toThrow(/DRIP_MAX_PER_MINUTE_GLOBAL/);
  });

  it('rejects invalid addresses before touching the sender', async () => {
    const s = sender();
    const drip = createDripService({ sender: s });
    await expect(drip.drip({ address: 'nope', ip: '1.1.1.1' })).rejects.toMatchObject({ code: 'INVALID_ADDRESS', status: 400 });
    await expect(drip.drip({ address: '0x123', ip: '1.1.1.1' })).rejects.toMatchObject({ code: 'INVALID_ADDRESS' });
    expect(s.send).not.toHaveBeenCalled();
  });

  it('returns a null txHash in mock mode without calling the sender', async () => {
    const s = sender();
    const drip = createDripService({ sender: s, mock: true });
    const r = await drip.drip({ address: A1, ip: '1.1.1.1' });
    expect(r).toEqual({ txHash: null, track: 0, alreadyFunded: false });
    expect((await drip.drip({ address: A1, ip: '1.1.1.1' })).alreadyFunded).toBe(true);
    expect(s.send).not.toHaveBeenCalled();
  });

  it('fails with DRIP_NOT_CONFIGURED when there is no sender outside mock mode', async () => {
    const drip = createDripService({ sender: null });
    await expect(drip.drip({ address: A1, ip: '1.1.1.1' })).rejects.toMatchObject({ code: 'DRIP_NOT_CONFIGURED', status: 503 });
  });

  it('surfaces send failures as DRIP_FAILED, logs them without the key, and lets the address retry', async () => {
    const boom = new Error('insufficient funds for gas * price + value');
    const s = sender({
      send: vi.fn().mockRejectedValueOnce(boom).mockResolvedValueOnce(TX),
    });
    const log = vi.fn();
    const drip = createDripService({ sender: s, log });
    const p = drip.drip({ address: A1, ip: '1.1.1.1' });
    await expect(p).rejects.toMatchObject({ code: 'DRIP_FAILED', status: 502, cause: boom });
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]?.[0])).toContain('insufficient funds');
    await expect(drip.drip({ address: A1, ip: '1.1.1.1' })).resolves.toMatchObject({ txHash: TX, alreadyFunded: false });
  });

  it('confirms the transfer off the request path and forgets the address when it never lands (review C3)', async () => {
    let rejectConfirm: (e: Error) => void = () => undefined;
    const confirm = vi.fn(() => new Promise<void>((_, reject) => (rejectConfirm = reject)));
    const s = sender({ confirm });
    const log = vi.fn();
    const drip = createDripService({ sender: s, log });
    const first = await drip.drip({ address: A1, ip: '1.1.1.1' });
    expect(first).toMatchObject({ txHash: TX, alreadyFunded: false });
    expect(confirm).toHaveBeenCalledWith(TX);
    expect((await drip.drip({ address: A1, ip: '1.1.1.1' })).alreadyFunded).toBe(true);
    rejectConfirm(new DripRevertedError(TX));
    await vi.advanceTimersByTimeAsync(0);
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]?.[0])).toContain('reverted');
    // The phone may ask again and gets a fresh transfer instead of a stale "already funded".
    await expect(drip.drip({ address: A1, ip: '1.1.1.1' })).resolves.toMatchObject({ txHash: TX, alreadyFunded: false });
    expect(s.send).toHaveBeenCalledTimes(2);
  });

  it('keeps the address funded when the receipt only timed out: the transfer may still land (security review)', async () => {
    const confirm = vi.fn(async () => {
      throw new Error('Timed out while waiting for transaction receipt');
    });
    const log = vi.fn();
    const s = sender({ confirm });
    const drip = createDripService({ sender: s, log });
    await drip.drip({ address: A1, ip: '1.1.1.1' });
    await vi.advanceTimersByTimeAsync(0);
    expect(String(log.mock.calls[0]?.[0])).toMatch(/not confirmed.*kept as funded/);
    expect((await drip.drip({ address: A1, ip: '1.1.1.1' })).alreadyFunded).toBe(true);
    expect(s.send).toHaveBeenCalledTimes(1);
  });

  it('keeps the address funded once the transfer is confirmed', async () => {
    const confirm = vi.fn(async () => undefined);
    const drip = createDripService({ sender: sender({ confirm }), log: vi.fn() });
    await drip.drip({ address: A1, ip: '1.1.1.1' });
    await vi.advanceTimersByTimeAsync(0);
    expect((await drip.drip({ address: A1, ip: '1.1.1.1' })).alreadyFunded).toBe(true);
    expect(drip.stats().fundedAddresses).toBe(1);
  });

  it('serialises concurrent drips for the same address into one send', async () => {
    const s = sender();
    const drip = createDripService({ sender: s });
    const [a, b] = await Promise.all([drip.drip({ address: A3, ip: '1.1.1.1' }), drip.drip({ address: A3, ip: '1.1.1.1' })]);
    expect(s.send).toHaveBeenCalledTimes(1);
    expect([a.alreadyFunded, b.alreadyFunded].sort()).toEqual([false, true]);
    expect(a.track).toBe(b.track);
  });
});

describe('createDripService top-ups (W12)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const LOW = parseEther('0.0042');

  function service(balance: bigint | (() => Promise<bigint>) = LOW, extra: Partial<Parameters<typeof createDripService>[0]> = {}) {
    const s = sender();
    const balanceOf = vi.fn(typeof balance === 'function' ? balance : async () => balance);
    return { s, balanceOf, drip: createDripService({ sender: s, balanceOf, ...extra }) };
  }

  it('tops up a funded address whose balance is below 0.03 MON, keeping its track', async () => {
    const { s, balanceOf, drip } = service();
    const first = await drip.drip({ address: A1, ip: '1.1.1.1' });
    const top = await drip.drip({ address: A1, ip: '1.1.1.1', topUp: true });
    expect(top).toMatchObject({ txHash: TX, track: first.track, alreadyFunded: false, topUp: true, topUpsLeft: 1 });
    expect(balanceOf).toHaveBeenCalledWith('0x1111111111111111111111111111111111111111');
    expect(s.send).toHaveBeenCalledTimes(2);
  });

  it('refuses an address the drip never funded', async () => {
    const { s, drip } = service();
    await expect(drip.drip({ address: A1, ip: '1.1.1.1', topUp: true })).rejects.toMatchObject({ code: 'NOT_FUNDED_YET', status: 409 });
    expect(s.send).not.toHaveBeenCalled();
  });

  it('refuses while the balance is 0.03 MON or more, without burning a rate slot', async () => {
    const { s, drip } = service(parseEther('0.03'), { maxPerMinutePerIp: 2 });
    await drip.drip({ address: A1, ip: '1.1.1.1' });
    await expect(drip.drip({ address: A1, ip: '1.1.1.1', topUp: true })).rejects.toMatchObject({ code: 'BALANCE_NOT_LOW', status: 409 });
    expect(s.send).toHaveBeenCalledTimes(1);
    await expect(drip.drip({ address: A2, ip: '1.1.1.1' })).resolves.toMatchObject({ alreadyFunded: false });
  });

  it('allows at most two top-ups per address per server lifetime', async () => {
    const { s, drip } = service();
    await drip.drip({ address: A1, ip: '1.1.1.1' });
    await expect(drip.drip({ address: A1, ip: '1.1.1.1', topUp: true })).resolves.toMatchObject({ topUpsLeft: 1 });
    await expect(drip.drip({ address: A1, ip: '1.1.1.1', topUp: true })).resolves.toMatchObject({ topUpsLeft: 0 });
    await expect(drip.drip({ address: A1, ip: '1.1.1.1', topUp: true })).rejects.toMatchObject({ code: 'TOPUP_LIMIT_REACHED', status: 409 });
    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    await expect(drip.drip({ address: A1, ip: '1.1.1.1', topUp: true })).rejects.toMatchObject({ code: 'TOPUP_LIMIT_REACHED' });
    expect(s.send).toHaveBeenCalledTimes(3);
  });

  it('counts top-ups against the same per-IP and global caps as first drips', async () => {
    const { drip } = service(LOW, { maxPerMinutePerIp: 2, maxPerMinuteGlobal: 100 });
    await drip.drip({ address: A1, ip: '1.1.1.1' });
    await drip.drip({ address: A1, ip: '1.1.1.1', topUp: true });
    await expect(drip.drip({ address: A2, ip: '1.1.1.1' })).rejects.toMatchObject({ code: 'RATE_LIMITED', status: 429 });
    const g = service(LOW, { maxPerMinutePerIp: 100, maxPerMinuteGlobal: 1 });
    await g.drip.drip({ address: A1, ip: '1.1.1.1' });
    await expect(g.drip.drip({ address: A1, ip: '2.2.2.2', topUp: true })).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });

  it('reports the pacing queue for a top-up like a first drip', async () => {
    const s = sender({ backlog: () => ({ ahead: 2, etaMs: 3_000 }) });
    const drip = createDripService({ sender: s, balanceOf: async () => LOW });
    await drip.drip({ address: A1, ip: '1.1.1.1' });
    await expect(drip.drip({ address: A1, ip: '1.1.1.1', topUp: true })).resolves.toMatchObject({ queuedAhead: 2, etaMs: 3_000 });
  });

  it('does not use up a top-up when the send fails, and says so as DRIP_FAILED', async () => {
    const s = sender({ send: vi.fn().mockResolvedValueOnce(TX).mockRejectedValueOnce(new Error('nonce too low')).mockResolvedValue(TX) });
    const drip = createDripService({ sender: s, balanceOf: async () => LOW, log: vi.fn() });
    await drip.drip({ address: A1, ip: '1.1.1.1' });
    await expect(drip.drip({ address: A1, ip: '1.1.1.1', topUp: true })).rejects.toMatchObject({ code: 'DRIP_FAILED' });
    await expect(drip.drip({ address: A1, ip: '1.1.1.1', topUp: true })).resolves.toMatchObject({ topUpsLeft: 1 });
  });

  it('gives the top-up back when its transfer is never confirmed', async () => {
    let rejectConfirm: (e: Error) => void = () => undefined;
    const confirm = vi.fn(async (): Promise<void> => undefined).mockResolvedValueOnce(undefined).mockImplementationOnce(() => new Promise<void>((_, reject) => (rejectConfirm = reject)));
    const log = vi.fn();
    const drip = createDripService({ sender: sender({ confirm }), balanceOf: async () => LOW, log });
    await drip.drip({ address: A1, ip: '1.1.1.1' });
    await vi.advanceTimersByTimeAsync(0);
    await expect(drip.drip({ address: A1, ip: '1.1.1.1', topUp: true })).resolves.toMatchObject({ topUpsLeft: 1 });
    rejectConfirm(new DripRevertedError(TX));
    await vi.advanceTimersByTimeAsync(0);
    expect(String(log.mock.calls.at(-1)?.[0])).toContain('top-up');
    // The first drip stays funded; the failed top-up does not count.
    expect((await drip.drip({ address: A1, ip: '1.1.1.1' })).alreadyFunded).toBe(true);
    await expect(drip.drip({ address: A1, ip: '1.1.1.1', topUp: true })).resolves.toMatchObject({ topUpsLeft: 1 });
  });

  it('never gives a top-up back on a receipt timeout, so a slow RPC cannot lift the cap of two (security review)', async () => {
    const confirm = vi.fn(async (): Promise<void> => {
      throw new Error('Timed out while waiting for transaction receipt');
    });
    const log = vi.fn();
    const s = sender({ confirm });
    const drip = createDripService({ sender: s, balanceOf: async () => LOW, log });
    await drip.drip({ address: A1, ip: '1.1.1.1' });
    await drip.drip({ address: A1, ip: '1.1.1.1', topUp: true });
    await drip.drip({ address: A1, ip: '1.1.1.1', topUp: true });
    await vi.advanceTimersByTimeAsync(0);
    await expect(drip.drip({ address: A1, ip: '1.1.1.1', topUp: true })).rejects.toMatchObject({ code: 'TOPUP_LIMIT_REACHED' });
    expect(s.send).toHaveBeenCalledTimes(3);
    expect(log.mock.calls.some((c) => /counted/.test(String(c[0])))).toBe(true);
  });

  it('serialises concurrent top-ups for one address into one transfer', async () => {
    const { s, drip } = service();
    await drip.drip({ address: A1, ip: '1.1.1.1' });
    const [a, b] = await Promise.all([drip.drip({ address: A1, ip: '1.1.1.1', topUp: true }), drip.drip({ address: A1, ip: '1.1.1.1', topUp: true })]);
    expect(s.send).toHaveBeenCalledTimes(2);
    expect(a).toEqual(b);
  });

  it('answers BALANCE_UNAVAILABLE when the balance cannot be read, and logs why', async () => {
    const log = vi.fn();
    const { s, drip } = service(async () => {
      throw new Error('429 from rpc');
    }, { log });
    await drip.drip({ address: A1, ip: '1.1.1.1' });
    await expect(drip.drip({ address: A1, ip: '1.1.1.1', topUp: true })).rejects.toMatchObject({ code: 'BALANCE_UNAVAILABLE', status: 503 });
    expect(String(log.mock.calls.at(-1)?.[0])).toContain('429 from rpc');
    expect(s.send).toHaveBeenCalledTimes(1);
  });

  it('skips the balance check in mock mode (the simulator balance lives on the phone)', async () => {
    const drip = createDripService({ sender: null, mock: true });
    await drip.drip({ address: A1, ip: '1.1.1.1' });
    await expect(drip.drip({ address: A1, ip: '1.1.1.1', topUp: true })).resolves.toMatchObject({ txHash: null, topUp: true, topUpsLeft: 1 });
  });

  it('refuses a top-up outside mock mode when no balance source is configured', async () => {
    const drip = createDripService({ sender: sender() });
    await drip.drip({ address: A1, ip: '1.1.1.1' });
    await expect(drip.drip({ address: A1, ip: '1.1.1.1', topUp: true })).rejects.toMatchObject({ code: 'BALANCE_UNAVAILABLE' });
  });
});
