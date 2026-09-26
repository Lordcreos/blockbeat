import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseEther } from 'viem';
import { BLOCK_MS, HIT_GAS_LIMIT, HIT_GAS_LIMIT_FIRST, HIT_MAX_PRIORITY_FEE_PER_GAS, MONAD_BASE_FEE_WEI, TIP_GAS_LIMIT, emptyPattern, isOn, stepForBlock, type HitEvent } from '@blockbeat/shared';
import { createSimulator } from './simulator';
import { revertErrorName } from '../revert';

/** Charged per unit of a hit's gas limit: base fee plus the fixed 2 gwei tip (W12). */
const HIT_PRICE = MONAD_BASE_FEE_WEI + HIT_MAX_PRIORITY_FEE_PER_GAS;
const PLAYER = '0x1111111111111111111111111111111111111111' as const;
const OTHER = '0x2222222222222222222222222222222222222222' as const;

describe('createSimulator', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('emits a head every block interval after start', () => {
    const sim = createSimulator({ startBlock: 100n });
    const heads: bigint[] = [];
    sim.headSource.subscribe((n) => heads.push(n), () => undefined);
    expect(sim.headSource.kind()).toBe('mock');
    sim.start();
    vi.advanceTimersByTime(BLOCK_MS * 3);
    expect(heads).toEqual([101n, 102n, 103n]);
    expect(sim.currentBlock()).toBe(103n);
    sim.stop();
    vi.advanceTimersByTime(BLOCK_MS * 3);
    expect(heads).toHaveLength(3);
  });

  it('start is idempotent and unsubscribe stops head delivery', () => {
    const sim = createSimulator({ startBlock: 100n });
    const heads: bigint[] = [];
    const off = sim.headSource.subscribe((n) => heads.push(n), () => undefined);
    sim.start();
    sim.start();
    vi.advanceTimersByTime(BLOCK_MS);
    off();
    vi.advanceTimersByTime(BLOCK_MS);
    expect(heads).toEqual([101n]);
    sim.stop();
  });

  it('auto-creates a session at the current block and returns an empty pattern', async () => {
    const sim = createSimulator({ startBlock: 100n });
    sim.start();
    vi.advanceTimersByTime(BLOCK_MS * 2);
    const session = await sim.eventSource.readSession(7n);
    expect(session).not.toBeNull();
    expect(session?.sessionId).toBe(7n);
    expect(session?.startBlock).toBe(102n);
    expect(session?.hitCount).toBe(0n);
    expect(await sim.eventSource.readPattern(7n)).toEqual(emptyPattern());
    // Second read returns the same session.
    expect((await sim.eventSource.readSession(7n))?.startBlock).toBe(102n);
    sim.stop();
  });

  it('W13: serves past Hit logs by block range and player, and its head', async () => {
    const sim = createSimulator({ startBlock: 100n });
    sim.start();
    await sim.eventSource.readSession(1n);
    const other = '0x3333333333333333333333333333333333333333' as const;
    await sim.hitWriterFor(PLAYER)({ sessionId: 1n, track: 2, note: 3 });
    vi.advanceTimersByTime(BLOCK_MS); // block 101
    await sim.hitWriterFor(other)({ sessionId: 1n, track: 4, note: 0 });
    vi.advanceTimersByTime(BLOCK_MS * 3); // block 104 (the second landed on 102)
    expect(await sim.eventSource.readHead?.()).toBe(104n);
    const all = await sim.eventSource.readHits?.({ sessionId: 1n, fromBlock: 100n, toBlock: 104n });
    expect(all?.hits.map((h) => h.blockNumber)).toEqual([101n, 102n]);
    expect(all?.decodeErrors).toBe(0);
    const mine = await sim.eventSource.readHits?.({ sessionId: 1n, fromBlock: 100n, toBlock: 104n, player: PLAYER });
    expect(mine?.hits.map((h) => h.player)).toEqual([PLAYER]);
    expect((await sim.eventSource.readHits?.({ sessionId: 1n, fromBlock: 102n, toBlock: 102n }))?.hits).toHaveLength(1);
    expect((await sim.eventSource.readHits?.({ sessionId: 2n, fromBlock: 0n, toBlock: 104n }))?.hits).toHaveLength(0);
    sim.stop();
  });

  it('echoes a hit as a Hit event one block later, on the step of that block', async () => {
    const sim = createSimulator({ startBlock: 100n });
    sim.start();
    const hits: HitEvent[] = [];
    sim.eventSource.watchHits({ sessionId: 1n, mode: 'ws', onHits: (h) => hits.push(...h), onError: () => undefined });
    await sim.eventSource.readSession(1n); // startBlock 100
    const write = sim.hitWriterFor(PLAYER);
    vi.advanceTimersByTime(BLOCK_MS * 5); // block 105
    const hash = await write({ sessionId: 1n, track: 2, note: 3 });
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(hits).toHaveLength(0);
    vi.advanceTimersByTime(BLOCK_MS); // block 106 lands the tx
    expect(hits).toHaveLength(1);
    const hit = hits[0];
    expect(hit?.txHash).toBe(hash);
    expect(hit?.blockNumber).toBe(106n);
    expect(hit?.step).toBe(stepForBlock(100n, 106n));
    expect(hit?.track).toBe(2);
    expect(hit?.note).toBe(3);
    expect(hit?.on).toBe(true);
    expect(hit?.player).toBe(PLAYER);
    expect(hit?.sessionId).toBe(1n);
    const pattern = await sim.eventSource.readPattern(1n);
    expect(isOn(pattern[6] ?? 0n, 2, 3)).toBe(true);
    expect((await sim.eventSource.readSession(1n))?.hitCount).toBe(1n);
    sim.stop();
  });

  it('toggles a note off when hit again on the same step', async () => {
    const sim = createSimulator({ startBlock: 100n });
    sim.start();
    const hits: HitEvent[] = [];
    sim.eventSource.watchHits({ sessionId: 1n, mode: 'poll', onHits: (h) => hits.push(...h), onError: () => undefined });
    const write = sim.hitWriterFor(PLAYER);
    await write({ sessionId: 1n, track: 0, note: 0 });
    vi.advanceTimersByTime(BLOCK_MS); // lands at 101, step 1
    vi.advanceTimersByTime(BLOCK_MS * 15); // block 116
    await write({ sessionId: 1n, track: 0, note: 0 });
    vi.advanceTimersByTime(BLOCK_MS); // lands at 117, step 1 again
    expect(hits.map((h) => h.on)).toEqual([true, false]);
    expect(isOn((await sim.eventSource.readPattern(1n))[1] ?? 0n, 0, 0)).toBe(false);
    sim.stop();
  });

  it('only delivers hits for the watched session and stops after unsubscribe', async () => {
    const sim = createSimulator({ startBlock: 100n });
    sim.start();
    const hits: HitEvent[] = [];
    const off = sim.eventSource.watchHits({ sessionId: 1n, mode: 'ws', onHits: (h) => hits.push(...h), onError: () => undefined });
    const write = sim.hitWriterFor(PLAYER);
    await write({ sessionId: 2n, track: 1, note: 1 });
    await write({ sessionId: 1n, track: 1, note: 1 });
    vi.advanceTimersByTime(BLOCK_MS);
    expect(hits.map((h) => h.sessionId)).toEqual([1n]);
    off();
    await write({ sessionId: 1n, track: 1, note: 2 });
    vi.advanceTimersByTime(BLOCK_MS);
    expect(hits).toHaveLength(1);
    sim.stop();
  });

  it('assigns increasing log indexes to hits in the same block and counts unique players', async () => {
    const sim = createSimulator({ startBlock: 100n });
    sim.start();
    const hits: HitEvent[] = [];
    sim.eventSource.watchHits({ sessionId: 1n, mode: 'ws', onHits: (h) => hits.push(...h), onError: () => undefined });
    await sim.hitWriterFor(PLAYER)({ sessionId: 1n, track: 0, note: 0 });
    await sim.hitWriterFor(OTHER)({ sessionId: 1n, track: 1, note: 0 });
    vi.advanceTimersByTime(BLOCK_MS);
    expect(hits.map((h) => h.logIndex)).toEqual([0, 1]);
    expect(new Set(hits.map((h) => h.txHash)).size).toBe(2);
    sim.stop();
  });

  it('rejects invalid track or note', async () => {
    const sim = createSimulator({ startBlock: 100n });
    const write = sim.hitWriterFor(PLAYER);
    await expect(write({ sessionId: 1n, track: 8 as never, note: 0 })).rejects.toThrow(/track/);
    await expect(write({ sessionId: 1n, track: 0, note: 32 })).rejects.toThrow(/note/);
  });
});

