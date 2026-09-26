/**
 * The bar loop. Wired from main.ts with real clients; unit-testable with fakes.
 * Once per bar (every 16 blocks): read the session (review H4: a finalized session ends
 * the loop instead of feeding reverting hits), read the pattern, ask the brain, schedule
 * the hits for the next bar, print one status line.
 *
 * W13: the grid is the LIVE layer at the block the next bar starts (notes decay after 8 bars).
 *
 * W17: the DJ plays a set. A section clock (intro 4, build 4, peak 8, breakdown 4 bars) starts at
 * the first bar the DJ plans; each bar the brain gets the section, key and progression and plays
 * a phrase of up to AGENT_MAX_NOTES_PER_BAR notes. The status line shows the section, the hits
 * sent, the on-step ratio and the MON spent.
 */
import { NOTE_LIFETIME_BARS, STEPS } from '@blockbeat/shared';
import { formatEther } from 'viem';
import { DEFAULT_NOTES_PER_BAR } from './lib/brain/types';
import { musicAt, musicLabel, type MusicOptions } from './lib/music/arrangement';
import type { Brain } from './lib/brain/types';
import type { FallbackBrain } from './lib/brain/fallback';
import type { BlockClock } from './lib/blockClock';
import type { Logger } from './lib/log';
import { overlayAgentCells, renderGrid, type PatternReader } from './lib/pattern';
import type { Scheduler } from './lib/scheduler';

export interface AgentLoopOptions {
  clock: BlockClock;
  reader: PatternReader;
  brain: Brain | FallbackBrain;
  scheduler: Scheduler;
  startBlock: bigint;
  log: Logger;
  /** Stop after this many bars; null runs until stop(). */
  bars: number | null;
  /** Print the grid under the status line. */
  showGrid?: boolean;
  /** Read each status line; a function so the identity can land while the loop runs (review H9). */
  identityLabel: string | (() => string);
  /** Read once per bar; when `finalized` the loop stops itself (review H4). */
  readSession: () => Promise<{ finalized: boolean }>;
  /** W17: key and progression of the set (default A minor, i-VI-III-VII). */
  music?: MusicOptions;
  /** W17: AGENT_MAX_NOTES_PER_BAR (default 8). */
  maxNotesPerBar?: number;
  /** W17: note lifetime in bars, the stage's NEXT_PUBLIC_NOTE_LIFETIME_BARS (0 = no decay). */
  lifetimeBars?: number;
  /** W17: the arrangement bar the set opens on (AGENT_SET_START_BAR; 0 = the intro). */
  startBar?: number;
}

/** MON with 4 decimals for the status line. */
export function formatMon(wei: bigint): string {
  return Number(formatEther(wei)).toFixed(4);
}

export interface AgentLoop {
  start(): void;
  /** Resolves once `bars` bars have been handled, the session is finalized, or stop() ran. */
  done: Promise<void>;
  stop(): Promise<void>;
  barsHandled(): number;
  /** True once a bar found the session finalized. */
  finalized(): boolean;
}

function isFallback(brain: Brain | FallbackBrain): brain is FallbackBrain {
  return 'lastMode' in brain;
}

