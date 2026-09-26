/**
 * W19 crowd simulator: N virtual players on a real session, independent of viem so it runs
 * against an in-memory chain in tests.
 *
 * Order of a run, every step logged:
 * 1. Guards: getSession first (not found or finalized: refuse, nothing is spent), then the
 *    plan is priced (`budget.ts`) and refused above --max-mon or the funder's balance.
 * 2. Keys: one fresh burner per player with notes, written to the keystore BEFORE any funding.
 * 3. Funding in join order. A funder below the 10 MON reserve can move value once per
 *    reserve window, so each transfer is confirmed and the next waits RESERVE_PACING_BLOCKS
 *    heads. A burner plays RESERVE_WINDOW_BLOCKS after its funding lands (Monad checks
 *    balances 3 blocks behind).
 * 4. Play: bar 0 is the first loop after the first player is ready. Each note targets one
 *    block (its step in its bar) and fires when the clock position reaches target − mean
 *    lead, like the phone (W16). A note whose cell is alive at its target (shared
 *    `livePattern`, ADR 0001) is skipped. Local-first nonces, fixed gas tiers and fees.
 * 5. Stop after --minutes, on the abort signal (SIGINT) or as soon as a Finalized event for
 *    the session arrives; queued notes are cancelled, in-flight ones settle.
 * 6. Sweep every burner back to the funder (paced by the reserve rule, retried), marking the
 *    keystore; what fails stays there for `--sweep-only`.
 */
import { formatEther, type Address, type Hash, type Hex, type LocalAccount } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import {
  HIT_GAS_LIMIT,
  HIT_GAS_LIMIT_FIRST,
  HIT_MAX_FEE_PER_GAS,
  RESERVE_PACING_BLOCKS,
  RESERVE_WINDOW_BLOCKS,
  STEPS,
  bitIndex,
  isBelowReserve,
  livePattern,
  stepForBlock,
  type LiveHit,
  type TrackId,
} from '@blockbeat/shared';
import { TRANSFER_GAS } from '../runner';
import { classifyRpcError, percentile } from '../stats';
import { createTokenBucket } from '../tokenBucket';
import { createLead, noteTargetBlock, playStartBlock } from './aim';
import { CHARGED_GAS_PRICE_WEI, checkBudget, describeProjection, notesPerPlayerFor, projectCost } from './budget';
import type { Keystore } from './keystore';
import { planCrowd, type Persona, type PlannedNote } from './persona';

export interface SessionInfo {
  /** 0 when the session does not exist on this contract. */
  startBlock: bigint;
  finalized: boolean;
}

export interface Receipt {
  blockNumber: bigint;
  status: 'success' | 'reverted';
}

export type CrowdHit = LiveHit & { txHash: Hash };

/** Every send uses the fixed fees from @blockbeat/shared; nothing estimates gas. */
export interface CrowdChain {
  getBlockNumber(): Promise<bigint>;
  getBalance(address: Address): Promise<bigint>;
  /** Pending nonce. */
  getNonce(address: Address): Promise<number>;
  getSession(sessionId: bigint): Promise<SessionInfo>;
  getRecentHits(sessionId: bigint, fromBlock: bigint, toBlock: bigint): Promise<CrowdHit[]>;
  sendTransfer(from: LocalAccount, to: Address, valueWei: bigint, nonce: number): Promise<Hash>;
  sendHit(from: LocalAccount, sessionId: bigint, track: TrackId, note: number, nonce: number, gas: bigint): Promise<Hash>;
  getReceipt(hash: Hash): Promise<Receipt | null>;
  watchHeads(cb: (block: bigint) => void): () => void;
  watchHits(sessionId: bigint, cb: (hit: CrowdHit) => void): () => void;
  watchFinalized(sessionId: bigint, cb: () => void): () => void;
}

