import { NOTES_PER_TRACK, STEPS, TRACKS, fadeOf, ghostFadeOf, type EvictedCell, type LiveCell, type Pattern, type TrackId } from '@blockbeat/shared';

const TRACK_MASK = (1n << BigInt(NOTES_PER_TRACK)) - 1n;

/** Per step, per track: how many notes are on. Length STEPS × TRACKS. */
export function trackCellCounts(pattern: Pattern): number[][] {
  const out: number[][] = [];
  for (let s = 0; s < STEPS; s++) {
    const word = pattern[s] ?? 0n;
    const row: number[] = [];
    for (let t = 0; t < TRACKS; t++) {
      let bits = (word >> BigInt(t * NOTES_PER_TRACK)) & TRACK_MASK;
      let count = 0;
      while (bits !== 0n) {
        bits &= bits - 1n;
        count++;
      }
      row.push(count);
    }
    out.push(row);
  }
  return out;
}

export function isAgentHit(player: string, agentAddress: string | undefined): boolean {
  if (!agentAddress) return false;
  return player.toLowerCase() === agentAddress.toLowerCase();
}

export function cellKey(step: number, track: TrackId | number): string {
  return `${step}:${track}`;
}

export function noteKey(step: number, track: TrackId | number, note: number): string {
  return `${step}:${track}:${note}`;
}

export interface FadeInput {
  decay: boolean;
  cells: readonly LiveCell[];
  evicted: readonly EvictedCell[];
}

export interface CellFades {
  /** [step][track] brightness 0..1 of the longest-living live note (0 = no live note). */
  fade: number[][];
  /** [step][track] brightness of a just-evicted note where no live note remains (0 = none). */
  ghost: number[][];
}

function zeroGrid(): number[][] {
  return Array.from({ length: STEPS }, () => new Array<number>(TRACKS).fill(0));
}

/** W13: how bright each cell is drawn: live notes fade over their last 2 bars, evicted ones fade out. */
export function cellFades(view: FadeInput, lifetimeBars: number, reducedMotion: boolean): CellFades {
  const fade = zeroGrid();
  const ghost = zeroGrid();
  for (const c of view.cells) {
    const row = fade[c.step];
    if (!row) continue;
    const f = view.decay ? fadeOf(c.remainingBlocks, lifetimeBars, { reducedMotion }) : 1;
    row[c.track] = Math.max(row[c.track] ?? 0, f);
  }
  for (const c of view.evicted) {
    const row = ghost[c.step];
    if (!row || (fade[c.step]?.[c.track] ?? 0) > 0) continue;
    row[c.track] = Math.max(row[c.track] ?? 0, ghostFadeOf(c.sinceBlocks, lifetimeBars, { reducedMotion }));
  }
  return { fade, ghost };
}

/** W13: step × track keys whose live note was hit last by the agent. */
export function agentLiveCells(cells: readonly LiveCell[], agentAddress: string | undefined): Set<string> {
  const out = new Set<string>();
  if (!agentAddress) return out;
  for (const c of cells) if (isAgentHit(c.player, agentAddress)) out.add(cellKey(c.step, c.track));
  return out;
}
