/**
 * Pattern reading and the compact text grid the brain reasons about.
 *
 * The chain only stores which bits are on; attribution (human vs agent) comes from the
 * `Hit` events, replayed in order through a ledger that remembers who toggled each cell
 * on last.
 *
 * W13: with note decay the DJ plans on the LIVE layer, the one the room hears: the same
 * shared `livePattern` the stage runs, over the same Hit logs (the ledger keeps them with
 * their block and log index), evaluated at the block the planned bar starts. The recorded
 * layer (`pattern()`, the NFT) is still read so the DJ never clears a bit a human set.
 */
import type { Address } from 'viem';
import {
  STEPS,
  TRACKS,
  TRACK_META,
  blockbeatAbi,
  decodeStep,
  isNote,
  isOn as isBitOn,
  isTrackId,
  livePattern,
  replayFromBlock,
  type LiveHit,
  type Pattern,
  type TrackId,
} from '@blockbeat/shared';

export type Owner = 'human' | 'agent';

export interface GridCell {
  step: number;
  track: TrackId;
  note: number;
  owner: Owner;
  /** W13, live grids only: blocks until the note goes dark. */
  remainingBlocks?: number;
}

export interface Grid {
  cells: GridCell[];
  isEmpty: boolean;
  /** Whether the track has any note on that step (or that exact note when given). */
  isOn(step: number, track: number, note?: number): boolean;
  /** W13: true when `cells` is the live (decaying) layer, false for the recorded pattern. */
  decay: boolean;
  /** W13: the voice cap the live layer was built with (0 = none). */
  maxLivePerTrack: number;
  /**
   * W13: the RECORDED bit is on and a human set it. A hit there XORs it off in the NFT, so
   * the DJ plays another note variant instead.
   */
  recordedHuman(step: number, track: number, note: number): boolean;
}

export type OwnerLookup = (step: number, track: TrackId, note: number) => Owner;

function sortCells(cells: GridCell[]): GridCell[] {
  return cells.sort((a, b) => a.step - b.step || a.track - b.track || a.note - b.note);
}

function makeGrid(cells: GridCell[], extras: Pick<Grid, 'decay' | 'maxLivePerTrack' | 'recordedHuman'>): Grid {
  const on = new Set<string>();
  for (const c of cells) {
    on.add(`${c.step}:${c.track}`);
    on.add(`${c.step}:${c.track}:${c.note}`);
  }
  return {
    cells,
    isEmpty: cells.length === 0,
    isOn: (step, track, note) => on.has(note === undefined ? `${step}:${track}` : `${step}:${track}:${note}`),
    ...extras,
  };
}

/** The recorded layer as a grid (decay off, as before W13): every on bit is a cell. */
export function buildGrid(pattern: Pattern, ownerOf: OwnerLookup): Grid {
  const cells: GridCell[] = [];
  for (let step = 0; step < STEPS; step++) {
    for (const { track, note } of decodeStep(pattern[step] ?? 0n)) cells.push({ step, track, note, owner: ownerOf(step, track, note) });
  }
  return makeGrid(cells, { decay: false, maxLivePerTrack: 0, recordedHuman: recordedHumanOf(pattern, ownerOf) });
}

function recordedHumanOf(recorded: Pattern, ownerOf: OwnerLookup): Grid['recordedHuman'] {
  return (step, track, note) => isTrackId(track) && isBitOn(recorded[step] ?? 0n, track, note) && ownerOf(step, track, note) === 'human';
}

export interface DecaySettings {
  /** 0 = no decay: the DJ plans on the recorded pattern, as before W13. */
  lifetimeBars: number;
  /** 0 = no voice cap. */
  maxLivePerTrack: number;
}

export interface LiveGridInput {
  hits: readonly LiveHit[];
  /** Block the live layer is evaluated at (the start of the bar being planned). */
  at: bigint;
  decay: DecaySettings;
  agentAddress: Address;
  recorded: Pattern;
  recordedOwner: OwnerLookup;
}

/** W13: the live layer as a grid, with the same rule (and voice cap) the stage plays. */
export function buildLiveGrid(input: LiveGridInput): Grid {
  const agent = input.agentAddress.toLowerCase();
  const live = livePattern(input.hits, input.at, input.decay.lifetimeBars, { maxLivePerTrack: input.decay.maxLivePerTrack });
  const cells: GridCell[] = live.cells.map((c) => ({
    step: c.step,
    track: c.track,
    note: c.note,
    owner: c.player.toLowerCase() === agent ? 'agent' : 'human',
    remainingBlocks: c.remainingBlocks,
  }));
  return makeGrid(cells, { decay: true, maxLivePerTrack: input.decay.maxLivePerTrack, recordedHuman: recordedHumanOf(input.recorded, input.recordedOwner) });
}