export interface CrowdOptions {
  chainId: number;
  contract: Address;
  sessionId: bigint;
  players: number;
  minutes: number;
  maxWei: bigint;
  seed: number;
  blockMs: number;
  hitTimeoutMs: number;
  funderKey: Hex;
  /** Per-player allowance; null = the largest one --max-mon allows (capped at a drip). */
  notesPerPlayer: number | null;
  rps: number;
  lifetimeBars: number;
  /** 0 = no voice cap. */
  maxLivePerTrack: number;
  keystore: Keystore;
  log: (line: string) => void;
  signal?: AbortSignal;
  /** Called with every burner key so the caller's log redaction knows it. */
  onSecret?: (key: Hex) => void;
  /** How often the session is re-read in case a Finalized event was missed (default 10 s). */
  sessionCheckMs?: number;
}

export type NoteStatus = 'confirmed' | 'reverted' | 'send-failed' | 'timeout' | 'skipped-alive' | 'skipped-late' | 'skipped-not-ready' | 'cancelled';

export interface NoteRecord {
  player: number;
  bar: number;
  step: number;
  track: TrackId;
  note: number;
  targetBlock: bigint;
  status: NoteStatus;
  sentAt?: number;
  txHash?: Hash;
  gas?: bigint;
  landedBlock?: bigint;
  landedStep?: number;
  latencyMs?: number;
  error?: string;
}

export interface CrowdSummary {
  bars: number;
  planned: number;
  sent: number;
  confirmed: number;
  reverted: number;
  sendFailed: number;
  timeout: number;
  skippedAlive: number;
  skippedLate: number;
  skippedNotReady: number;
  cancelled: number;
  onStep: number;
  /** Confirmed notes that landed on their aimed step, over confirmed notes. */
  onStepRatio: number;
  latencyP50Ms: number | null;
  latencyP95Ms: number | null;
  /** Fees charged: every accepted hit and transfer at its gas limit × 102 gwei. */
  spentWei: bigint;
}

export interface SweepResult {
  sweptWei: bigint;
  failed: Address[];
  skippedRuns: number;
}

export type StopReason = 'done' | 'stopped' | 'finalized';

export interface CrowdResult {
  startedAt: string;
  durationMs: number;
  stopReason: StopReason;
  funder: Address;
  funderBeforeWei: bigint;
  funderAfterWei: bigint;
  keystoreFile: string;
  players: Address[];
  personas: Persona[];
  funded: number;
  notesPerPlayer: number;
  projectedWei: bigint;
  records: NoteRecord[];
  statusLines: string[];
  summary: CrowdSummary;
  sweep: SweepResult;
}

export class CrowdAbortError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CrowdAbortError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** The mistake that cost 2.4 MON: never fund players for a session that cannot take hits. */
export function assertPlayable(sessionId: bigint, session: SessionInfo): void {
  if (session.startBlock === 0n) throw new CrowdAbortError(`session ${sessionId.toString()} was not found on this contract; start one first`);
  if (session.finalized) throw new CrowdAbortError(`session ${sessionId.toString()} is finalized; hits would revert. Start a new session`);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const SWEEP_ATTEMPTS = 3;
const RECEIPT_TIMEOUT_MS = 60_000;
/** A sweep keeps the max-fee gas of its own transfer; the difference to 102 gwei stays as dust. */
const SWEEP_GAS_WEI = TRANSFER_GAS * HIT_MAX_FEE_PER_GAS;

/** Wei as MON with 4 decimals, rounded ("0.4120"). */
export function formatMon(wei: bigint): string {
  const negative = wei < 0n;
  const abs = negative ? -wei : wei;
  const tenThousandths = (abs + 50_000_000_000_000n) / 100_000_000_000_000n;
  const text = `${tenThousandths / 10_000n}.${(tenThousandths % 10_000n).toString().padStart(4, '0')}`;
  return negative ? `-${text}` : text;
}

async function waitReceipt(chain: CrowdChain, hash: Hash, blockMs: number, take: () => Promise<void>, timeoutMs = RECEIPT_TIMEOUT_MS): Promise<Receipt> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await sleep(blockMs);
    await take();
    const receipt = await chain.getReceipt(hash);
    if (receipt !== null) return receipt;
    if (Date.now() > deadline) throw new Error(`transaction ${hash} was not mined within ${timeoutMs} ms`);
  }
}