describe('createSimulator tips', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects a tip while the session has no hits or the value is zero', async () => {
    const sim = createSimulator({ startBlock: 100n });
    const tip = sim.tipWriterFor(PLAYER);
    await expect(tip({ sessionId: 1n, valueWei: 5n })).rejects.toThrow(/NoHits/);
    // Same shape as a real node revert so the tip sender classifies it by errorName (review H10).
    await expect(tip({ sessionId: 1n, valueWei: 5n })).rejects.toSatisfy((e: unknown) => revertErrorName(e) === 'NoHits');
    await sim.hitWriterFor(PLAYER)({ sessionId: 1n, track: 0, note: 0 });
    sim.start();
    vi.advanceTimersByTime(BLOCK_MS);
    await expect(tip({ sessionId: 1n, valueWei: 0n })).rejects.toThrow(/ZeroTip/);
    await expect(tip({ sessionId: 1n, valueWei: 0n })).rejects.toSatisfy((e: unknown) => revertErrorName(e) === 'ZeroTip');
    sim.stop();
  });

  it('adds a tip to the session pool and confirms it on the next mined block', async () => {
    const sim = createSimulator({ startBlock: 100n });
    await sim.hitWriterFor(PLAYER)({ sessionId: 1n, track: 0, note: 0 });
    sim.start();
    vi.advanceTimersByTime(BLOCK_MS);
    const hash = await sim.tipWriterFor(OTHER)({ sessionId: 1n, valueWei: 5n });
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
    const receipt = sim.receipts.waitForReceipt(hash);
    vi.advanceTimersByTime(BLOCK_MS);
    expect(await receipt).toEqual({ blockNumber: 102n, status: 'success' });
    expect((await sim.eventSource.readSession(1n))?.tipPool).toBe(5n);
    sim.stop();
  });
  it('keeps no balance for a wallet it never funded, so hits stay free (W12)', async () => {
    const sim = createSimulator({ startBlock: 100n });
    expect(sim.balanceOf(PLAYER)).toBeNull();
    await expect(sim.hitWriterFor(PLAYER)({ sessionId: 1n, track: 0, note: 0 })).resolves.toMatch(/^0x/);
    expect(sim.balanceOf(PLAYER)).toBeNull();
  });

  it('charges a credited wallet the gas tier at the base fee per hit and tip (W12)', async () => {
    const sim = createSimulator({ startBlock: 100n });
    sim.credit(PLAYER, parseEther('0.3'));
    const hit = sim.hitWriterFor(PLAYER);
    await hit({ sessionId: 1n, track: 0, note: 0 });
    expect(sim.balanceOf(PLAYER)).toBe(parseEther('0.3') - HIT_GAS_LIMIT_FIRST * HIT_PRICE);
    await hit({ sessionId: 1n, track: 0, note: 1 });
    expect(sim.balanceOf(PLAYER)).toBe(parseEther('0.3') - (HIT_GAS_LIMIT_FIRST + HIT_GAS_LIMIT) * HIT_PRICE);
    sim.start();
    vi.advanceTimersByTime(BLOCK_MS);
    await sim.tipWriterFor(PLAYER)({ sessionId: 1n, valueWei: parseEther('0.005') });
    expect(sim.balanceOf(PLAYER)).toBe(
      parseEther('0.3') - (HIT_GAS_LIMIT_FIRST + HIT_GAS_LIMIT) * HIT_PRICE - TIP_GAS_LIMIT * MONAD_BASE_FEE_WEI - parseEther('0.005'),
    );
    sim.credit(PLAYER, parseEther('0.1'));
    expect(sim.balanceOf(PLAYER)).toBeGreaterThan(parseEther('0.1'));
    sim.stop();
  });

  it('refuses a hit the wallet cannot pay for with node wording (W12)', async () => {
    const sim = createSimulator({ startBlock: 100n });
    sim.credit(PLAYER, parseEther('0.0042'));
    await expect(sim.hitWriterFor(PLAYER)({ sessionId: 1n, track: 0, note: 0 })).rejects.toThrow(/insufficient funds/);
    expect(sim.balanceOf(PLAYER)).toBe(parseEther('0.0042'));
  });
  it('echoes a tip as a Tipped event for watchers of that session on the next block (W12)', async () => {
    const sim = createSimulator({ startBlock: 100n });
    const tips: unknown[] = [];
    const off = sim.eventSource.watchTips?.({ sessionId: 1n, mode: 'ws', onTips: (t) => tips.push(...t), onError: () => undefined });
    await sim.hitWriterFor(PLAYER)({ sessionId: 1n, track: 0, note: 0 });
    sim.start();
    vi.advanceTimersByTime(BLOCK_MS);
    const hash = await sim.tipWriterFor(OTHER)({ sessionId: 1n, valueWei: 5n });
    vi.advanceTimersByTime(BLOCK_MS);
    expect(tips).toEqual([{ sessionId: 1n, from: OTHER, amountWei: 5n, blockNumber: 102n, txHash: hash, logIndex: 0 }]);
    off?.();
    await sim.tipWriterFor(OTHER)({ sessionId: 1n, valueWei: 5n });
    vi.advanceTimersByTime(BLOCK_MS);
    expect(tips).toHaveLength(1);
    sim.stop();
  });
});
