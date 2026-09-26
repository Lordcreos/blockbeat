/**
 * In-memory Monad: emits a head every BLOCK_MS and lands hits in the next block, echoing
 * them as `Hit` events exactly like the contract would. Used whenever the shared address
 * for chain 10143 is zero so the UI and audio work with no chain at all.
 *
 * W21b: tips split like the W21a contract when they are mined (lib/tips/split.ts: the host
 * share, the rest to the pool; all to the host while no human has played; the DJ agent is not
 * human). With a `bus`, simulators in other tabs of the origin share hits and tips
 * (lib/mock/bus.ts), so the phone, tip and stage tabs play one room in mock mode.
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
import { splitTip } from '../tips/split';
import { playerShare } from '@blockbeat/shared';
import { MOCK_SYNC_LIMIT, type BusHit, type BusMessage, type BusTip, type MockBus } from './bus';

export interface SimulatorOptions {
  startBlock?: bigint;
  blockMs?: number;
  /** W21b: share transactions with the simulators of other tabs (mock mode in the browser). */
  bus?: MockBus | null;
  /** W21b: the DJ agent's address: its hits are not human, so they earn no share of tips. */
  agent?: Address | null;
}

/** W21b: what the mock track page shows for a session: the split and who played. */
export interface SimSessionSummary {
  hitCount: bigint;
  hostWei: bigint;
  poolWei: bigint;
  contributors: Array<{ address: Address; hits: bigint }>;
  tips: TipEvent[];
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
  /** W21b: the session's split and contributors; null for a session this simulator never saw. */
  summary(sessionId: bigint): SimSessionSummary | null;
  /**
   * W21b: the mock finalize (the host route answers without a chain; the stage calls this). Other
   * tabs hear it over the bus, so phones see the session end and can claim their share.
   */
  finalize(sessionId: bigint, tokenId: bigint): void;
  /** W21b: the session a mock token was minted from (null when this tab never saw that finalize). */
  sessionForToken(tokenId: bigint): bigint | null;
  /** W21b: `claimableOf` / `claim` for a human player after finalize (W21a semantics). */
  claimableOf(sessionId: bigint, player: Address): bigint;
  claim(sessionId: bigint, player: Address): bigint;
  /** W21b: `hostClaimableOf` / `claimHost`: the host share of tips, pulled by the host. */
  hostClaimableOf(sessionId: bigint): bigint;
  claimHost(sessionId: bigint): bigint;
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
  /** W21b: every Tipped event, the host's share so far and each player's hits. */
  tips: TipEvent[];
  hostWei: bigint;
  hitsBy: Map<string, { address: Address; hits: bigint }>;
  hostClaimed: bigint;
  claimed: Map<string, bigint>;
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
function simulatedRevert(errorName: 'NoHits' | 'ZeroTip' | 'NothingToClaim' | 'SessionNotFinalized', functionName: 'tip' | 'claim' | 'claimHost' = 'tip'): ContractFunctionRevertedError {
  return new ContractFunctionRevertedError({
    abi: blockbeatAbi,
    functionName,
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
  const bus = options.bus ?? null;
  const agent = options.agent?.toLowerCase() ?? null;
  /** W21b: tx hashes (lower-case) this simulator already holds, local or from the bus. */
  const known = new Set<string>();
  const tokenSessions = new Map<bigint, bigint>();
  const sessionWatchers = new Set<{ sessionId: bigint; onSession: (s: SessionState) => void }>();

  function markFinalized(sessionId: bigint, tokenId: bigint): void {
    const s = session(sessionId);
    s.state = { ...s.state, finalized: true, tokenId };
    tokenSessions.set(tokenId, sessionId);
    for (const w of sessionWatchers) if (w.sessionId === sessionId) w.onSession({ ...s.state });
  }
  let unsubscribeBus: (() => void) | null = null;
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
        tips: [],
        hostWei: 0n,
        hitsBy: new Map(),
        hostClaimed: 0n,
        claimed: new Map(),
      };
      sessions.set(sessionId, s);
      // W21b: another tab may already hold this session's notes and tips.
      bus?.post({ kind: 'sync-request', sessionId: sessionId.toString() });
    }
    return s;
  }