/** Polls the head until it reaches `target` (bounded, so a stalled node cannot hang a sweep). */
async function waitForHead(chain: CrowdChain, target: bigint, blockMs: number, take: () => Promise<void>): Promise<bigint> {
  const deadline = Date.now() + 8 * RESERVE_PACING_BLOCKS * blockMs + 10_000;
  for (;;) {
    await take();
    const head = await chain.getBlockNumber();
    if (head >= target || Date.now() > deadline) return head;
    await sleep(blockMs);
  }
}

interface SweepOneInput {
  chain: CrowdChain;
  account: LocalAccount;
  to: Address;
  blockMs: number;
  take: () => Promise<void>;
  log: (line: string) => void;
  /** Head of the burner's last send, if known: the sweep waits out its reserve window. */
  lastSendHead: bigint | null;
}

/**
 * Empties one burner into `to`. The burner is below the reserve, so the transfer only lands if
 * the burner sent nothing in the last 3 blocks: each attempt waits RESERVE_PACING_BLOCKS heads
 * after the burner's last send, and a failed attempt is retried the same way.
 */
async function sweepOne(input: SweepOneInput): Promise<{ ok: boolean; wei: bigint }> {
  const { chain, account, to, blockMs, take, log } = input;
  let lastSend = input.lastSendHead;
  for (let attempt = 1; attempt <= SWEEP_ATTEMPTS; attempt++) {
    if (lastSend !== null) await waitForHead(chain, lastSend + BigInt(RESERVE_PACING_BLOCKS), blockMs, take);
    await take();
    const balance = await chain.getBalance(account.address);
    if (balance <= SWEEP_GAS_WEI) return { ok: true, wei: 0n };
    const value = balance - SWEEP_GAS_WEI;
    try {
      await take();
      const nonce = await chain.getNonce(account.address);
      await take();
      const hash = await chain.sendTransfer(account, to, value, nonce);
      const receipt = await waitReceipt(chain, hash, blockMs, take);
      if (receipt.status === 'success') return { ok: true, wei: value };
      log(`sweep ${account.address}: attempt ${attempt} reverted in block ${receipt.blockNumber}`);
      lastSend = receipt.blockNumber;
    } catch (error) {
      log(`sweep ${account.address}: attempt ${attempt} failed (${classifyRpcError(error).message})`);
      await take();
      lastSend = await chain.getBlockNumber();
    }
  }
  return { ok: false, wei: 0n };
}

export interface SweepPendingInput {
  keystore: Keystore;
  chain: CrowdChain;
  chainId: number;
  blockMs: number;
  log: (line: string) => void;
  rps?: number;
  onSecret?: (key: Hex) => void;
}

/** `--sweep-only`: returns what every unswept burner of every saved run on this chain holds. */
export async function sweepPending(input: SweepPendingInput): Promise<SweepResult> {
  const bucket = createTokenBucket({ ratePerSec: input.rps ?? 15 });
  const take = () => bucket.take();
  let sweptWei = 0n;
  const failed: Address[] = [];
  let skippedRuns = 0;
  for (const { file, run } of input.keystore.pending()) {
    if (run.chainId !== input.chainId) {
      input.log(`skip ${file}: chain ${run.chainId}, this RPC is chain ${input.chainId}`);
      skippedRuns += 1;
      continue;
    }
    const todo = run.players.filter((p) => !p.swept);
    input.log(`sweep ${file}: ${todo.length} burner(s) of session ${run.sessionId} back to ${run.funder}`);
    const results = await Promise.all(
      todo.map(async (p) => {
        input.onSecret?.(p.privateKey);
        const account = privateKeyToAccount(p.privateKey);
        const r = await sweepOne({ chain: input.chain, account, to: run.funder, blockMs: input.blockMs, take, log: input.log, lastSendHead: null });
        return { address: p.address, ...r };
      }),
    );
    for (const r of results) {
      if (r.ok) {
        input.keystore.markSwept(file, r.address);
        sweptWei += r.wei;
      } else {
        failed.push(r.address);
      }
    }
  }
  input.log(`swept ${formatEther(sweptWei)} MON${failed.length ? `; ${failed.length} burner(s) still hold MON, run --sweep-only again` : ''}`);
  return { sweptWei, failed, skippedRuns };
}