export function createAgentLoop(options: AgentLoopOptions): AgentLoop {
  const { clock, reader, brain, scheduler, startBlock, log, bars, readSession } = options;
  const identityLabel = typeof options.identityLabel === 'function' ? options.identityLabel : () => options.identityLabel as string;
  let handled = 0;
  let lastBarStart: bigint | null = null;
  /** W17: the planned bar the set started on (arrangement bar 0). */
  let firstPlannedBar: bigint | null = null;
  let busy = false;
  let finalized = false;
  let unsubscribe: (() => void) | null = null;
  let resolveDone: () => void = () => undefined;
  const done = new Promise<void>((r) => {
    resolveDone = r;
  });

  function status(block: bigint, barIndex: bigint, section: string, extra: string): string {
    const s = scheduler.stats();
    const pct = s.confirmed === 0 ? '-' : `${Math.round(s.matchRate * 100)}%`;
    // W14: "gemini <model>" or "rules (gemini timeout)": which brain played, never a key.
    const mode = isFallback(brain) ? brain.lastLabel() : brain.model ? `${brain.mode} ${brain.model}` : brain.mode;
    // `sent`, `budget` and `brain` are parsed by the stage's DJ panel (apps/web/lib/agent/manager.ts): keep their shape.
    return `bar ${barIndex} | block ${block} | ${section} | sent ${s.sent} | on-step ${s.matched}/${s.confirmed} (${pct}) | MON ${formatMon(s.feeWei)} | budget ${s.budgetLeft} | brain ${mode} | clock ${clock.source()} ${Math.round(clock.measuredBlockMs())}ms | ${identityLabel()} | ${extra}`;
  }

  async function runBar(barStart: bigint): Promise<void> {
    const barIndex = (barStart - startBlock) / BigInt(STEPS);
    const session = await readSession();
    if (session.finalized) {
      finalized = true;
      log.warn(`bar ${barIndex}: session is finalized; no more hits (every further hit would revert with SessionFinalized)`);
      unsubscribe?.();
      unsubscribe = null;
      scheduler.stop();
      resolveDone();
      return;
    }
    // Hits still in flight land before the next bar plays: show them to the brain as on,
    // otherwise it would plan the same fill twice and the second hit would toggle it off.
    const nextBar = barStart + BigInt(STEPS);
    // W14b (testnet session 4): a hit that already landed leaves pending() before the log reader
    // may have ingested it, and an off-step landing sits on its ACTUAL step. Overlay the agent's own
    // landings from the last two bars at the step they landed on (toggle-offs excluded), so the
    // brain never re-plans a note that is already sounding.
    // Read first, then take pending() and results() in one synchronous snapshot: a receipt that
    // arrives during the read moves a hit from one to the other (testnet session 5).
    const read = await reader.read(barStart, nextBar);
    const recentFrom = barStart - 2n * BigInt(STEPS);
    // W17: on a live grid every landing sounds, `on` or not (ADR 0001); a DJ refresh lands with on=false.
    const landed = scheduler
      .results()
      .filter((r) => (read.decay || r.on) && r.landedBlock >= recentFrom)
      .map((r) => ({ step: r.actualStep, track: r.track, note: r.note }));
    const grid = overlayAgentCells(read, [...scheduler.pending(), ...landed]);
    const budgetLeft = scheduler.stats().budgetLeft;
    const plannedBar = barIndex + 1n;
    firstPlannedBar ??= plannedBar;
    const music = musicAt((options.startBar ?? 0) + Number(plannedBar - firstPlannedBar), options.music);
    const additions = await brain.plan(grid, {
      bar: Number(barIndex),
      budgetLeft,
      music,
      maxNotesPerBar: options.maxNotesPerBar ?? DEFAULT_NOTES_PER_BAR,
      lifetimeBars: options.lifetimeBars ?? NOTE_LIFETIME_BARS,
    });
    // W13 (coordinator, testnet): a slow brain can answer after some send blocks passed. Those
    // notes are re-planned for the same step of the following bar instead of being skipped (the
    // pending overlay keeps the next bar's plan from doubling them).
    const lead = BigInt(scheduler.leadBlocks());
    const now = clock.currentBlock();
    const late = additions.filter((a) => nextBar + BigInt(a.step) - lead < now);
    const planned = scheduler.scheduleBar(late.length === 0 ? additions : additions.filter((a) => !late.includes(a)), nextBar);
    if (late.length > 0) {
      const following = nextBar + BigInt(STEPS);
      log.info(`late plan: ${late.length} addition${late.length === 1 ? '' : 's'} moved to the bar at block ${following} (answered at block ${now})`);
      planned.push(...scheduler.scheduleBar(late, following));
    }
    const plan = planned.length === 0 ? 'no additions' : planned.map((p) => `t${p.track}@${p.step}n${p.note}→b${p.targetBlock}`).join(' ');
    log.info(status(clock.currentBlock(), barIndex, musicLabel(music), `${grid.decay ? `live ${grid.cells.length}` : `notes ${grid.cells.length}`} | next: ${plan}`));
    if (options.showGrid) log.info(`\n${renderGrid(grid)}`);
  }

  function onHead(block: bigint): void {
    if (block < startBlock) return;
    const offset = (block - startBlock) % BigInt(STEPS);
    const barStart = block - offset;
    if (barStart === lastBarStart || busy || finalized) return;
    if (bars !== null && handled >= bars) return;
    lastBarStart = barStart;
    busy = true;
    handled += 1;
    runBar(barStart)
      .catch((error: unknown) => log.warn(`bar at block ${barStart} failed: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => {
        busy = false;
        if (bars !== null && handled >= bars) resolveDone();
      });
  }

  return {
    start() {
      if (unsubscribe) return;
      unsubscribe = clock.onHead(onHead);
    },
    done,
    async stop() {
      unsubscribe?.();
      unsubscribe = null;
      scheduler.stop();
      await scheduler.drain();
      resolveDone();
    },
    barsHandled: () => handled,
    finalized: () => finalized,
  };
}
