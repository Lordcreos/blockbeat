/**
 * In-memory chain for the crowd engine tests: mines a block every `blockMs` on real timers,
 * includes every pending transaction in the next block (nonce order per sender), emits heads,
 * Hit logs and Finalized like the viem adapter, and optionally applies Monad's reserve rule.
 */
import type { Address, Hash, LocalAccount } from 'viem';
import { MONAD_RESERVE_BALANCE_WEI, RESERVE_WINDOW_BLOCKS, stepForBlock, type TrackId } from '@blockbeat/shared';
import type { CrowdChain, CrowdHit, Receipt, SessionInfo } from '../../src/lib/crowd/engine';

export interface SentTx {
  kind: 'transfer' | 'hit';
  from: Address;
  to?: Address;
  value: bigint;
  nonce: number;
  gas: bigint;
  sentAtBlock: bigint;
  hash: Hash;
}

export class FakeCrowdChain implements CrowdChain {
  block = 1000n;
  startBlock = 1000n;
  finalized = false;
  readonly balances = new Map<Address, bigint>();
  readonly nonces = new Map<Address, number>();
  readonly sent: SentTx[] = [];
  readonly calls: string[] = [];
  readonly history: CrowdHit[] = [];
  reserveRule = true;
  /** Throws on the next N transfer sends from these addresses. */
  readonly failTransfersFrom = new Map<Address, number>();
  private readonly lastTxBlock = new Map<Address, bigint>();
  private pending: SentTx[] = [];
  private readonly receipts = new Map<Hash, Receipt>();
  private readonly heads = new Set<(b: bigint) => void>();
  private readonly hitWatchers = new Set<(h: CrowdHit) => void>();
  private readonly finalWatchers = new Set<() => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private seq = 0;
  private logIndex = 0;
  private readonly hitArgs = new Map<Hash, { track: TrackId; note: number }>();

  constructor(private readonly blockMs: number, funder: Address, funderWei: bigint) {
    this.balances.set(funder, funderWei);
  }

  start(): void {
    this.timer = setInterval(() => this.mine(), this.blockMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  finalize(): void {
    this.finalized = true;
    for (const cb of this.finalWatchers) cb();
  }

  /** A hit by someone else (a human phone) at the current block. */
  humanHit(track: TrackId, note: number, block: bigint = this.block): void {
    this.history.push({ txHash: this.hash(), blockNumber: block, logIndex: this.logIndex++, step: stepForBlock(this.startBlock, block), track, note, player: '0x000000000000000000000000000000000000dEaD', on: true });
  }

  private mine(): void {
    this.block += 1n;
    this.logIndex = 0;
    const work = [...this.pending].sort((a, b) => (a.from === b.from ? a.nonce - b.nonce : 0));
    this.pending = [];
    for (const tx of work) this.include(tx);
    for (const cb of this.heads) cb(this.block);
  }

  private include(tx: SentTx): void {
    const price = 102_000_000_000n;
    const fee = tx.gas * price;
    const before = this.balances.get(tx.from) ?? 0n;
    const last = this.lastTxBlock.get(tx.from);
    this.lastTxBlock.set(tx.from, this.block);
    this.nonces.set(tx.from, tx.nonce + 1);
    let status: Receipt['status'] = 'success';
    if (before < fee + tx.value) status = 'reverted';
    else if (tx.value > 0n && this.reserveRule && before - tx.value - fee < MONAD_RESERVE_BALANCE_WEI && last !== undefined && this.block - last <= BigInt(RESERVE_WINDOW_BLOCKS)) status = 'reverted';
    this.balances.set(tx.from, before - (status === 'reverted' ? (before < fee ? before : fee) : fee));
    if (status === 'success' && tx.to && tx.value > 0n) {
      this.balances.set(tx.from, (this.balances.get(tx.from) ?? 0n) - tx.value);
      this.balances.set(tx.to, (this.balances.get(tx.to) ?? 0n) + tx.value);
    }
    this.receipts.set(tx.hash, { blockNumber: this.block, status });
    if (tx.kind === 'hit' && status === 'success' && !this.finalized) {
      const args = this.hitArgs.get(tx.hash);
      if (!args) return;
      const hit: CrowdHit = { txHash: tx.hash, blockNumber: this.block, logIndex: this.logIndex++, step: stepForBlock(this.startBlock, this.block), track: args.track, note: args.note, player: tx.from, on: true };
      this.history.push(hit);
      for (const cb of this.hitWatchers) cb(hit);
    }
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
    const queued = this.pending.filter((t) => t.from === a).length;
    return Promise.resolve((this.nonces.get(a) ?? 0) + queued);
  }

  getSession(): Promise<SessionInfo> {
    this.calls.push('getSession');
    return Promise.resolve({ startBlock: this.startBlock, finalized: this.finalized });
  }

  getRecentHits(_sessionId: bigint, fromBlock: bigint, toBlock: bigint): Promise<CrowdHit[]> {
    this.calls.push('getRecentHits');
    return Promise.resolve(this.history.filter((h) => h.blockNumber >= fromBlock && h.blockNumber <= toBlock));
  }

  sendTransfer(from: LocalAccount, to: Address, value: bigint, nonce: number): Promise<Hash> {
    this.calls.push('sendTransfer');
    const fails = this.failTransfersFrom.get(from.address) ?? 0;
    if (fails > 0) {
      this.failTransfersFrom.set(from.address, fails - 1);
      return Promise.reject(new Error('nonce too low'));
    }
    const tx: SentTx = { kind: 'transfer', from: from.address, to, value, nonce, gas: 21_000n, sentAtBlock: this.block, hash: this.hash() };
    this.sent.push(tx);
    this.pending.push(tx);
    return Promise.resolve(tx.hash);
  }

  sendHit(from: LocalAccount, _sessionId: bigint, track: TrackId, note: number, nonce: number, gas: bigint): Promise<Hash> {
    this.calls.push('sendHit');
    const tx: SentTx = { kind: 'hit', from: from.address, value: 0n, nonce, gas, sentAtBlock: this.block, hash: this.hash() };
    this.hitArgs.set(tx.hash, { track, note });
    this.sent.push(tx);
    this.pending.push(tx);
    return Promise.resolve(tx.hash);
  }

  getReceipt(hash: Hash): Promise<Receipt | null> {
    this.calls.push('getReceipt');
    return Promise.resolve(this.receipts.get(hash) ?? null);
  }

  watchHeads(cb: (b: bigint) => void): () => void {
    this.heads.add(cb);
    return () => this.heads.delete(cb);
  }

  watchHits(_sessionId: bigint, cb: (h: CrowdHit) => void): () => void {
    this.hitWatchers.add(cb);
    return () => this.hitWatchers.delete(cb);
  }

  watchFinalized(_sessionId: bigint, cb: () => void): () => void {
    this.finalWatchers.add(cb);
    return () => this.finalWatchers.delete(cb);
  }
}
