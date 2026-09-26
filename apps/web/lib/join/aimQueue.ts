/**
 * W16: the phone's aimed-note queue. Up to MAX_AIMED notes wait for their send time and go out
 * through the ordinary hit sender, so the fixed gas tiers, the local nonce manager and the
 * Hit-log confirmation all stay as they are; no estimateGas, no new RPC calls.
 *
 * Timing, the DJ agent's technique made finer:
 * - The delay a phone needs is learnt from its own landings: y = landed block − the clock's
 *   position when the send fired, averaged over the last 4 (aimed or Tap now), starting at 1.
 * - With a clock that knows its sub-block position (the runtime block clock does), a note for
 *   target block T is sent at position T − mean(y): a timer inside the right block. A landing
 *   lands in ceil(send position + c) for a constant link delay c, and y spreads over [c, c + 1),
 *   so T − mean(y) is the middle of the window that lands on T. Whole-block leads, sent on the
 *   tick, sit on the edge of that window when c is near x.5 (anvil at 300 ms per round trip
 *   measured 6.5 blocks and 32-37 % exact that way).
 * - A clock without position() (tests, simple harnesses) sends on the tick of target − lead.
 * - A note whose send time was skipped (a background tab, a hard re-lock, a lead that grew) is
 *   re-aimed at the same step in the next loop instead of being sent late.
 *
 * Framework-free; React reads it through useSyncExternalStore (getState is stable between changes).
 */
import type { TrackId } from '@blockbeat/shared';
import { BLOCK_MS } from '@blockbeat/shared';
import { aimOutcome, createLeadTracker, targetBlockFor } from './aim';

export const MAX_AIMED = 4;
const DEFAULT_KEEP_RESULTS = 4;
/** A sub-block send found more than this far behind the clock is re-aimed, not sent late. */
const LATE_SLACK_BLOCKS = 0.5;

export interface AimClock {
  /** The block the clock thinks is current; null until it has seen a real head. */
  head(): bigint | null;
  /** Fires once per block (predicted or observed). */
  onBlock(cb: (block: bigint) => void): () => void;
  /** Fractional block position now (head + the elapsed part of the block); enables sub-block timing. */
  position?(): number | null;
  /** Measured block interval in ms (default BLOCK_MS). */
  blockMs?(): number;
}

export interface AimLanding {
  blockNumber: bigint;
  step: number;
  /** Send to Hit log, when the sender measured it. */
  latencyMs?: number;
}

export type AimSend = (track: TrackId, note: number) => Promise<AimLanding>;

export interface AimRequest {
  track: TrackId;
  note: number;
  step: number;
}

export interface AimItem extends AimRequest {
  id: number;
  targetBlock: bigint;
  /** Block during which the send fires (the floor of the sub-block send position). */
  sendBlock: bigint;
  status: 'waiting' | 'sending';
  /** Head block the send fired on (null while waiting). */
  sentAtBlock: bigint | null;
}

interface ResultBase {
  id: number;
  track: TrackId;
  note: number;
  aimedStep: number;
  targetBlock: bigint;
}

export type AimResult =
  | (ResultBase & { ok: true; landedStep: number; landedBlock: bigint; sentAtBlock: bigint | null; sentAtPosition: number | null; delta: number; text: string; latencyMs: number | null })
  | (ResultBase & { ok: false; error: unknown });

export type AimRejection = 'full' | 'duplicate' | 'no-clock' | 'no-funds' | 'disposed';

export interface AimQueueState {
  items: readonly AimItem[];
  /** Newest first. */
  results: readonly AimResult[];
  /** Whole-block lead (the rounded mean delay). */
  lead: number;
  /** The mean delay in blocks, as used for sub-block timing. */
  leadBlocks: number;
}

