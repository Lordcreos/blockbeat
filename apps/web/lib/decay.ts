/**
 * W13: the web side of note decay. The knobs (`NEXT_PUBLIC_NOTE_LIFETIME_BARS`, default 8,
 * and `NEXT_PUBLIC_MAX_LIVE_PER_TRACK`, default 6; 0 turns either off) and the live view the
 * stage, audio and phone render. The rule itself lives in @blockbeat/shared (livePattern), so
 * the stage, the phones and the DJ agent compute the same cells from the same Hit logs.
 */
import type { Address } from 'viem';
import {
  BLOCK_MS,
  ZERO_ADDRESS,
  compareHits,
  decodeStep,
  livePattern,
  parseMaxLivePerTrack,
  parseNoteLifetimeBars,
  type EvictedCell,
  type HitEvent,
  type LiveCell,
  type Pattern,
} from '@blockbeat/shared';

export interface DecayConfig {
  /** 0 = no decay: everything plays the recorded pattern, as before W13. */
  lifetimeBars: number;
  /** 0 = no voice cap. */
  maxLivePerTrack: number;
}

/** Read on every call so tests can stub the env; Next inlines both values at build time. */
export function decayConfig(): DecayConfig {
  return {
    lifetimeBars: parseNoteLifetimeBars(process.env.NEXT_PUBLIC_NOTE_LIFETIME_BARS),
    maxLivePerTrack: parseMaxLivePerTrack(process.env.NEXT_PUBLIC_MAX_LIVE_PER_TRACK),
  };
}

export interface LiveView {
  /** False when decay is off and the view is the recorded pattern. */
  decay: boolean;
  /** 16 step words of the notes the room hears. */
  steps: bigint[];
  cells: LiveCell[];
  count: number;
  /** Cells the voice cap evicted in the last 2 bars (silent, drawn fading). */
  evicted: EvictedCell[];
}

/**
 * The live layer at `currentBlock`; with decay off, the recorded pattern at full life. `hits`
 * must be in chain order (the feed's history is): only the last replay window is walked.
 */
export function liveView(hits: readonly HitEvent[], recorded: Pattern, currentBlock: bigint, config: DecayConfig): LiveView {
  if (config.lifetimeBars > 0) {
    const live = livePattern(hits, currentBlock, config.lifetimeBars, { maxLivePerTrack: config.maxLivePerTrack, presorted: true });
    return { decay: true, ...live };
  }
  const lastHit = new Map<string, HitEvent>();
  for (const h of [...hits].sort(compareHits)) lastHit.set(`${h.step}:${h.track}:${h.note}`, h);
  const cells: LiveCell[] = [];
  recorded.forEach((word, step) => {
    for (const { track, note } of decodeStep(word)) {
      const last = lastHit.get(`${step}:${track}:${note}`);
      cells.push({
        step,
        track,
        note,
        lastBlock: last?.blockNumber ?? 0n,
        ageBlocks: 0,
        remainingBlocks: Number.POSITIVE_INFINITY,
        player: last?.player ?? ZERO_ADDRESS,
        hits: 0,
      });
    }
  });
  return { decay: false, steps: [...recorded], cells, count: cells.length, evicted: [] };
}

/**
 * The phone's strip (`hits` in chain order): step → blocks left of this player's longest-living note on that step.
 * Evaluated on the room's full live layer (the voice cap counts everyone's notes). Empty with
 * decay off: the strip then shows landings only.
 */
export function ownLiveSteps(hits: readonly HitEvent[], currentBlock: bigint, player: Address | null, config: DecayConfig): Map<number, number> {
  const out = new Map<number, number>();
  if (player === null || config.lifetimeBars <= 0) return out;
  const me = player.toLowerCase();
  const live = livePattern(hits, currentBlock, config.lifetimeBars, { maxLivePerTrack: config.maxLivePerTrack, presorted: true });
  for (const cell of live.cells) {
    if (cell.player.toLowerCase() !== me) continue;
    out.set(cell.step, Math.max(out.get(cell.step) ?? 0, cell.remainingBlocks));
  }
  return out;
}

/** Value equality of two step-word arrays (keeps the audio pattern's identity stable between blocks). */
export function sameSteps(a: readonly bigint[], b: readonly bigint[]): boolean {
  return a.length === b.length && a.every((w, i) => w === b[i]);
}

/** W13: the head on a device without a block clock: the hint plus one block per BLOCK_MS since. */
export function estimateBlock(hint: { block: bigint; atMs: number } | null, nowMs: number, blockMs: number = BLOCK_MS): bigint | null {
  if (hint === null) return null;
  const elapsed = Math.max(0, nowMs - hint.atMs);
  return hint.block + BigInt(Math.floor(elapsed / blockMs));
}
