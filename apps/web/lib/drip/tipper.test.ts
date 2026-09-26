import { describe, expect, it, vi } from 'vitest';
import { parseEther, type Address, type Hash } from 'viem';
import { TIPPER_DRIP_MON } from '../tips/constants';
import { DripRevertedError, type DripSender } from './service';
import { MAX_TIPPER_DRIP_WEI, TipperDripError, createTipperDripService, tipperAmountFromEnv, tipperLimitsFromEnv } from './tipper';

const TX = `0x${'cd'.repeat(32)}` as Hash;
const A1 = '0x1111111111111111111111111111111111111111' as Address;
const A2 = '0x2222222222222222222222222222222222222222' as Address;
const addr = (i: number): Address => `0x${(i + 1).toString(16).padStart(40, '0')}` as Address;
const AMOUNT = parseEther('0.1');

function sender(overrides: Partial<DripSender> = {}): DripSender & { send: ReturnType<typeof vi.fn> } {
  return { send: vi.fn(async () => TX), ...overrides } as DripSender & { send: ReturnType<typeof vi.fn> };
}

const limits = { maxPerMinutePerIp: 10, maxPerMinuteGlobal: 100, maxTotal: 50, maxPerSession: 50, maxPerIpPerSession: 50 };

describe('createTipperDripService (W21b: the tip page burner)', () => {
  it('sends the tipper amount once per address through the shared drip sender', async () => {
    const s = sender();
    const service = createTipperDripService({ sender: s, mock: false, amountWei: AMOUNT, limits, log: () => undefined });
    expect(await service.drip({ address: A1.toLowerCase(), ip: 'ip', sessionId: 7n })).toEqual({ txHash: TX, alreadyFunded: false, amountWei: AMOUNT.toString() });
    expect(s.send).toHaveBeenCalledWith(A1, AMOUNT);
    expect(await service.drip({ address: A1, ip: 'ip', sessionId: 7n })).toEqual({ txHash: null, alreadyFunded: true, amountWei: AMOUNT.toString() });
    expect(s.send).toHaveBeenCalledTimes(1);
  });

  it('joins a concurrent request for the same address instead of paying twice', async () => {
    const s = sender();
    const service = createTipperDripService({ sender: s, mock: false, amountWei: AMOUNT, limits, log: () => undefined });
    const [a, b] = await Promise.all([service.drip({ address: A1, ip: 'ip', sessionId: 7n }), service.drip({ address: A1, ip: 'ip', sessionId: 7n })]);
    expect([a.alreadyFunded, b.alreadyFunded].sort()).toEqual([false, true]);
    expect(s.send).toHaveBeenCalledTimes(1);
  });

  it('refuses a malformed address', async () => {
    const service = createTipperDripService({ sender: sender(), mock: false, amountWei: AMOUNT, limits, log: () => undefined });
    await expect(service.drip({ address: '0x123', ip: 'ip', sessionId: 7n })).rejects.toMatchObject({ code: 'INVALID_ADDRESS', status: 400 });
  });

  it('counts separately from the player drip: its own per-IP limit', async () => {
    const service = createTipperDripService({ sender: sender(), mock: false, amountWei: AMOUNT, limits: { ...limits, maxPerMinutePerIp: 2 }, log: () => undefined });
    await service.drip({ address: addr(1), ip: 'nat', sessionId: 7n });
    await service.drip({ address: addr(2), ip: 'nat', sessionId: 7n });
    const refused = service.drip({ address: addr(3), ip: 'nat', sessionId: 7n });
    await expect(refused).rejects.toBeInstanceOf(TipperDripError);
    await expect(refused).rejects.toMatchObject({ code: 'RATE_LIMITED', status: 429 });
    await expect(service.drip({ address: addr(3), ip: 'other', sessionId: 7n })).resolves.toMatchObject({ alreadyFunded: false });
  });

  it('stops for good at the lifetime cap, so a spoofed-IP flood drains at most maxTotal × amount', async () => {
    const s = sender();
    const service = createTipperDripService({ sender: s, mock: false, amountWei: AMOUNT, limits: { ...limits, maxTotal: 3 }, log: () => undefined });
    for (let i = 0; i < 3; i++) await service.drip({ address: addr(i), ip: `ip-${i}`, sessionId: 7n });
    await expect(service.drip({ address: addr(9), ip: 'fresh', sessionId: 7n })).rejects.toMatchObject({ code: 'TIPPERS_EXHAUSTED', status: 503 });
    expect(s.send).toHaveBeenCalledTimes(3);
    expect(service.stats()).toEqual({ funded: 3, remaining: 0 });
  });

  it('security review: one actor can use up one session\'s tipper wallets at most, never the event\'s', async () => {
    const service = createTipperDripService({ sender: sender(), mock: false, amountWei: AMOUNT, limits: { ...limits, maxPerSession: 3, maxPerIpPerSession: 2 }, log: () => undefined });
    await service.drip({ address: addr(1), ip: 'evil', sessionId: 7n });
    await service.drip({ address: addr(2), ip: 'evil', sessionId: 7n });
    await expect(service.drip({ address: addr(3), ip: 'evil', sessionId: 7n })).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    await service.drip({ address: addr(4), ip: 'friend', sessionId: 7n });
    await expect(service.drip({ address: addr(5), ip: 'friend2', sessionId: 7n })).rejects.toMatchObject({ code: 'TIPPERS_EXHAUSTED' });
    // The next show starts with a fresh budget.
    await expect(service.drip({ address: addr(6), ip: 'friend2', sessionId: 8n })).resolves.toMatchObject({ alreadyFunded: false });
  });

  it('gives the session slot back when the send fails or the transfer reverts', async () => {
    let fail: (e: Error) => void = () => undefined;
    const s = sender({ send: vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue(TX), confirm: vi.fn(() => new Promise<void>((_, reject) => (fail = reject))) });
    const service = createTipperDripService({ sender: s, mock: false, amountWei: AMOUNT, limits: { ...limits, maxPerSession: 1 }, log: () => undefined });
    await expect(service.drip({ address: addr(1), ip: 'a', sessionId: 7n })).rejects.toMatchObject({ code: 'DRIP_FAILED' });
    await service.drip({ address: addr(1), ip: 'a', sessionId: 7n });
    fail(new DripRevertedError(TX));
    await new Promise((r) => setTimeout(r, 0));
    await expect(service.drip({ address: addr(2), ip: 'b', sessionId: 7n })).resolves.toMatchObject({ alreadyFunded: false });
  });

  it('refuses a missing session', async () => {
    const service = createTipperDripService({ sender: sender(), mock: false, amountWei: AMOUNT, limits, log: () => undefined });
    await expect(service.drip({ address: A1, ip: 'ip', sessionId: 0n })).rejects.toMatchObject({ code: 'INVALID_SESSION' });
  });

  it('counts in-flight drips against the lifetime cap', async () => {
    let release: (h: Hash) => void = () => undefined;
    const s = sender({ send: vi.fn(() => new Promise<Hash>((r) => (release = r))) });
    const service = createTipperDripService({ sender: s, mock: false, amountWei: AMOUNT, limits: { ...limits, maxTotal: 1 }, log: () => undefined });
    const first = service.drip({ address: A1, ip: 'a', sessionId: 7n });
    await expect(service.drip({ address: A2, ip: 'b', sessionId: 7n })).rejects.toMatchObject({ code: 'TIPPERS_EXHAUSTED' });
    release(TX);
    await expect(first).resolves.toMatchObject({ txHash: TX });
  });

  it('gives a slot back when the send fails, and reports DRIP_FAILED without detail', async () => {
    const log = vi.fn();
    const s = sender({ send: vi.fn().mockRejectedValueOnce(new Error('rpc https://x/key')).mockResolvedValue(TX) });
    const service = createTipperDripService({ sender: s, mock: false, amountWei: AMOUNT, limits: { ...limits, maxTotal: 1 }, log });
    const failure = service.drip({ address: A1, ip: 'ip', sessionId: 7n });
    await expect(failure).rejects.toMatchObject({ code: 'DRIP_FAILED', status: 502, message: expect.not.stringContaining('key') });
    expect(log).toHaveBeenCalled();
    await expect(service.drip({ address: A1, ip: 'ip', sessionId: 7n })).resolves.toMatchObject({ txHash: TX });
  });

  it('forgets an address whose transfer reverted (no MON moved), so it may ask again', async () => {
    let fail: (e: Error) => void = () => undefined;
    const s = sender({ confirm: vi.fn(() => new Promise<void>((_, reject) => (fail = reject))) });
    const service = createTipperDripService({ sender: s, mock: false, amountWei: AMOUNT, limits, log: () => undefined });
    await service.drip({ address: A1, ip: 'ip', sessionId: 7n });
    fail(new DripRevertedError(TX));
    await new Promise((r) => setTimeout(r, 0));
    expect(await service.drip({ address: A1, ip: 'ip', sessionId: 7n })).toMatchObject({ alreadyFunded: false });
    expect(s.send).toHaveBeenCalledTimes(2);
  });

  it('keeps an unconfirmed (timed out) transfer as funded: it may still land', async () => {
    let fail: (e: Error) => void = () => undefined;
    const s = sender({ confirm: vi.fn(() => new Promise<void>((_, reject) => (fail = reject))) });
    const service = createTipperDripService({ sender: s, mock: false, amountWei: AMOUNT, limits, log: () => undefined });
    await service.drip({ address: A1, ip: 'ip', sessionId: 7n });
    fail(new Error('timeout'));
    await new Promise((r) => setTimeout(r, 0));
    expect(await service.drip({ address: A1, ip: 'ip', sessionId: 7n })).toMatchObject({ alreadyFunded: true });
  });

  it('reports the reserve-pacing queue like the player drip', async () => {
    const s = sender({ backlog: () => ({ ahead: 2, etaMs: 3_000 }) });
    const service = createTipperDripService({ sender: s, mock: false, amountWei: AMOUNT, limits, log: () => undefined });
    expect(await service.drip({ address: A1, ip: 'ip', sessionId: 7n })).toMatchObject({ queuedAhead: 2, etaMs: 3_000 });
  });

  it('sends nothing in mock mode and needs no key', async () => {
    const service = createTipperDripService({ sender: null, mock: true, amountWei: AMOUNT, limits, log: () => undefined });
    expect(await service.drip({ address: A1, ip: 'ip', sessionId: 7n })).toEqual({ txHash: null, alreadyFunded: false, amountWei: AMOUNT.toString() });
  });

  it('refuses outside mock mode without a drip key', async () => {
    const service = createTipperDripService({ sender: null, mock: false, amountWei: AMOUNT, limits, log: () => undefined });
    await expect(service.drip({ address: A1, ip: 'ip', sessionId: 7n })).rejects.toMatchObject({ code: 'DRIP_NOT_CONFIGURED', status: 503 });
  });
});

