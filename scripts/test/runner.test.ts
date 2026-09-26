import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Address, Hash, LocalAccount } from 'viem';
import { HIT_GAS_LIMIT, HIT_GAS_LIMIT_FIRST, MONAD_RESERVE_BALANCE_WEI, RESERVE_WINDOW_BLOCKS, STEPS } from '@blockbeat/shared';
import { runLoadTest, type ChainAdapter, type Fees, type HitLog, type Receipt } from '../src/lib/runner';

/**
 * In-memory chain: mines one block every `blockMs` (on vitest fake timers), includes every
 * pending transaction in the next block, emits heads and Hit logs like the real adapter.
 */
class FakeChain implements ChainAdapter {
  block = 100n;
  readonly startBlock = 100n;
  readonly balances = new Map<Address, bigint>();
  readonly nonces = new Map<Address, number>();
  readonly calls: string[] = [];
  readonly hitNonces: Array<{ from: Address; nonce: number }> = [];
  /** Gas limit of every hit send, and whether that wallet already had a hit mined. */
  readonly hitGas: Array<{ from: Address; gas: bigint; landedBefore: boolean }> = [];
  private readonly landed = new Set<Address>();
  failNextSend: Error | null = null;
  /** Apply Monad's reserve-balance rule to value transfers (W11). */
  reserveRule = false;
  private readonly lastTxBlock = new Map<Address, bigint>();
  /** Monad consensus sees balances RESERVE_WINDOW_BLOCKS late: a just-funded sender is rejected (W11). */
  consensusLag = false;
  private readonly fundedAt = new Map<Address, bigint>();
  private pending: Array<() => void> = [];
  private readonly heads = new Set<(b: bigint) => void>();
  private readonly hitWatchers = new Set<(h: HitLog) => void>();
  private readonly receipts = new Map<Hash, Receipt>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private seq = 0;

  constructor(private readonly blockMs: number, funder: Address) {
    this.balances.set(funder, 100n * 10n ** 18n);
  }

