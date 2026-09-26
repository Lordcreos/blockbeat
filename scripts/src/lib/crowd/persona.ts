/**
 * W19 crowd simulator: who the virtual players are and what they play. Pure and seeded, so a
 * run's whole score is known before any MON moves (the budget guard prices it) and tests can
 * pin it.
 *
 * A persona is an instrument (the 8 tracks, drums weighted), a style and a stay:
 * - steady: a 1-bar pattern repeated every bar with small variations;
 * - busy: 2-4 notes per bar;
 * - sparse: one note every 1-2 bars.
 * Melodic tracks take their pitches from the DJ's A-minor loop (shared `inKeyNotesFor`).
 *
 * Two filters make the plan sound like people on the live layer (ADR 0001) and keep it cheap:
 * a player never re-plays a cell it still has alive (a note rings 8 bars), and each player has
 * an allowance of notes spread over its stay (like a phone's drip), so a busy player plays in
 * bursts rather than burning its MON in the first bars.
 */
import { BAR_MS, NOTE_LIFETIME_BARS, NOTES_PER_TRACK, STEPS, inKeyNotesFor, type TrackId } from '@blockbeat/shared';
import { seededRandom } from '../runner';

export type Style = 'steady' | 'busy' | 'sparse';

/** Players join over the first 20 s, like a room scanning the code. */
export const JOIN_WINDOW_MS = 20_000;
/** Share of players who leave before the end. */
export const LEAVE_EARLY_SHARE = 0.25;
/** Notes a player may run ahead of its even spread (a burst). */
export const BURST_NOTES = 2;
/** Chance that a steady player's pattern note comes out as another pitch or sound. */
export const STEADY_VARIATION = 0.2;

/** 16-slot cycle: the first 8 players cover every track, then drums come back more often. */
const TRACK_ORDER: readonly TrackId[] = [0, 2, 4, 1, 5, 3, 6, 7, 0, 2, 1, 3, 4, 0, 2, 5];

const STYLE_WEIGHTS: Record<TrackId, ReadonlyArray<[Style, number]>> = {
  0: [['steady', 0.7], ['busy', 0.15], ['sparse', 0.15]],
  1: [['steady', 0.7], ['busy', 0.15], ['sparse', 0.15]],
  2: [['steady', 0.6], ['busy', 0.3], ['sparse', 0.1]],
  3: [['steady', 0.7], ['busy', 0.1], ['sparse', 0.2]],
  4: [['steady', 0.5], ['busy', 0.3], ['sparse', 0.2]],
  5: [['busy', 0.45], ['sparse', 0.35], ['steady', 0.2]],
  6: [['sparse', 0.6], ['steady', 0.4]],
  7: [['sparse', 0.8], ['busy', 0.2]],
};

/** Steady patterns by track (steps of one bar); a persona picks one. */
const STEADY_PATTERNS: Record<TrackId, ReadonlyArray<readonly number[]>> = {
  0: [[0, 8], [0, 4, 8, 12], [0, 6, 8]],
  1: [[4, 12], [12], [4, 12, 14]],
  2: [[2, 6, 10, 14], [2, 10], [0, 4, 8, 12]],
  3: [[4, 12], [12], [4, 10, 12]],
  4: [[0, 4, 8, 12], [0, 8], [0, 6, 8, 14]],
  5: [[0, 6, 10], [2, 8], [0, 4, 8, 12]],
  6: [[0, 8], [0, 4, 8, 12]],
  7: [[0], [8]],
};

export interface Persona {
  id: number;
  track: TrackId;
  style: Style;
  /** Offset from the start of play. */
  joinAtMs: number;
  joinBar: number;
  /** First bar the player is gone, or null when it stays to the end. */
  leaveBar: number | null;
  /** Steady players' 1-bar pattern (steps); empty for the other styles. */
  pattern: readonly number[];
  /** Drum and fx variants this player sticks to (a player keeps its sound). */
  sounds: readonly number[];
  allowance: number;
}

export interface PlannedNote {
  player: number;
  bar: number;
  step: number;
  track: TrackId;
  note: number;
}

export interface CrowdPlan {
  seed: number;
  bars: number;
  personas: Persona[];
  /** Sorted by (bar, step, player). */
  notes: PlannedNote[];
}

export interface PlanOptions {
  seed: number;
  players: number;
  bars: number;
  /** Most notes one player may send over its stay. */
  notesPerPlayer: number;
  /** Joins spread over this window (default JOIN_WINDOW_MS). */
  joinWindowMs?: number;
  /** Length of a bar in ms (default BAR_MS), to turn join times into bars. */
  barMs?: number;
}

function pick<T>(rng: () => number, items: readonly T[]): T {
  const item = items[Math.floor(rng() * items.length)];
  if (item === undefined) throw new RangeError('pick from an empty list');
  return item;
}

function weighted(rng: () => number, weights: ReadonlyArray<[Style, number]>): Style {
  const total = weights.reduce((a, [, w]) => a + w, 0);
  let r = rng() * total;
  for (const [style, w] of weights) {
    r -= w;
    if (r < 0) return style;
  }
  return weights[weights.length - 1]?.[0] ?? 'sparse';
}

