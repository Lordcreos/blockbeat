/**
 * Timed hit scheduler. For each planned addition it computes the block on which the note
 * must land (`barStart + step`), sends `hit()` `leadBlocks` blocks earlier using the block
 * clock's prediction, then compares the intended step with the one in the Hit receipt.
 * Enforces the per-session cap and the kill switch at send time.
 */
import type { Hash } from 'viem';
import { STEPS, stepForBlock, type TrackId } from '@blockbeat/shared';
import type { Addition } from './brain/types';
import type { Logger } from './log';

/** What the scheduler needs from the block clock. */
export interface ClockView {
  currentBlock(): bigint;
  measuredBlockMs(): number;
  msUntilBlock(block: bigint): number;
  onHead(cb: (blockNumber: bigint) => void): () => void;
}

export interface HitLanding {
  blockNumber: bigint;
  step: number;
  on: boolean;
  gasUsed: bigint;
  /** W17: MON charged in wei (gas limit × effective gas price), when the receipt told. */
  feeWei?: bigint;
}

export interface HitSender {
  /** Signs and sends hit(sessionId, track, note); resolves with the tx hash. */
  send(track: TrackId, note: number): Promise<Hash>;
  /** Waits for the receipt and decodes the Hit log for that hash. */
  confirm(hash: Hash): Promise<HitLanding>;
}

export interface SchedulerOptions {
  clock: ClockView;
  sender: HitSender;
  startBlock: bigint;
  maxHits: number;
  enabled: () => boolean;
  log: Logger;
  /** Send when this block before the target is the head (initial value; see adaptiveLead). */
  leadBlocks?: number;
  /**
   * Adjust the lead from the measured inclusion delay (landed − send head) of recent hits
   * so a chain that includes faster or slower than assumed still lands on the intended
   * step. Default true.
   */
  adaptiveLead?: boolean;
}

export interface ScheduledHit extends Addition {
  targetBlock: bigint;
  /** Head block on which the send fires; re-timed if the adaptive lead changes before then. */
  sendBlock: bigint;
}

export interface HitResult extends Addition {
  intendedStep: number;
  actualStep: number;
  matched: boolean;
  targetBlock: bigint;
  landedBlock: bigint;
  sentAtBlock: bigint;
  txHash: Hash;
  gasUsed: bigint;
  on: boolean;
  latencyMs: number;
}

export interface SchedulerStats {
  planned: number;
  sent: number;
  confirmed: number;
  matched: number;
  failed: number;
  skipped: number;
  /** Planned hits dropped by stop() before they were sent. */
  cancelled: number;
  budgetLeft: number;
  gasUsed: bigint;
  /** W17: MON charged for the confirmed hits, in wei. */
  feeWei: bigint;
  /** matched / confirmed, 0 when nothing confirmed yet. */
  matchRate: number;
}

export interface Scheduler {
  nextBarStart(): bigint;
  /** Lead currently in use (blocks between the send head and the target). */
  leadBlocks(): number;
  scheduleBar(additions: Addition[], barStart: bigint): ScheduledHit[];
  results(): HitResult[];
  stats(): SchedulerStats;
  /** Hits scheduled or sent that have not landed (or failed) yet. */
  pending(): ScheduledHit[];
  /** Resolves when every in-flight send and confirmation has settled. */
  drain(): Promise<void>;
  /** Resolves once every pending hit has been sent and confirmed (or failed). */
  settle(): Promise<void>;
  stop(): void;
}

export const DEFAULT_LEAD_BLOCKS = 2;
const MIN_LEAD = 0;
const MAX_LEAD = 4;
/** Recent landings used for the adaptive lead. */
const LEAD_WINDOW = 4;