  start(): void {
    this.timer = setInterval(() => this.mine(), this.blockMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private mine(): void {
    const work = this.pending;
    this.pending = [];
    this.block += 1n;
    for (const w of work) w();
    for (const cb of this.heads) cb(this.block);
  }

  private hash(): Hash {
    this.seq += 1;
    return `0x${this.seq.toString(16).padStart(64, '0')}` as Hash;
  }

  getBlockNumber(): Promise<bigint> {
    this.calls.push('getBlockNumber');
    return Promise.resolve(this.block);
  }

  getBalance(a: Address): Promise<bigint> {
    this.calls.push('getBalance');
    return Promise.resolve(this.balances.get(a) ?? 0n);
  }

  getNonce(a: Address): Promise<number> {
    this.calls.push('getNonce');
    return Promise.resolve(this.nonces.get(a) ?? 0);
  }

  getSessionStartBlock(): Promise<bigint> {
    this.calls.push('getSessionStartBlock');
    return Promise.resolve(this.startBlock);
  }

  getFees(): Promise<Fees> {
    this.calls.push('getFees');
    return Promise.resolve({ maxFeePerGas: 100n, maxPriorityFeePerGas: 1n });
  }

  sendTransfer(from: LocalAccount, to: Address, valueWei: bigint, nonce: number): Promise<Hash> {
    this.calls.push('sendTransfer');
    const hash = this.hash();
    this.pending.push(() => {
      const before = this.balances.get(from.address) ?? 0n;
      const last = this.lastTxBlock.get(from.address);
      const recent = last !== undefined && this.block - last <= BigInt(RESERVE_WINDOW_BLOCKS);
      const reverted = this.reserveRule && recent && before - valueWei < MONAD_RESERVE_BALANCE_WEI;
      this.lastTxBlock.set(from.address, this.block);
      this.balances.set(from.address, before - (reverted ? 0n : valueWei) - 21_000n * 100n);
      if (!reverted) {
        this.balances.set(to, (this.balances.get(to) ?? 0n) + valueWei);
        this.fundedAt.set(to, this.block);
      }
      this.nonces.set(from.address, nonce + 1);
      this.receipts.set(hash, { blockNumber: this.block, status: reverted ? 'reverted' : 'success', gasUsed: 21_000n, effectiveGasPrice: 100n });
    });
    return Promise.resolve(hash);
  }

  sendHit(from: LocalAccount, sessionId: bigint, track: number, note: number, nonce: number, _fees: Fees, gas: bigint): Promise<Hash> {
    this.calls.push('sendHit');
    this.hitGas.push({ from: from.address, gas, landedBefore: this.landed.has(from.address) });
    if (this.failNextSend) {
      const e = this.failNextSend;
      this.failNextSend = null;
      return Promise.reject(e);
    }
    const funded = this.fundedAt.get(from.address);
    if (this.consensusLag && funded !== undefined && this.block - funded < BigInt(RESERVE_WINDOW_BLOCKS)) {
      return Promise.reject(Object.assign(new Error('Signer had insufficient balance'), { code: -32000 }));
    }
    this.hitNonces.push({ from: from.address, nonce });
    const hash = this.hash();
    this.pending.push(() => {
      this.balances.set(from.address, (this.balances.get(from.address) ?? 0n) - 60_000n * 100n);
      this.nonces.set(from.address, nonce + 1);
      this.lastTxBlock.set(from.address, this.block);
      this.landed.add(from.address);
      this.receipts.set(hash, { blockNumber: this.block, status: 'success', gasUsed: 60_000n, effectiveGasPrice: 100n });
      const step = Number((this.block - this.startBlock) % BigInt(STEPS));
      for (const cb of this.hitWatchers) cb({ txHash: hash, blockNumber: this.block, step, sessionId, track, note });
    });
    return Promise.resolve(hash);
  }

  getReceipt(hash: Hash): Promise<Receipt | null> {
    this.calls.push('getReceipt');
    return Promise.resolve(this.receipts.get(hash) ?? null);
  }

  watchHeads(cb: (b: bigint) => void): () => void {
    this.heads.add(cb);
    return () => this.heads.delete(cb);
  }

  watchHits(_sessionId: bigint, cb: (h: HitLog) => void): () => void {
    this.hitWatchers.add(cb);
    return () => this.hitWatchers.delete(cb);
  }
}

const FUNDER_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;

function baseOptions() {
  return {
    chainId: 31337,
    sessionId: 1n,
    wallets: 3,
    hits: 2,
    windowMs: 1_000,
    rps: 50,
    blockMs: 300,
    lagBlocks: 1,
    hitTimeoutMs: 5_000,
    seed: 42,
    sweep: false,
    receipts: 'all' as const,
    funderKey: FUNDER_KEY,
    log: () => {},
  };
}

describe('runLoadTest', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('funds every wallet, fires wallets x hits with sequential nonces and confirms them from Hit logs', async () => {
    const chain = new FakeChain(300, '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266');
    chain.start();
    const run = runLoadTest(baseOptions(), chain);
    await vi.advanceTimersByTimeAsync(30_000);
    chain.stop();
    const result = await run;

    expect(result.summary.hits.total).toBe(6);
    expect(result.summary.hits.confirmed).toBe(6);
    expect(result.records.every((r) => r.status === 'confirmed' && typeof r.latencyMs === 'number' && r.latencyMs > 0)).toBe(true);
    expect(chain.calls.filter((c) => c === 'sendTransfer')).toHaveLength(3);
    expect(chain.calls).not.toContain('estimateGas');
    const byWallet = new Map<Address, number[]>();
    for (const { from, nonce } of chain.hitNonces) byWallet.set(from, [...(byWallet.get(from) ?? []), nonce]);
    expect([...byWallet.values()]).toEqual([[0, 1], [0, 1], [0, 1]]);
    // Actual steps come from the log and match the block the fake mined.
    for (const r of result.records) {
      expect(r.actualStep).toBe(Number(((r.blockNumber ?? 0n) - chain.startBlock) % BigInt(STEPS)));
    }
    // Intended steps are predictions in range.
    expect(result.records.every((r) => r.intendedStep >= 0 && r.intendedStep < STEPS)).toBe(true);
    expect(result.summary.landing.onTime + result.summary.landing.oneLate + result.summary.landing.late + result.summary.landing.early).toBe(6);
    expect(result.measuredBlockMs).toBeGreaterThan(0);
    expect(Number(result.summary.mon.funded)).toBeGreaterThan(0);
    expect(Number(result.summary.mon.hitsSpent)).toBeCloseTo(6 * 60_000 * 100 / 1e18, 25);
    expect(result.summary.mon.gasUsedTotal).toBe(String(6 * 60_000));
  });

  it('uses the first-hit gas tier until one of the wallet\'s hits lands, then the lower tier (W11: 80k on a fresh wallet runs out of gas)', async () => {
    const chain = new FakeChain(300, '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266');
    chain.start();
    const run = runLoadTest({ ...baseOptions(), wallets: 2, hits: 4, windowMs: 6_000 }, chain);
    await vi.advanceTimersByTimeAsync(60_000);
    chain.stop();
    const result = await run;
    expect(result.summary.hits.confirmed).toBe(8);
    for (const s of chain.hitGas) expect(s.gas).toBe(s.landedBefore ? HIT_GAS_LIMIT : HIT_GAS_LIMIT_FIRST);
    expect(chain.hitGas.some((s) => s.gas === HIT_GAS_LIMIT)).toBe(true);
    // Funding reserves the first-hit tier for every hit (hits sent before the first lands pay it); --sweep returns the rest.
    expect(result.fundWeiPerWallet).toBeGreaterThanOrEqual(4n * HIT_GAS_LIMIT_FIRST * 100n);
  });

  it('paces funding transfers when the funder is below the Monad reserve so none reverts (W11: 4 of 5 reverted on testnet)', async () => {
    const funder = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
    const chain = new FakeChain(300, funder);
    chain.reserveRule = true;
    chain.balances.set(funder, 4n * 10n ** 18n);
    chain.start();
    const run = runLoadTest({ ...baseOptions(), wallets: 3, hits: 2, sweep: true }, chain);
    await vi.advanceTimersByTimeAsync(60_000);
    chain.stop();
    const result = await run;
    expect(result.summary.hits.confirmed).toBe(6);
    expect(result.sweptWei).toBeGreaterThan(0n);
  });

  it('waits out the consensus balance lag after funding before the first hit (W11: first send was "Signer had insufficient balance")', async () => {
    const chain = new FakeChain(300, '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266');
    chain.consensusLag = true;
    chain.start();
    // windowMs 1 puts every hit at t0, right after funding.
    const run = runLoadTest({ ...baseOptions(), wallets: 2, hits: 2, windowMs: 1 }, chain);
    await vi.advanceTimersByTimeAsync(30_000);
    chain.stop();
    const result = await run;
    expect(result.summary.hits.sendFailed).toBe(0);
    expect(result.summary.hits.confirmed).toBe(4);
  });

  it('records a failed send with its error code and keeps going', async () => {
    const chain = new FakeChain(300, '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266');
    chain.start();
    chain.failNextSend = Object.assign(new Error('Too Many Requests'), { name: 'HttpRequestError', status: 429 });
    const run = runLoadTest(baseOptions(), chain);
    await vi.advanceTimersByTimeAsync(30_000);
    chain.stop();
    const result = await run;
    expect(result.summary.hits.sendFailed).toBe(1);
    expect(result.summary.hits.confirmed).toBe(5);
    const failed = result.records.find((r) => r.status === 'send-failed');
    expect(failed?.errorCode).toBe('HTTP_429');
    expect(failed?.rateLimited).toBe(true);
    expect(result.summary.rateLimitHits).toBe(1);
  });

  it('marks hits whose log never arrives as timed out after the hit timeout', async () => {
    const chain = new FakeChain(300, '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266');
    chain.start();
    // Drop the hit: the RPC accepts it (returns a hash) but it is never mined.
    chain.sendHit = () => Promise.resolve(`0x${'de'.repeat(32)}` as Hash);
    const run = runLoadTest({ ...baseOptions(), wallets: 1, hits: 1, hitTimeoutMs: 2_000 }, chain);
    await vi.advanceTimersByTimeAsync(30_000);
    chain.stop();
    const result = await run;
    expect(result.summary.hits.timedOut).toBe(1);
  });

  it('refreshes the fee estimate during a long hit phase', async () => {
    const chain = new FakeChain(300, '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266');
    chain.start();
    const run = runLoadTest({ ...baseOptions(), wallets: 1, hits: 3, windowMs: 25_000, feeRefreshMs: 10_000 }, chain);
    await vi.advanceTimersByTimeAsync(60_000);
    chain.stop();
    await run;
    // Once at start plus at least two refreshes inside the 25 s window.
    expect(chain.calls.filter((c) => c === 'getFees').length).toBeGreaterThanOrEqual(3);
  });

  it('refuses to run against a session that has not started', async () => {
    const chain = new FakeChain(300, '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266');
    chain.getSessionStartBlock = () => Promise.resolve(0n);
    await expect(runLoadTest(baseOptions(), chain)).rejects.toThrow(/session/);
  });

  it('spreads sends over the window and respects the rps bucket', async () => {
    const chain = new FakeChain(300, '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266');
    chain.start();
    const run = runLoadTest({ ...baseOptions(), wallets: 4, hits: 5, windowMs: 200, rps: 5 }, chain);
    await vi.advanceTimersByTimeAsync(60_000);
    chain.stop();
    const result = await run;
    const sentAts = result.records.map((r) => r.sentAt).sort((a, b) => a - b);
    // 20 hits at 5 rps with a 5-token burst: the last send is at least 3 s after the first.
    expect((sentAts[sentAts.length - 1] ?? 0) - (sentAts[0] ?? 0)).toBeGreaterThanOrEqual(3_000);
    expect(result.summary.bucket.waits).toBeGreaterThan(0);
  });
});
