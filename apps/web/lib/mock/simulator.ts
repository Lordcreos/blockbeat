/**
 * In-memory Monad: emits a head every BLOCK_MS and lands hits in the next block, echoing
 * them as `Hit` events exactly like the contract would. Used whenever the shared address
 * for chain 10143 is zero so the UI and audio work with no chain at all.
 */
import {
  BLOCK_MS,
  HIT_GAS_LIMIT,
  HIT_GAS_LIMIT_FIRST,
  HIT_MAX_FEE_PER_GAS,
  HIT_MAX_PRIORITY_FEE_PER_GAS,
  MONAD_BASE_FEE_WEI,
  TIP_GAS_LIMIT,
  blockbeatAbi,
  emptyPattern,
  isNote,
  isOn,
  isTrackId,
  stepForBlock,
  toggle,
  type HitEvent,
  type Pattern,
  type SessionState,
} from '@blockbeat/shared';
import { ContractFunctionRevertedError, encodeErrorResult, type Address, type Hash } from 'viem';
import type { HeadSource } from '../blockClock';
import type { EventSource, HitRange, HitRangeQuery, HitWatchArgs, TipWatchArgs } from '../eventFeed';
import type { TipEvent } from '../types';
import type { HitWriter } from '../hitSender';
import type { TipReceiptSource, TipWriter } from '../tipSender';

export interface SimulatorOptions {
  startBlock?: bigint;
  blockMs?: number;
}

export interface Simulator {
  headSource: HeadSource;
  eventSource: EventSource;
  hitWriterFor(player: Address): HitWriter;
  /** Tips land on the next mined block; the receipt source resolves them. */
  tipWriterFor(player: Address): TipWriter;
  receipts: TipReceiptSource;
  /**
   * W12: balance of a wallet the simulator funded with `credit`, or null for one it never
   * funded (those stay free, so tests and pages that never drip keep working).
   */
  balanceOf(address: Address): bigint | null;
  /** Adds MON to a wallet, as the drip would; from then on its hits and tips are charged. */
  credit(address: Address, wei: bigint): void;
  /** W12: the gas tier the player's next hit in the session is charged (first-hit tier until one was sent). */
  nextHitGas(player: Address, sessionId: bigint): bigint;
  currentBlock(): bigint;
  start(): void;
  stop(): void;
}

interface PendingHit {
  sessionId: bigint;
  player: Address;
  track: HitEvent['track'];
  note: number;
  txHash: Hash;
}

interface SimSession {
  state: SessionState;
  pattern: bigint[];
  /** W13: every Hit event of the session, in chain order (served to getLogs-style reads). */
  hits: HitEvent[];
}

function randomHash(): Hash {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let hex = '0x';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex as Hash;
}

const HOST: Address = '0x000000000000000000000000000000000000b10c';

/** The same error shape a node produces, so the tip sender classifies by decoded name (review H10). */
function simulatedRevert(errorName: 'NoHits' | 'ZeroTip'): ContractFunctionRevertedError {
  return new ContractFunctionRevertedError({
    abi: blockbeatAbi,
    functionName: 'tip',
    data: encodeErrorResult({ abi: blockbeatAbi, errorName }),
  });
}