function noteFor(rng: () => number, persona: Persona, step: number, variation: boolean): number {
  const inKey = inKeyNotesFor(persona.track, step);
  // Chord tones, root first: a steady player mostly plays the root, a variation moves off it.
  if (inKey !== null) return variation || persona.style !== 'steady' ? pick(rng, inKey) : (inKey[0] ?? 0);
  return variation ? pick(rng, persona.sounds) : (persona.sounds[0] ?? 0);
}

function candidates(rng: () => number, persona: Persona, bar: number, lastSparseBar: number | null): number[] {
  switch (persona.style) {
    case 'steady':
      return [...persona.pattern];
    case 'busy': {
      const count = 2 + Math.floor(rng() * 3);
      const steps = new Set<number>();
      while (steps.size < count) steps.add(Math.floor(rng() * STEPS));
      return [...steps];
    }
    case 'sparse': {
      // Every bar or every other bar, never a longer gap.
      const due = lastSparseBar === null || bar - lastSparseBar >= 2 || rng() < 0.5;
      // Every step in a seeded order: the first one whose cell is not alive is played.
      if (!due) return [];
      const order = Array.from({ length: STEPS }, (_, i) => i);
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [order[i], order[j]] = [order[j] ?? 0, order[i] ?? 0];
      }
      return order;
    }
  }
}

export function planCrowd(options: PlanOptions): CrowdPlan {
  const { seed, players, bars, notesPerPlayer } = options;
  const joinWindowMs = options.joinWindowMs ?? JOIN_WINDOW_MS;
  const barMs = options.barMs ?? BAR_MS;
  if (!Number.isInteger(players) || players < 1) throw new RangeError(`players must be a positive integer, got ${players}`);
  if (!Number.isInteger(bars) || bars < 1) throw new RangeError(`bars must be a positive integer, got ${bars}`);
  if (!Number.isInteger(notesPerPlayer) || notesPerPlayer < 0) throw new RangeError(`notesPerPlayer must be a non-negative integer, got ${notesPerPlayer}`);
  const rng = seededRandom(seed);

  const joins = Array.from({ length: players }, (_, i) => (i === 0 ? 0 : Math.floor(rng() * joinWindowMs))).sort((a, b) => a - b);
  const personas: Persona[] = joins.map((joinAtMs, id) => {
    const track = TRACK_ORDER[id % TRACK_ORDER.length] ?? 0;
    const style = weighted(rng, STYLE_WEIGHTS[track]);
    const joinBar = Math.min(bars - 1, Math.floor(joinAtMs / barMs));
    const leaves = id > 0 && rng() < LEAVE_EARLY_SHARE;
    const stay = bars - joinBar;
    const leaveBar = leaves && stay >= 4 ? joinBar + Math.max(2, Math.floor(stay * (0.4 + rng() * 0.4))) : null;
    const first = Math.floor(rng() * NOTES_PER_TRACK);
    const second = (first + 1 + Math.floor(rng() * (NOTES_PER_TRACK - 1))) % NOTES_PER_TRACK;
    return {
      id,
      track,
      style,
      joinAtMs,
      joinBar,
      leaveBar,
      pattern: style === 'steady' ? pick(rng, STEADY_PATTERNS[track]) : [],
      sounds: [first, second],
      allowance: notesPerPlayer,
    };
  });

  const notes: PlannedNote[] = [];
  for (const persona of personas) {
    const end = persona.leaveBar ?? bars;
    const stay = end - persona.joinBar;
    const alive = new Map<string, number>();
    let played = 0;
    let lastSparseBar: number | null = null;
    for (let bar = persona.joinBar; bar < end; bar++) {
      const raw = candidates(rng, persona, bar, lastSparseBar);
      const steps = persona.style === 'sparse' ? raw : raw.sort((a, b) => a - b);
      // The even spread of the allowance up to this bar, plus a small burst.
      const cap = Math.min(persona.allowance, Math.ceil((persona.allowance * (bar - persona.joinBar + 1)) / stay) + BURST_NOTES);
      for (const step of steps) {
        if (played >= cap) break;
        const steady = persona.style === 'steady';
        // A steady player re-lays a pattern slot once its note has faded, whatever pitch it had.
        const slot = steady ? `${step}` : null;
        const slotSince = slot === null ? undefined : alive.get(slot);
        if (slotSince !== undefined && bar - slotSince < NOTE_LIFETIME_BARS) continue;
        // Small variations: now and then that note comes out as another pitch or sound.
        const note = noteFor(rng, persona, step, steady && rng() < STEADY_VARIATION);
        const key = slot ?? `${step}:${note}`;
        const since = alive.get(key);
        if (since !== undefined && bar - since < NOTE_LIFETIME_BARS) continue;
        alive.set(key, bar);
        notes.push({ player: persona.id, bar, step, track: persona.track, note });
        played += 1;
        if (persona.style === 'sparse') {
          lastSparseBar = bar;
          break;
        }
      }
    }
  }
  notes.sort((a, b) => a.bar - b.bar || a.step - b.step || a.player - b.player);
  return { seed, bars, personas, notes };
}