/** Whole bars (16 blocks) a live cell still plays, counting the one in progress; undefined for a recorded grid. */
export function barsLeft(cell: GridCell | undefined): number | undefined {
  if (cell?.remainingBlocks === undefined) return undefined;
  return Math.ceil(cell.remainingBlocks / STEPS);
}

/** A grid with extra agent cells switched on (hits sent or scheduled but not yet landed). */
export function overlayAgentCells(grid: Grid, cells: ReadonlyArray<{ step: number; track: TrackId; note: number }>): Grid {
  // W14b: a hit can be both pending and landed (or two landings share a cell); add each cell once.
  const seen = new Set<string>();
  const extra: GridCell[] = [];
  for (const c of cells) {
    const key = `${c.step}:${c.track}:${c.note}`;
    if (seen.has(key) || grid.isOn(c.step, c.track, c.note)) continue;
    seen.add(key);
    extra.push({ step: c.step, track: c.track, note: c.note, owner: 'agent' });
  }
  if (extra.length === 0) return grid;
  return makeGrid(sortCells([...grid.cells, ...extra]), { decay: grid.decay, maxLivePerTrack: grid.maxLivePerTrack, recordedHuman: grid.recordedHuman });
}

const LABEL_WIDTH = 6;

/** 8 rows × 16 columns. `.` empty, `H` human, `A` agent (H wins when both share a cell). */
export function renderGrid(grid: Grid): string {
  const rows: string[][] = Array.from({ length: TRACKS }, () => Array.from({ length: STEPS }, () => '.'));
  for (const cell of grid.cells) {
    const row = rows[cell.track];
    if (!row) continue;
    const current = row[cell.step];
    row[cell.step] = cell.owner === 'human' || current === 'H' ? 'H' : 'A';
  }
  const header = `${''.padEnd(LABEL_WIDTH)}${Array.from({ length: STEPS }, (_, i) => String(i % 10)).join('')}`;
  const lines = TRACK_META.map((meta, t) => `${meta.key.padEnd(LABEL_WIDTH)}${(rows[t] ?? []).join('')}`);
  return [header, ...lines].join('\n');
}

export interface LedgerHit {
  step: number;
  track: TrackId;
  note: number;
  player: Address;
  on: boolean;
  /** W13: where the log sits in the chain; hits without it only feed the recorded owners. */
  blockNumber?: bigint;
  logIndex?: number;
}

export interface HitLedger {
  apply(hit: LedgerHit): void;
  ownerOf: OwnerLookup;
  /** W13: every applied hit that carries its block and log index, in apply order. */
  hits(): readonly LiveHit[];
}

export function createHitLedger(agentAddress: Address): HitLedger {
  const agent = agentAddress.toLowerCase();
  const lastOn = new Map<string, Owner>();
  const history: LiveHit[] = [];
  return {
    apply(hit) {
      const key = `${hit.step}:${hit.track}:${hit.note}`;
      if (hit.on) lastOn.set(key, hit.player.toLowerCase() === agent ? 'agent' : 'human');
      else lastOn.delete(key);
      if (hit.blockNumber !== undefined && hit.logIndex !== undefined) {
        history.push({ step: hit.step, track: hit.track, note: hit.note, player: hit.player, on: hit.on, blockNumber: hit.blockNumber, logIndex: hit.logIndex });
      }
    },
    ownerOf: (step, track, note) => lastOn.get(`${step}:${track}:${note}`) ?? 'human',
    hits: () => history,
  };
}

/** Subset of viem PublicClient the reader needs; typed loosely so tests can fake it. */
export interface PatternChain {
  readContract(args: {
    address: Address;
    abi: typeof blockbeatAbi;
    functionName: 'pattern';
    args: readonly [bigint];
    blockNumber: bigint;
  }): Promise<readonly bigint[]>;
  getLogs(args: {
    address: Address;
    event: (typeof blockbeatAbi)[1];
    args: { sessionId: bigint };
    fromBlock: bigint;
    toBlock: bigint;
    strict: true;
  }): Promise<ReadonlyArray<{ blockNumber: bigint | null; logIndex?: number | null; args: Record<string, unknown> }>>;
}