describe('tipper drip config from env', () => {
  it('defaults to TIPPER_DRIP_MON and the event caps', () => {
    expect(tipperAmountFromEnv({})).toBe(parseEther(TIPPER_DRIP_MON));
    expect(tipperLimitsFromEnv({})).toEqual({ maxPerMinutePerIp: 20, maxPerMinuteGlobal: 60, maxTotal: 150, maxPerSession: 50, maxPerIpPerSession: 25 });
  });

  it('reads overrides and refuses nonsense loudly', () => {
    expect(tipperAmountFromEnv({ TIP_DRIP_AMOUNT_MON: '0.12' })).toBe(parseEther('0.12'));
    expect(() => tipperAmountFromEnv({ TIP_DRIP_AMOUNT_MON: 'lots' })).toThrow(/TIP_DRIP_AMOUNT_MON/);
    expect(() => tipperAmountFromEnv({ TIP_DRIP_AMOUNT_MON: '0' })).toThrow(/TIP_DRIP_AMOUNT_MON/);
    expect(() => tipperAmountFromEnv({ TIP_DRIP_AMOUNT_MON: '5' })).toThrow(/at most/);
    expect(MAX_TIPPER_DRIP_WEI).toBe(parseEther('0.5'));
    expect(tipperLimitsFromEnv({ TIP_DRIP_MAX_TOTAL: '7', TIP_DRIP_MAX_PER_MINUTE_PER_IP: '3', TIP_DRIP_MAX_PER_MINUTE_GLOBAL: '9', TIP_DRIP_MAX_PER_SESSION: '5', TIP_DRIP_MAX_PER_IP_PER_SESSION: '2' })).toEqual({ maxPerMinutePerIp: 3, maxPerMinuteGlobal: 9, maxTotal: 7, maxPerSession: 5, maxPerIpPerSession: 2 });
    expect(() => tipperLimitsFromEnv({ TIP_DRIP_MAX_TOTAL: '-1' })).toThrow(/TIP_DRIP_MAX_TOTAL/);
  });
});