export function createScheduler(options: SchedulerOptions): Scheduler {
  const { clock, sender, startBlock, maxHits, enabled, log } = options;
  const baseLead = options.leadBlocks ?? DEFAULT_LEAD_BLOCKS;
  const adaptive = options.adaptiveLead ?? true;
  let lead = baseLead;
  const delays: number[] = [];
  const results: HitResult[] = [];
  const inFlight = new Set<Promise<void>>();
  /** Hits sent and awaiting confirmation, in send order. */
  const inFlightHits: ScheduledHit[] = [];
  /** Hits waiting for their send block to become the head. */
  const pending = new Map<ScheduledHit, ReturnType<typeof setTimeout>>();
  let unsubscribeHeads: (() => void) | null = null;
  let stopped = false;
  let planned = 0;
  let sent = 0;
  let failed = 0;
  let skipped = 0;
  let cancelled = 0;
  let gasUsed = 0n;
  let feeWei = 0n;

  function budgetLeft(): number {
    return Math.max(0, maxHits - sent);
  }

  async function fire(hit: ScheduledHit): Promise<void> {
    if (stopped) return;
    if (!enabled()) {
      skipped += 1;
      log.warn(`skip step ${hit.step} track ${hit.track}: kill switch (AGENT_ENABLED=false)`);
      return;
    }
    if (budgetLeft() === 0) {
      skipped += 1;
      log.warn(`skip step ${hit.step} track ${hit.track}: session cap of ${maxHits} hits reached`);
      return;
    }
    sent += 1;
    const sentAtBlock = clock.currentBlock();
    const sentAt = Date.now();
    let txHash: Hash;
    try {
      txHash = await sender.send(hit.track, hit.note);
    } catch (error) {
      sent -= 1;
      failed += 1;
      log.warn(`send failed for step ${hit.step} track ${hit.track}: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    let landing: HitLanding;
    try {
      landing = await sender.confirm(txHash);
    } catch (error) {
      failed += 1;
      log.warn(`confirm failed for ${txHash}: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const expectedStep = stepForBlock(startBlock, landing.blockNumber);
    if (expectedStep !== landing.step) {
      log.warn(`receipt step ${landing.step} disagrees with block ${landing.blockNumber} (expected ${expectedStep})`);
    }
    gasUsed += landing.gasUsed;
    feeWei += landing.feeWei ?? 0n;
    const delta = Number(landing.blockNumber - hit.targetBlock);
    adaptLead(Number(landing.blockNumber - sentAtBlock));
    const result: HitResult = {
      step: hit.step,
      track: hit.track,
      note: hit.note,
      intendedStep: hit.step,
      actualStep: landing.step,
      matched: landing.step === hit.step,
      targetBlock: hit.targetBlock,
      landedBlock: landing.blockNumber,
      sentAtBlock,
      txHash,
      gasUsed: landing.gasUsed,
      on: landing.on,
      latencyMs: Date.now() - sentAt,
    };
    results.push(result);
    log.info(
      `hit track ${hit.track} note ${hit.note}: intended step ${hit.step} → actual ${landing.step} ` +
        `(${result.matched ? 'match' : `miss, ${delta > 0 ? '+' : ''}${delta} blocks`}) block ${landing.blockNumber} gas ${landing.gasUsed} ${result.latencyMs} ms`,
    );
    if (!landing.on && hit.refresh) log.info(`hit ${txHash} refreshed its own note on step ${landing.step} track ${hit.track} (its recorded bit toggled, as expected)`);
    else if (!landing.on) log.warn(`hit ${txHash} toggled off an existing note on step ${landing.step} track ${hit.track}`);
  }

  /**
   * The lead is the inclusion delay we expect: blocks between the head we send on and the
   * block the hit lands in. Measure it directly and use the recent mean.
   */
  function adaptLead(inclusionDelay: number): void {
    if (!adaptive) return;
    delays.push(inclusionDelay);
    while (delays.length > LEAD_WINDOW) delays.shift();
    const mean = meanOf(delays);
    const next = Math.min(MAX_LEAD, Math.max(MIN_LEAD, Math.round(mean)));
    if (next !== lead) {
      log.info(`lead ${lead} → ${next} blocks (mean inclusion delay ${mean.toFixed(2)} over ${delays.length} hits)`);
      lead = next;
      retimePending();
    }
  }

  /** Apply the current lead to hits that have not been sent yet. */
  function retimePending(): void {
    for (const [hit, timer] of [...pending.entries()]) {
      const sendBlock = hit.targetBlock - BigInt(lead);
      if (sendBlock === hit.sendBlock) continue;
      clearTimeout(timer);
      pending.delete(hit);
      hit.sendBlock = sendBlock;
      arm(hit);
    }
  }

  /** Wait for the head of `hit.sendBlock`, with the predicted time plus one block as a fallback. */
  function arm(hit: ScheduledHit): void {
    const fallback = setTimeout(() => {
      if (!pending.has(hit)) return;
      log.warn(`no head seen for send block ${hit.sendBlock} (now ${clock.currentBlock()}); sending on the predicted time`);
      launch(hit);
    }, clock.msUntilBlock(hit.sendBlock) + clock.measuredBlockMs());
    pending.set(hit, fallback);
    if (hit.sendBlock <= clock.currentBlock()) launch(hit);
  }

  function meanOf(xs: number[]): number {
    return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
  }

  function launch(hit: ScheduledHit): void {
    const timer = pending.get(hit);
    if (timer !== undefined) clearTimeout(timer);
    pending.delete(hit);
    inFlightHits.push(hit);
    const p = fire(hit).finally(() => {
      inFlight.delete(p);
      const i = inFlightHits.indexOf(hit);
      if (i >= 0) inFlightHits.splice(i, 1);
    });
    inFlight.add(p);
  }

  function onHead(block: bigint): void {
    for (const hit of [...pending.keys()]) if (hit.sendBlock <= block) launch(hit);
  }

  function ensureHeadListener(): void {
    if (!unsubscribeHeads) unsubscribeHeads = clock.onHead(onHead);
  }

  return {
    leadBlocks: () => lead,
    nextBarStart() {
      const current = clock.currentBlock();
      const elapsed = current >= startBlock ? current - startBlock : 0n;
      const bar = elapsed / BigInt(STEPS);
      return startBlock + (bar + 1n) * BigInt(STEPS);
    },
    scheduleBar(additions, barStart) {
      const out: ScheduledHit[] = [];
      for (const a of additions) {
        if (stopped) break;
        const targetBlock = barStart + BigInt(a.step);
        const sendBlock = targetBlock - BigInt(lead);
        if (sendBlock < clock.currentBlock()) {
          skipped += 1;
          log.warn(`skip step ${a.step} track ${a.track}: send block ${sendBlock} already passed (now ${clock.currentBlock()})`);
          continue;
        }
        if (budgetLeft() - out.length <= 0) {
          skipped += 1;
          log.warn(`skip step ${a.step} track ${a.track}: no budget left`);
          continue;
        }
        const hit: ScheduledHit = { ...a, targetBlock, sendBlock };
        planned += 1;
        out.push(hit);
        ensureHeadListener();
        arm(hit);
      }
      return out;
    },
    results: () => [...results],
    stats() {
      const confirmed = results.length;
      const matched = results.filter((r) => r.matched).length;
      return { planned, sent, confirmed, matched, failed, skipped, cancelled, budgetLeft: budgetLeft(), gasUsed, feeWei, matchRate: confirmed === 0 ? 0 : matched / confirmed };
    },
    pending: () => [...inFlightHits, ...pending.keys()],
    async drain() {
      while (inFlight.size > 0) await Promise.all([...inFlight]);
    },
    async settle() {
      while (!stopped && (pending.size > 0 || inFlight.size > 0)) {
        await new Promise((r) => setTimeout(r, 50));
        while (inFlight.size > 0) await Promise.all([...inFlight]);
      }
    },
    stop() {
      stopped = true;
      if (pending.size > 0) {
        cancelled += pending.size;
        log.warn(`stop: cancelling ${pending.size} pending hit(s) not yet sent`);
      }
      for (const t of pending.values()) clearTimeout(t);
      pending.clear();
      unsubscribeHeads?.();
      unsubscribeHeads = null;
    },
  };
}