export function createSimulator(options: SimulatorOptions = {}): Simulator {
  const blockMs = options.blockMs ?? BLOCK_MS;
  let block = options.startBlock ?? 1000n;
  let interval: ReturnType<typeof setInterval> | null = null;

  const sessions = new Map<bigint, SimSession>();
  const headListeners = new Set<(n: bigint) => void>();
  const hitWatchers = new Set<{ sessionId: bigint; onHits: (hits: HitEvent[]) => void }>();
  let mempool: PendingHit[] = [];
  /** Tip txs waiting for the next block, with the listeners waiting for their receipt. */
  let pendingTips: Array<{ hash: Hash; sessionId: bigint; from: Address; amountWei: bigint }> = [];
  const tipWatchers = new Set<{ sessionId: bigint; onTips: (tips: TipEvent[]) => void }>();
  const minedTips = new Map<Hash, bigint>();
  const receiptWaiters = new Map<Hash, Array<(blockNumber: bigint) => void>>();
  /** Funded wallets only (lower-cased); charged gas limit × base fee like Monad. */
  const balances = new Map<string, bigint>();
  /** `${session}:${player}` pairs that already paid the first-hit tier. */
  const hitBefore = new Set<string>();

  /** Charges a funded wallet or throws the node's wording when it cannot pay; untracked wallets are free. */
  function charge(player: Address, requiredWei: bigint, costWei: bigint): void {
    const key = player.toLowerCase();
    const balance = balances.get(key);
    if (balance === undefined) return;
    if (balance < requiredWei) throw new Error('insufficient funds for gas * price + value');
    balances.set(key, balance - costWei);
  }

  function session(sessionId: bigint): SimSession {
    let s = sessions.get(sessionId);
    if (!s) {
      s = {
        state: {
          sessionId,
          startBlock: block,
          host: HOST,
          finalized: false,
          hitCount: 0n,
          tokenId: 0n,
          parentSessionId: 0n,
          tipPool: 0n,
        },
        pattern: emptyPattern(),
        hits: [],
      };
      sessions.set(sessionId, s);
    }
    return s;
  }

  function mine(): void {
    block += 1n;
    const landed = mempool;
    mempool = [];
    const events: HitEvent[] = landed.map((tx, logIndex) => {
      const s = session(tx.sessionId);
      const step = stepForBlock(s.state.startBlock, block);
      const next = toggle(s.pattern[step] ?? 0n, tx.track, tx.note);
      s.pattern[step] = next;
      s.state = { ...s.state, hitCount: s.state.hitCount + 1n };
      return {
        sessionId: tx.sessionId,
        player: tx.player,
        blockNumber: block,
        step,
        track: tx.track,
        note: tx.note,
        on: isOn(next, tx.track, tx.note),
        txHash: tx.txHash,
        logIndex,
      };
    });
    for (const e of events) session(e.sessionId).hits.push(e);
    const tips = pendingTips;
    pendingTips = [];
    const tipEvents: TipEvent[] = [];
    for (const [logIndex, t] of tips.entries()) {
      minedTips.set(t.hash, block);
      for (const resolve of receiptWaiters.get(t.hash) ?? []) resolve(block);
      receiptWaiters.delete(t.hash);
      tipEvents.push({ sessionId: t.sessionId, from: t.from, amountWei: t.amountWei, blockNumber: block, txHash: t.hash, logIndex });
    }
    for (const cb of headListeners) cb(block);
    for (const w of hitWatchers) {
      const own = events.filter((e) => e.sessionId === w.sessionId);
      if (own.length > 0) w.onHits(own);
    }
    for (const w of tipWatchers) {
      const own = tipEvents.filter((e) => e.sessionId === w.sessionId);
      if (own.length > 0) w.onTips(own);
    }
  }

  const headSource: HeadSource = {
    kind: () => 'mock',
    subscribe(onHead) {
      headListeners.add(onHead);
      return () => headListeners.delete(onHead);
    },
  };

  const eventSource: EventSource = {
    async readPattern(sessionId): Promise<Pattern> {
      return [...session(sessionId).pattern];
    },
    async readSession(sessionId): Promise<SessionState | null> {
      return { ...session(sessionId).state };
    },
    async readHits({ sessionId, fromBlock, toBlock, player }: HitRangeQuery): Promise<HitRange> {
      const me = player?.toLowerCase();
      const hits = session(sessionId).hits.filter(
        (h) => h.blockNumber >= fromBlock && h.blockNumber <= toBlock && (me === undefined || h.player.toLowerCase() === me),
      );
      return { hits, decodeErrors: 0 };
    },
    async readHead(): Promise<bigint> {
      return block;
    },
    watchHits({ sessionId, onHits }: HitWatchArgs): () => void {
      const w = { sessionId, onHits };
      hitWatchers.add(w);
      return () => hitWatchers.delete(w);
    },
    watchTips({ sessionId, onTips }: TipWatchArgs): () => void {
      const w = { sessionId, onTips };
      tipWatchers.add(w);
      return () => tipWatchers.delete(w);
    },
  };

  return {
    headSource,
    eventSource,
    hitWriterFor(player) {
      return async ({ sessionId, track, note }) => {
        if (!isTrackId(track)) throw new Error(`simulator: invalid track ${String(track)}`);
        if (!isNote(note)) throw new Error(`simulator: invalid note ${String(note)}`);
        const tierKey = `${sessionId}:${player.toLowerCase()}`;
        const gas = hitBefore.has(tierKey) ? HIT_GAS_LIMIT : HIT_GAS_LIMIT_FIRST;
        charge(player, gas * HIT_MAX_FEE_PER_GAS, gas * (MONAD_BASE_FEE_WEI + HIT_MAX_PRIORITY_FEE_PER_GAS));
        hitBefore.add(tierKey);
        const txHash = randomHash();
        mempool.push({ sessionId, player, track, note, txHash });
        return txHash;
      };
    },
    tipWriterFor(player) {
      return async ({ sessionId, valueWei }) => {
        const s = session(sessionId);
        if (valueWei <= 0n) throw simulatedRevert('ZeroTip');
        if (s.state.hitCount === 0n) throw simulatedRevert('NoHits');
        const gasCost = TIP_GAS_LIMIT * MONAD_BASE_FEE_WEI;
        charge(player, valueWei + gasCost, valueWei + gasCost);
        s.state = { ...s.state, tipPool: s.state.tipPool + valueWei };
        const txHash = randomHash();
        pendingTips.push({ hash: txHash, sessionId, from: player, amountWei: valueWei });
        return txHash;
      };
    },
    receipts: {
      waitForReceipt(txHash) {
        const mined = minedTips.get(txHash);
        if (mined !== undefined) return Promise.resolve({ blockNumber: mined, status: 'success' });
        return new Promise((resolve) => {
          const waiters = receiptWaiters.get(txHash) ?? [];
          waiters.push((blockNumber) => resolve({ blockNumber, status: 'success' }));
          receiptWaiters.set(txHash, waiters);
        });
      },
    },
    balanceOf: (address) => balances.get(address.toLowerCase()) ?? null,
    credit(address, wei) {
      const key = address.toLowerCase();
      balances.set(key, (balances.get(key) ?? 0n) + wei);
    },
    nextHitGas: (player, sessionId) => (hitBefore.has(`${sessionId}:${player.toLowerCase()}`) ? HIT_GAS_LIMIT : HIT_GAS_LIMIT_FIRST),
    currentBlock: () => block,
    start() {
      if (interval !== null) return;
      interval = setInterval(mine, blockMs);
    },
    stop() {
      if (interval === null) return;
      clearInterval(interval);
      interval = null;
      // Nothing will mine after this: drop tip bookkeeping so waiters and hashes do not pile up.
      pendingTips = [];
      minedTips.clear();
      receiptWaiters.clear();
    },
  };
}