  function humanHits(s: SimSession): bigint {
    let n = 0n;
    for (const [key, p] of s.hitsBy) if (key !== agent) n += p.hits;
    return n;
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
      const by = s.hitsBy.get(tx.player.toLowerCase()) ?? { address: tx.player, hits: 0n };
      s.hitsBy.set(tx.player.toLowerCase(), { address: by.address, hits: by.hits + 1n });
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
      // W21a: the split is fixed when the tip executes, by the human hits at that moment.
      const s = session(t.sessionId);
      const split = splitTip(t.amountWei, humanHits(s));
      s.hostWei += split.hostWei;
      s.state = { ...s.state, tipPool: s.state.tipPool + split.poolWei };
      const event: TipEvent = { sessionId: t.sessionId, from: t.from, amountWei: t.amountWei, blockNumber: block, txHash: t.hash, logIndex, split };
      s.tips.push(event);
      tipEvents.push(event);
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

  /** W21b: a hit another tab accepted lands here in the next block (same tx hash, local step). */
  function acceptRemoteHit(h: BusHit): void {
    const key = h.txHash.toLowerCase();
    if (known.has(key) || !isTrackId(h.track) || !isNote(h.note)) return;
    known.add(key);
    mempool.push({ sessionId: BigInt(h.sessionId), player: h.player, track: h.track, note: h.note, txHash: key as Hash });
  }

  function acceptRemoteTip(t: BusTip): void {
    const key = t.txHash.toLowerCase();
    if (known.has(key)) return;
    known.add(key);
    pendingTips.push({ hash: key as Hash, sessionId: BigInt(t.sessionId), from: t.from, amountWei: BigInt(t.amountWei) });
  }

  function answerSync(sessionId: string): void {
    const s = sessions.get(BigInt(sessionId));
    if (!s || !bus) return;
    const id = BigInt(sessionId);
    const hits: BusHit[] = [
      ...s.hits.map((h) => ({ sessionId, player: h.player, track: h.track, note: h.note, txHash: h.txHash })),
      ...mempool.filter((h) => h.sessionId === id).map((h) => ({ sessionId, player: h.player, track: h.track, note: h.note, txHash: h.txHash })),
    ].slice(-MOCK_SYNC_LIMIT);
    const tips: BusTip[] = [
      ...s.tips.map((t) => ({ sessionId, from: t.from, amountWei: t.amountWei.toString(), txHash: t.txHash })),
      ...pendingTips.filter((t) => t.sessionId === id).map((t) => ({ sessionId, from: t.from, amountWei: t.amountWei.toString(), txHash: t.hash })),
    ].slice(-MOCK_SYNC_LIMIT);
    if (hits.length > 0 || tips.length > 0) bus.post({ kind: 'sync', sessionId, hits, tips });
  }

  function onBus(message: BusMessage): void {
    switch (message.kind) {
      case 'hit':
        acceptRemoteHit(message);
        return;
      case 'tip':
        acceptRemoteTip(message);
        return;
      case 'sync-request':
        answerSync(message.sessionId);
        return;
      case 'finalize':
        markFinalized(BigInt(message.sessionId), BigInt(message.tokenId));
        return;
      case 'sync':
        // Hits first: in mine() they land before the tips of the same block, as they did there.
        for (const h of message.hits) acceptRemoteHit(h);
        for (const t of message.tips) acceptRemoteTip(t);
        return;
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
    watchSession({ sessionId, onSession }) {
      const w = { sessionId, onSession };
      sessionWatchers.add(w);
      return () => sessionWatchers.delete(w);
    },
    async readTotalTips(sessionId): Promise<bigint> {
      const s = session(sessionId);
      return s.hostWei + s.state.tipPool;
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
        known.add(txHash);
        bus?.post({ kind: 'hit', sessionId: sessionId.toString(), player, track, note, txHash });
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
        const txHash = randomHash();
        pendingTips.push({ hash: txHash, sessionId, from: player, amountWei: valueWei });
        known.add(txHash);
        bus?.post({ kind: 'tip', sessionId: sessionId.toString(), from: player, amountWei: valueWei.toString(), txHash });
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
    finalize(sessionId, tokenId) {
      markFinalized(sessionId, tokenId);
      bus?.post({ kind: 'finalize', sessionId: sessionId.toString(), tokenId: tokenId.toString() });
    },
    sessionForToken: (tokenId) => tokenSessions.get(tokenId) ?? null,
    claimableOf(sessionId, player) {
      const s = sessions.get(sessionId);
      if (!s || !s.state.finalized) return 0n;
      const key = player.toLowerCase();
      if (key === agent) return 0n;
      const hits = s.hitsBy.get(key)?.hits ?? 0n;
      return playerShare(s.state.tipPool, hits, humanHits(s)) - (s.claimed.get(key) ?? 0n);
    },
    claim(sessionId, player) {
      const s = sessions.get(sessionId);
      if (!s || !s.state.finalized) throw simulatedRevert('SessionNotFinalized', 'claim');
      const amount = this.claimableOf(sessionId, player);
      if (amount <= 0n) throw simulatedRevert('NothingToClaim', 'claim');
      const key = player.toLowerCase();
      s.claimed.set(key, (s.claimed.get(key) ?? 0n) + amount);
      if (balances.has(key)) balances.set(key, (balances.get(key) ?? 0n) + amount);
      return amount;
    },
    hostClaimableOf(sessionId) {
      const s = sessions.get(sessionId);
      return s ? s.hostWei - s.hostClaimed : 0n;
    },
    claimHost(sessionId) {
      const s = sessions.get(sessionId);
      const amount = s ? s.hostWei - s.hostClaimed : 0n;
      if (!s || amount <= 0n) throw simulatedRevert('NothingToClaim', 'claimHost');
      s.hostClaimed += amount;
      return amount;
    },
    summary(sessionId) {
      const s = sessions.get(sessionId);
      if (!s) return null;
      return { hitCount: s.state.hitCount, hostWei: s.hostWei, poolWei: s.state.tipPool, contributors: [...s.hitsBy.values()], tips: [...s.tips] };
    },
    start() {
      if (interval !== null) return;
      interval = setInterval(mine, blockMs);
      unsubscribeBus = bus?.subscribe(onBus) ?? null;
    },
    stop() {
      if (interval === null) return;
      clearInterval(interval);
      interval = null;
      unsubscribeBus?.();
      unsubscribeBus = null;
      // Nothing will mine after this: drop tip bookkeeping so waiters and hashes do not pile up.
      pendingTips = [];
      minedTips.clear();
      receiptWaiters.clear();
    },
  };
}