export interface PatternReaderOptions {
  client: PatternChain;
  address: Address;
  sessionId: bigint;
  agentAddress: Address;
  startBlock: bigint;
  /** Max blocks per eth_getLogs call (public RPCs cap the range). */
  chunkSize?: number;
  /** W13: note decay and voice cap; absent or lifetime 0 = plan on the recorded pattern. */
  decay?: DecaySettings;
}

export interface PatternReader {
  /**
   * Logs and pattern as of `toBlock`. With decay the grid is the live layer at `liveAt`
   * (default `toBlock`): the DJ passes the block its planned bar starts.
   */
  read(toBlock: bigint, liveAt?: bigint): Promise<Grid>;
  ledger: HitLedger;
}

const HIT_EVENT = blockbeatAbi[1];

function decodeLedgerHit(args: Record<string, unknown>): LedgerHit {
  const { step, track, note, player, on } = args;
  if (typeof step !== 'number' || step < 0 || step >= STEPS) throw new Error(`Hit log with invalid step ${String(step)}`);
  if (typeof track !== 'number' || !isTrackId(track)) throw new Error(`Hit log with invalid track ${String(track)}`);
  if (typeof note !== 'number' || !isNote(note)) throw new Error(`Hit log with invalid note ${String(note)}`);
  if (typeof player !== 'string') throw new Error('Hit log without player');
  if (typeof on !== 'boolean') throw new Error('Hit log without on flag');
  return { step, track, note, player: player as Address, on };
}

/** Blocks below the replay window a first scan also reads (a lagging node, a bar in flight). */
export const BACKFILL_MARGIN_BLOCKS = 16n;

export function createPatternReader(options: PatternReaderOptions): PatternReader {
  const { client, address, sessionId, startBlock } = options;
  const chunkSize = BigInt(options.chunkSize ?? 100);
  const ledger = createHitLedger(options.agentAddress);
  const decaying = options.decay !== undefined && options.decay.lifetimeBars > 0;
  let scanned: bigint | null = null;

  /**
   * W13 (coordinator, testnet): with decay only the replay window can change the live grid, so
   * the first scan starts there instead of at the session start. On an old session the full scan
   * took 63 s before the first bar. Recorded owners older than the window stay unknown and read
   * as human, the safe side: the DJ then plays another note variant rather than clear a bit.
   */
  function firstBlock(toBlock: bigint): bigint {
    if (!decaying || !options.decay) return startBlock;
    const from = replayFromBlock(toBlock, options.decay.lifetimeBars) - BACKFILL_MARGIN_BLOCKS;
    return from > startBlock ? from : startBlock;
  }

  async function scan(toBlock: bigint): Promise<void> {
    let done: bigint = scanned ?? firstBlock(toBlock) - 1n;
    while (done < toBlock) {
      const fromBlock: bigint = done + 1n;
      const end = fromBlock + chunkSize - 1n < toBlock ? fromBlock + chunkSize - 1n : toBlock;
      const logs = await client.getLogs({ address, event: HIT_EVENT, args: { sessionId }, fromBlock, toBlock: end, strict: true });
      for (const log of logs) {
        if (log.blockNumber === null) throw new Error('pending Hit log in a finalized range');
        // W13 (TS review M1): without its index a hit cannot be ordered for the live layer.
        if (typeof log.logIndex !== 'number') throw new Error(`Hit log at block ${log.blockNumber} without a logIndex`);
        ledger.apply({ ...decodeLedgerHit(log.args), blockNumber: log.blockNumber, logIndex: log.logIndex });
      }
      done = end;
      scanned = end;
    }
    scanned ??= done;
  }

  return {
    ledger,
    async read(toBlock, liveAt) {
      const words = await client.readContract({ address, abi: blockbeatAbi, functionName: 'pattern', args: [sessionId], blockNumber: toBlock });
      await scan(toBlock);
      const decay = options.decay;
      if (!decay || decay.lifetimeBars <= 0) return buildGrid(words, ledger.ownerOf);
      return buildLiveGrid({ hits: ledger.hits(), at: liveAt ?? toBlock, decay, agentAddress: options.agentAddress, recorded: words, recordedOwner: ledger.ownerOf });
    },
  };
}