interface Player {
  persona: Persona;
  account: LocalAccount;
  fundWei: bigint;
  /** Head from which the burner may send (funding landed + the reserve window); null until funded. */
  readyBlock: bigint | null;
  /** Local-first nonce (a fresh burner starts at 0); null means read it before the next send. */
  nonce: number | null;
  /** Hits the RPC accepted since the last nonce reset; the first one pays the first-hit tier. */
  accepted: number;
  landed: boolean;
  lastSendHead: bigint | null;
  /** Serialises this player's sends so its nonces stay in order. */
  queue: Promise<void>;
}

interface Queued {
  planned: PlannedNote;
  target: bigint;
  reaimed: boolean;
}

interface InFlight {
  record: NoteRecord;
  /** Clock position (blocks since bar 0) when the send fired. */
  sendPos: number;
  player: Player;
  settle: () => void;
  timer: ReturnType<typeof setTimeout> | null;
}

export async function runCrowd(opts: CrowdOptions, chain: CrowdChain): Promise<CrowdResult> {
  const { log } = opts;
  const startedAtMs = Date.now();
  const bucket = createTokenBucket({ ratePerSec: opts.rps });
  const take = () => bucket.take();
  const rpc = async <T>(f: () => Promise<T>): Promise<T> => {
    await take();
    return f();
  };

  // ---- 1. Guards
  const session = await rpc(() => chain.getSession(opts.sessionId));
  assertPlayable(opts.sessionId, session);
  const startBlock = session.startBlock;
  const funder = privateKeyToAccount(opts.funderKey);
  const funderBeforeWei = await rpc(() => chain.getBalance(funder.address));
  const bars = Math.max(1, Math.round((opts.minutes * 60_000) / (STEPS * opts.blockMs)));
  const notesPerPlayer = opts.notesPerPlayer ?? notesPerPlayerFor(opts.maxWei, opts.players);
  const plan = planCrowd({ seed: opts.seed, players: opts.players, bars, notesPerPlayer });
  const projection = projectCost(plan);
  log(`crowd: session ${opts.sessionId.toString()} (start block ${startBlock.toString()}), ${opts.players} players for ${bars} bars (${opts.minutes} min), up to ${notesPerPlayer} notes each; funder ${funder.address} holds ${formatEther(funderBeforeWei)} MON`);
  log(describeProjection(projection, opts.maxWei));
  const budget = checkBudget(projection, { maxWei: opts.maxWei, funderBalanceWei: funderBeforeWei });
  if (!budget.ok) throw new CrowdAbortError(`${budget.reason}; nothing was funded`);

  // ---- 2. Keys, on disk before any MON moves
  const burners = plan.personas.flatMap((persona) => {
    const fundWei = projection.fundWei[persona.id] ?? 0n;
    if (fundWei === 0n) return [];
    const privateKey = generatePrivateKey();
    opts.onSecret?.(privateKey);
    const player: Player = { persona, account: privateKeyToAccount(privateKey), fundWei, readyBlock: null, nonce: 0, accepted: 0, landed: false, lastSendHead: null, queue: Promise.resolve() };
    return [{ privateKey, player }];
  });
  const players = burners.map((b) => b.player);
  const keystoreFile = opts.keystore.create({
    chainId: opts.chainId,
    contract: opts.contract,
    sessionId: opts.sessionId,
    funder: funder.address,
    players: burners.map((b) => ({ address: b.player.account.address, privateKey: b.privateKey })),
  });
  log(`keys: ${players.length} burners saved to ${keystoreFile} (mode 600); if anything fails, run: pnpm --filter scripts crowd -- --sweep-only`);
  const byPersona = new Map(players.map((p) => [p.persona.id, p]));

  // ---- Chain state: heads, the session's hits (the live layer), Finalized
  let stopReason: StopReason | null = null;
  const stop = (why: StopReason): void => {
    if (stopReason !== null) return;
    stopReason = why;
    log(`crowd: stopping (${why === 'finalized' ? 'the session was finalized' : why === 'stopped' ? 'stop requested' : 'time is up'})`);
  };
  const onAbort = (): void => stop('stopped');
  if (opts.signal?.aborted) stop('stopped');
  opts.signal?.addEventListener('abort', onAbort);

  let head = await rpc(() => chain.getBlockNumber());
  let headSeenAt = Date.now();
  const stopHeads = chain.watchHeads((block) => {
    if (block <= head) return;
    head = block;
    headSeenAt = Date.now();
  });
  const history: CrowdHit[] = [];
  const seen = new Set<string>();
  const addHit = (h: CrowdHit): void => {
    const key = `${h.txHash}:${h.logIndex}`;
    if (seen.has(key)) return;
    seen.add(key);
    history.push(h);
  };
  const records: NoteRecord[] = [];
  const pending = new Map<Hash, InFlight>();
  const early = new Map<Hash, { hit: CrowdHit; seenAt: number }>();
  const lead = createLead();
  let playStart: bigint | null = null;
  const settleFromLog = (entry: InFlight, hit: CrowdHit, seenAt: number): void => {
    if (entry.timer !== null) clearTimeout(entry.timer);
    entry.player.landed = true;
    entry.record.status = 'confirmed';
    entry.record.landedBlock = hit.blockNumber;
    entry.record.landedStep = hit.step;
    entry.record.latencyMs = seenAt - (entry.record.sentAt ?? seenAt);
    if (playStart !== null) lead.record(Number(hit.blockNumber - playStart) - entry.sendPos);
    entry.settle();
  };
  const stopHits = chain.watchHits(opts.sessionId, (hit) => {
    const seenAt = Date.now();
    addHit(hit);
    const entry = pending.get(hit.txHash);
    if (entry) {
      pending.delete(hit.txHash);
      settleFromLog(entry, hit, seenAt);
    } else {
      early.set(hit.txHash, { hit, seenAt });
    }
  });
  const stopFinalized = chain.watchFinalized(opts.sessionId, () => stop('finalized'));

  let spentWei = 0n;
  const settles: Promise<void>[] = [];
  let funding: Promise<void> = Promise.resolve();
  const statusLines: string[] = [];
  let sweep: SweepResult = { sweptWei: 0n, failed: [], skippedRuns: 0 };
  let funderAfterWei = funderBeforeWei;

  try {
    // Notes that were already playing before the crowd came in (the replay window of ADR 0001).
    const windowBlocks = BigInt(opts.lifetimeBars * STEPS + STEPS);
    for (const h of await rpc(() => chain.getRecentHits(opts.sessionId, head > windowBlocks ? head - windowBlocks : 0n, head))) addHit(h);

    // ---- 3. Funding, in join order
    const paced = isBelowReserve(funderBeforeWei, projection.funderNeedsWei);
    if (paced) log(`funder is below the 10 MON reserve: one funding transfer every ${RESERVE_PACING_BLOCKS} blocks, each confirmed`);
    let signalReady: (() => void) | null = null;
    const firstReady = new Promise<void>((resolve) => (signalReady = resolve));
    const markReady = (p: Player, landedAt: bigint): void => {
      p.readyBlock = landedAt + BigInt(RESERVE_WINDOW_BLOCKS);
      signalReady?.();
      signalReady = null;
    };
    funding = (async () => {
      const unconfirmed: Array<{ player: Player; hash: Hash }> = [];
      let nonce: number | null = null;
      for (const p of players) {
        if (stopReason !== null) break;
        try {
          // The drip server shares this key: read the nonce for every paced transfer.
          const n: number = paced || nonce === null ? await rpc(() => chain.getNonce(funder.address)) : nonce;
          const hash = await rpc(() => chain.sendTransfer(funder, p.account.address, p.fundWei, n));
          nonce = n + 1;
          spentWei += TRANSFER_GAS * CHARGED_GAS_PRICE_WEI;
          if (!paced) {
            unconfirmed.push({ player: p, hash });
            continue;
          }
          const receipt = await waitReceipt(chain, hash, opts.blockMs, take);
          if (receipt.status === 'success') markReady(p, receipt.blockNumber);
          else log(`funding player ${p.persona.id} reverted in block ${receipt.blockNumber}; it sits out`);
          await waitForHead(chain, receipt.blockNumber + BigInt(RESERVE_PACING_BLOCKS), opts.blockMs, take);
        } catch (error) {
          log(`funding player ${p.persona.id} failed (${classifyRpcError(error).message}); it sits out`);
          nonce = null;
        }
      }
      for (const { player, hash } of unconfirmed) {
        try {
          const receipt = await waitReceipt(chain, hash, opts.blockMs, take);
          if (receipt.status === 'success') markReady(player, receipt.blockNumber);
          else log(`funding player ${player.persona.id} reverted; it sits out`);
        } catch (error) {
          log(`funding player ${player.persona.id} not confirmed (${classifyRpcError(error).message}); it sits out`);
        }
      }
    })();
    await Promise.race([firstReady, funding]);
    const firstReadyBlock = players.reduce<bigint | null>((acc, p) => (p.readyBlock !== null && (acc === null || p.readyBlock < acc) ? p.readyBlock : acc), null);

    // ---- 4. Play
    const queue: Queued[] = [];
    let sentCount = 0;
    const pendingCells = new Set<string>();
    const cellOf = (q: Queued): string => `${q.target.toString()}:${q.planned.track}:${q.planned.note}`;
    const position = (): number => (playStart === null ? 0 : Number(head - playStart) + Math.min(3, (Date.now() - headSeenAt) / opts.blockMs));
    const activePlayers = (bar: number): number => {
      if (playStart === null) return 0;
      const barEnd = noteTargetBlock(playStart, bar, STEPS - 1);
      return players.filter((p) => p.readyBlock !== null && p.readyBlock <= barEnd && bar >= p.persona.joinBar && bar < (p.persona.leaveBar ?? bars)).length;
    };
    const statusLine = (bar: number): string => {
      const confirmed = records.filter((r) => r.status === 'confirmed');
      const onStep = confirmed.filter((r) => r.landedStep === r.step).length;
      const ratio = confirmed.length === 0 ? 0 : Math.round((100 * onStep) / confirmed.length);
      return `crowd | bar ${bar + 1}/${bars} | players ${activePlayers(bar)}/${opts.players} | sent ${sentCount} | confirmed ${confirmed.length} | on-step ${ratio}% | spent ${formatMon(spentWei)} MON`;
    };
    const record = (q: Queued, status: NoteStatus): NoteRecord => {
      const r: NoteRecord = { ...q.planned, targetBlock: q.target, status };
      records.push(r);
      return r;
    };
    const aliveAt = (q: Queued): boolean => {
      if (pendingCells.has(cellOf(q))) return true;
      const { step, track, note } = q.planned;
      const live = livePattern(history, q.target, opts.lifetimeBars, opts.maxLivePerTrack > 0 ? { maxLivePerTrack: opts.maxLivePerTrack } : {});
      return (((live.steps[step] ?? 0n) >> bitIndex(track, note)) & 1n) === 1n;
    };

    const fire = (q: Queued, player: Player, sendPos: number): void => {
      const cell = cellOf(q);
      pendingCells.add(cell);
      const r = record(q, 'cancelled');
      const done = new Promise<void>((resolve) => {
        const settle = (): void => {
          pendingCells.delete(cell);
          resolve();
        };
        player.queue = player.queue.then(async () => {
          if (stopReason !== null) return settle();
          const gas = player.accepted === 0 && !player.landed ? HIT_GAS_LIMIT_FIRST : HIT_GAS_LIMIT;
          let hash: Hash;
          try {
            const nonce = player.nonce ?? (await rpc(() => chain.getNonce(player.account.address)));
            await take();
            r.sentAt = Date.now();
            r.gas = gas;
            hash = await chain.sendHit(player.account, opts.sessionId, q.planned.track, q.planned.note, nonce, gas);
            player.nonce = nonce + 1;
            player.accepted += 1;
            player.lastSendHead = head;
            sentCount += 1;
            spentWei += gas * CHARGED_GAS_PRICE_WEI;
          } catch (error) {
            r.status = 'send-failed';
            r.error = classifyRpcError(error).message;
            player.nonce = null;
            return settle();
          }
          r.status = 'timeout';
          r.txHash = hash;
          const entry: InFlight = { record: r, sendPos, player, settle, timer: null };
          const earlyLog = early.get(hash);
          if (earlyLog) {
            early.delete(hash);
            return settleFromLog(entry, earlyLog.hit, earlyLog.seenAt);
          }
          entry.timer = setTimeout(() => {
            void (async () => {
              if (!pending.delete(hash)) return;
              try {
                const receipt = await rpc(() => chain.getReceipt(hash));
                if (receipt === null) {
                  // It may still land, or never: read the nonce again, and pay the first tier again if nothing landed.
                  player.nonce = null;
                  if (!player.landed) player.accepted = 0;
                } else if (receipt.status === 'reverted') {
                  r.status = 'reverted';
                  r.landedBlock = receipt.blockNumber;
                } else {
                  player.landed = true;
                  r.status = 'confirmed';
                  r.landedBlock = receipt.blockNumber;
                  r.landedStep = stepForBlock(startBlock, receipt.blockNumber);
                  r.latencyMs = Date.now() - (r.sentAt ?? Date.now());
                }
              } catch (error) {
                r.error = classifyRpcError(error).message;
                player.nonce = null;
              }
              settle();
            })();
          }, opts.hitTimeoutMs);
          pending.set(hash, entry);
        });
      });
      settles.push(done);
    };

    if (firstReadyBlock === null) {
      if (stopReason === null) log('no player could be funded; nothing to play');
    } else if (stopReason === null) {
      const origin = playStartBlock(startBlock, firstReadyBlock > head ? firstReadyBlock : head);
      playStart = origin;
      log(`play: bar 1 starts at block ${origin.toString()}; players join over the first ${Math.ceil(Math.max(...plan.personas.map((p) => p.joinAtMs)) / 1000)} s`);
      const tickMs = Math.max(2, Math.min(10, Math.floor(opts.blockMs / 4)));
      let nextBar = 0;
      let noteIndex = 0;
      let statusBar = -1;
      const sessionCheckMs = opts.sessionCheckMs ?? 10_000;
      let lastSessionCheck = Date.now();
      while (stopReason === null) {
        if (Date.now() - lastSessionCheck >= sessionCheckMs) {
          lastSessionCheck = Date.now();
          void rpc(() => chain.getSession(opts.sessionId)).then(
            (s) => {
              if (s.finalized) stop('finalized');
            },
            (error: unknown) => log(`session check failed (${classifyRpcError(error).message})`),
          );
        }
        const pos = position();
        const barNow = Math.floor(pos / STEPS);
        if (pos >= 0 && barNow > statusBar) {
          if (statusBar >= 0) {
            const line = statusLine(statusBar);
            statusLines.push(line);
            log(line);
          }
          statusBar = barNow;
        }
        if (barNow >= bars) {
          stop('done');
          break;
        }
        // Queue a bar one bar ahead, so its first steps get their full lead.
        while (nextBar < bars && pos >= STEPS * (nextBar - 1)) {
          for (let planned = plan.notes[noteIndex]; planned !== undefined && planned.bar === nextBar; planned = plan.notes[noteIndex]) {
            noteIndex += 1;
            queue.push({ planned, target: noteTargetBlock(origin, planned.bar, planned.step), reaimed: false });
          }
          nextBar += 1;
        }
        const m = lead.mean();
        for (let i = 0; i < queue.length; ) {
          const q = queue[i];
          if (q === undefined) break;
          const rel = Number(q.target - origin);
          if (pos < rel - m) {
            i += 1;
            continue;
          }
          queue.splice(i, 1);
          const player = byPersona.get(q.planned.player);
          if (!player || player.readyBlock === null || head < player.readyBlock) {
            record(q, 'skipped-not-ready');
          } else if (pos > rel - m + 1) {
            // The send window passed (a stalled loop): aim at the same step one loop later, once.
            if (!q.reaimed && q.planned.bar + 1 < bars) queue.push({ ...q, target: q.target + BigInt(STEPS), reaimed: true });
            else record(q, 'skipped-late');
          } else if (aliveAt(q)) {
            record(q, 'skipped-alive');
          } else {
            fire(q, player, pos);
          }
        }
        await sleep(tickMs);
      }
      for (const q of queue) record(q, 'cancelled');
      queue.length = 0;
      if (statusBar >= 0 && statusBar < bars) {
        const line = statusLine(statusBar);
        statusLines.push(line);
        log(line);
      }
    }

    // ---- 5. Settle: queued sends drop out, in-flight hits confirm or time out.
    await funding;
    await Promise.all(settles);

    // ---- 6. Sweep (every burner: a funding whose receipt timed out may still have landed)
    const results = await Promise.all(
      players.map(async (p) => {
        const r = await sweepOne({ chain, account: p.account, to: funder.address, blockMs: opts.blockMs, take, log, lastSendHead: p.lastSendHead ?? p.readyBlock });
        if (r.ok) opts.keystore.markSwept(keystoreFile, p.account.address);
        else log(`sweep ${p.account.address} failed ${SWEEP_ATTEMPTS} times; its MON stays in ${keystoreFile}`);
        if (r.wei > 0n) spentWei += TRANSFER_GAS * CHARGED_GAS_PRICE_WEI;
        return { address: p.account.address, ...r };
      }),
    );
    sweep = { sweptWei: results.reduce((a, r) => a + r.wei, 0n), failed: results.filter((r) => !r.ok).map((r) => r.address), skippedRuns: 0 };
    log(`swept ${formatEther(sweep.sweptWei)} MON back to the funder from ${results.filter((r) => r.ok).length}/${players.length} burners${sweep.failed.length ? `; run --sweep-only for the other ${sweep.failed.length}` : ''}`);
    funderAfterWei = await rpc(() => chain.getBalance(funder.address));
  } finally {
    stopHeads();
    stopHits();
    stopFinalized();
    opts.signal?.removeEventListener('abort', onAbort);
    for (const e of pending.values()) if (e.timer !== null) clearTimeout(e.timer);
  }

  return {
    startedAt: new Date(startedAtMs).toISOString(),
    durationMs: Date.now() - startedAtMs,
    stopReason: stopReason ?? 'done',
    funder: funder.address,
    funderBeforeWei,
    funderAfterWei,
    keystoreFile,
    players: players.map((p) => p.account.address),
    personas: plan.personas,
    funded: players.filter((p) => p.readyBlock !== null).length,
    notesPerPlayer,
    projectedWei: projection.totalWei,
    records,
    statusLines,
    summary: summarize(records, plan.notes.length, bars, spentWei),
    sweep,
  };
}

export function summarize(records: readonly NoteRecord[], planned: number, bars: number, spentWei: bigint): CrowdSummary {
  const count = (s: NoteStatus): number => records.filter((r) => r.status === s).length;
  const confirmed = records.filter((r) => r.status === 'confirmed');
  const onStep = confirmed.filter((r) => r.landedStep === r.step).length;
  const latencies = confirmed.map((r) => r.latencyMs).filter((x): x is number => x !== undefined);
  return {
    bars,
    planned,
    sent: records.filter((r) => r.txHash !== undefined).length,
    confirmed: confirmed.length,
    reverted: count('reverted'),
    sendFailed: count('send-failed'),
    timeout: count('timeout'),
    skippedAlive: count('skipped-alive'),
    skippedLate: count('skipped-late'),
    skippedNotReady: count('skipped-not-ready'),
    cancelled: count('cancelled'),
    onStep,
    onStepRatio: confirmed.length === 0 ? 0 : onStep / confirmed.length,
    latencyP50Ms: percentile(latencies, 50),
    latencyP95Ms: percentile(latencies, 95),
    spentWei,
  };
}