export interface AimQueue {
  aim(request: AimRequest): { ok: true; item: AimItem } | { ok: false; reason: AimRejection };
  /** Drops a note still waiting; false once it was sent. */
  cancel(id: number): boolean;
  /** Re-plans every waiting note from its target (after a nonce reset the send path may have changed). */
  retime(): void;
  /** A Tap now landing (sent at a head or a fractional position): teaches the lead like an aimed one. */
  recordInclusion(sentAt: bigint | number, landedBlock: bigint): void;
  getState(): AimQueueState;
  subscribe(cb: (state: AimQueueState) => void): () => void;
  dispose(): void;
}

export interface AimQueueOptions {
  clock: AimClock;
  send: AimSend;
  startBlock: () => bigint | null;
  /** Notes the burner can still pay for, or null when unknown (never blocks then). */
  budget?: () => number | null;
  maxAimed?: number;
  keepResults?: number;
}

interface Slot {
  item: AimItem;
  /** Fractional send position (sub-block clocks only). */
  sendAt: number | null;
  timer: ReturnType<typeof setTimeout> | null;
}

export function createAimQueue(options: AimQueueOptions): AimQueue {
  const { clock, send, startBlock } = options;
  const maxAimed = options.maxAimed ?? MAX_AIMED;
  const keepResults = options.keepResults ?? DEFAULT_KEEP_RESULTS;
  const subBlock = typeof clock.position === 'function';
  const slots = new Map<number, Slot>();
  let results: AimResult[] = [];
  let nextId = 1;
  let disposed = false;
  const listeners = new Set<(state: AimQueueState) => void>();
  const lead = createLeadTracker({ onChange: () => retime(), onMeanChange: () => retime() });
  let state: AimQueueState = snapshot();

  function snapshot(): AimQueueState {
    return { items: [...slots.values()].map((s) => s.item), results, lead: lead.lead(), leadBlocks: lead.mean() };
  }

  function emit(): void {
    state = snapshot();
    for (const cb of [...listeners]) cb(state);
  }

  const position = (): number | null => clock.position?.() ?? null;
  const blockMs = (): number => clock.blockMs?.() ?? BLOCK_MS;

  function clearTimer(slot: Slot): void {
    if (slot.timer !== null) clearTimeout(slot.timer);
    slot.timer = null;
  }

  function settle(id: number, result: AimResult): void {
    slots.delete(id);
    results = [result, ...results].slice(0, keepResults);
    emit();
  }

  function fire(slot: Slot): void {
    clearTimer(slot);
    const head = clock.head();
    const at = (subBlock ? position() : null) ?? (head === null ? null : Number(head));
    const item = { ...slot.item, status: 'sending' as const, sentAtBlock: head };
    slot.item = item;
    const base: ResultBase = { id: item.id, track: item.track, note: item.note, aimedStep: item.step, targetBlock: item.targetBlock };
    send(item.track, item.note).then(
      (landing) => {
        if (at !== null) lead.record(Number(landing.blockNumber) - at);
        const outcome = aimOutcome(item.step, landing.step);
        settle(item.id, { ...base, ok: true, landedStep: landing.step, landedBlock: landing.blockNumber, sentAtBlock: head, sentAtPosition: at, delta: outcome.delta, text: outcome.text, latencyMs: landing.latencyMs ?? null });
      },
      (error: unknown) => settle(item.id, { ...base, ok: false, error }),
    );
  }

  /** Target and send time for `step` from the clock's current place, with the current lead. */
  function plan(step: number, start: bigint): { targetBlock: bigint; sendBlock: bigint; sendAt: number | null } | null {
    const head = clock.head();
    if (head === null) return null;
    if (subBlock) {
      const pos = position() ?? Number(head);
      const mean = lead.mean();
      const targetBlock = targetBlockFor(start, BigInt(Math.ceil(pos + mean)), step, 0);
      const sendAt = Number(targetBlock) - mean;
      return { targetBlock, sendBlock: BigInt(Math.floor(sendAt)), sendAt };
    }
    const targetBlock = targetBlockFor(start, head, step, lead.lead());
    return { targetBlock, sendBlock: targetBlock - BigInt(lead.lead()), sendAt: null };
  }

  function replan(slot: Slot, start: bigint): void {
    const next = plan(slot.item.step, start);
    if (!next) return;
    clearTimer(slot);
    slot.item = { ...slot.item, targetBlock: next.targetBlock, sendBlock: next.sendBlock };
    slot.sendAt = next.sendAt;
  }

  /** Arms, sends or re-aims one waiting note for the block `head`. Returns true when it changed. */
  function service(slot: Slot, head: bigint): boolean {
    if (slot.item.status !== 'waiting' || slot.timer !== null) return false;
    const start = startBlock();
    if (slot.sendAt !== null) {
      const pos = position() ?? Number(head);
      if (pos > slot.sendAt + LATE_SLACK_BLOCKS) {
        if (start === null) return false;
        replan(slot, start);
        return true;
      }
      // Arm the timer within the last block before the send time (ticks come once a block).
      if (slot.sendAt - pos > 1) return false;
      const wait = Math.max(0, (slot.sendAt - pos) * blockMs());
      slot.timer = setTimeout(() => {
        slot.timer = null;
        if (disposed || !slots.has(slot.item.id)) return;
        fire(slot);
        emit();
      }, wait);
      return false;
    }
    if (slot.item.sendBlock < head && start !== null) {
      replan(slot, start);
      if (slot.item.sendBlock === head) fire(slot);
      return true;
    }
    if (slot.item.sendBlock === head) {
      fire(slot);
      return true;
    }
    return false;
  }

  function serviceAll(head: bigint): boolean {
    let changed = false;
    for (const slot of [...slots.values()]) if (service(slot, head)) changed = true;
    return changed;
  }

  /** The lead moved: re-plan every waiting note's send time from its fixed target. */
  function retime(): void {
    for (const slot of slots.values()) {
      if (slot.item.status !== 'waiting') continue;
      clearTimer(slot);
      if (subBlock) {
        slot.sendAt = Number(slot.item.targetBlock) - lead.mean();
        slot.item = { ...slot.item, sendBlock: BigInt(Math.floor(slot.sendAt)) };
      } else {
        slot.item = { ...slot.item, sendBlock: slot.item.targetBlock - BigInt(lead.lead()) };
      }
    }
    const head = clock.head();
    if (head !== null) serviceAll(head);
    emit();
  }

  const offClock = clock.onBlock((block) => {
    if (disposed) return;
    if (serviceAll(block)) emit();
  });

  return {
    aim(request) {
      if (disposed) return { ok: false, reason: 'disposed' };
      const head = clock.head();
      const start = startBlock();
      if (head === null || start === null) return { ok: false, reason: 'no-clock' };
      const items = [...slots.values()].map((s) => s.item);
      if (items.some((i) => i.step === request.step && i.track === request.track && i.note === request.note)) return { ok: false, reason: 'duplicate' };
      if (items.length >= maxAimed) return { ok: false, reason: 'full' };
      const budget = options.budget?.() ?? null;
      if (budget !== null && items.length >= budget) return { ok: false, reason: 'no-funds' };
      const planned = plan(request.step, start);
      if (!planned) return { ok: false, reason: 'no-clock' };
      const id = nextId++;
      const slot: Slot = {
        item: { ...request, id, targetBlock: planned.targetBlock, sendBlock: planned.sendBlock, status: 'waiting', sentAtBlock: null },
        sendAt: planned.sendAt,
        timer: null,
      };
      slots.set(id, slot);
      service(slot, head);
      emit();
      return { ok: true, item: slot.item };
    },
    cancel(id) {
      const slot = slots.get(id);
      if (!slot || slot.item.status !== 'waiting') return false;
      clearTimer(slot);
      slots.delete(id);
      emit();
      return true;
    },
    retime() {
      if (!disposed) retime();
    },
    recordInclusion(sentAt, landedBlock) {
      lead.record(Number(landedBlock) - Number(sentAt));
      emit();
    },
    getState: () => state,
    subscribe(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    dispose() {
      disposed = true;
      offClock();
      listeners.clear();
      for (const [id, slot] of slots) {
        if (slot.item.status !== 'waiting') continue;
        clearTimer(slot);
        slots.delete(id);
      }
    },
  };
}
