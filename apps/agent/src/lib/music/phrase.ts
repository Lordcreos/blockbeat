/**
 * W17: the DJ plays PHRASES. Each section has a target arrangement (drums, a bass line on the
 * chord of each step, pad chords, a lead motif) built from the theory module. Each bar the
 * phrase is the up-to-N most important target notes that are missing from the live grid, so
 * the groove builds over a few bars and repairs itself as notes decay (docs/adr/0002-dj-phrases.md).
 *
 * `sanitizePhrase` is the one gate every brain's phrase goes through (rules and LLM alike):
 * in range, in key (pitched notes are snapped), never a sounding cell, never over the voice cap
 * (and one voice left for the room on a track humans play), never on a track the room holds,
 * never a track the section does not play, never a drum or bass note that would ring through the breakdown, never XORing a human's
 * recorded bit or clashing with the same note one step away (a pitch-preserving variant is used).
 */
import { STEPS, isTrackId, type TrackId } from '@blockbeat/shared';
import { z } from 'zod';
import type { Grid, GridCell } from '../pattern';
import { MAX_SPILL_BARS, sectionSpec, spillBars, type MusicContext } from './arrangement';
import {
  BASS_TEMPLATES,
  DRUM_TEMPLATES,
  MOTIFS,
  bassLine,
  chordAtStep,
  invertMotif,
  padNoteFor,
  pitchPreservingVariants,
  realiseMotif,
  shiftMotif,
  snapToKey,
  transposeMotif,
  type BassTemplateName,
  type Motif,
} from './theory';

/** The roles a phrase note can play (also the enum the LLM schema allows). */
export const PHRASE_ROLES = ['kick', 'clap', 'hat', 'open-hat', 'snare-ghost', 'bass', 'pad-chord', 'lead-call', 'lead-answer', 'fx-sweep', 'fill'] as const;
export type PhraseRole = (typeof PHRASE_ROLES)[number];

export interface PhraseNote {
  step: number;
  track: TrackId;
  note: number;
  role: string;
  /** Re-lights the DJ's own expiring note on this cell (its recorded bit toggles; expected). */
  refresh?: boolean;
}

/** A target note and the bar of its section from which it may enter (the build brings things in one by one). */
interface TargetNote extends PhraseNote {
  enter: number;
}

export const MOTIF_VARIATIONS = ['none', 'transpose', 'invert', 'shift'] as const;
export type MotifVariation = (typeof MOTIF_VARIATIONS)[number];

/** Choices that hold for a whole cycle, so a track's target never changes under notes that ring 8 bars (architect review). */
export interface SectionChoices {
  bass: BassTemplateName;
  motif: number;
  variation: MotifVariation;
  /** Where the DJ's lead motif starts: the half of the bar the room's lead is not in (call and response). */
  leadHalf: 0 | 8;
}

const PEAK_BASS: readonly BassTemplateName[] = ['octave-bounce', 'walk'];
/** Roomy fx sweep in the breakdown. */
const FX_SWEEP_NOTE = 8;

export function applyVariation(motif: Motif, variation: MotifVariation): Motif {
  switch (variation) {
    case 'transpose':
      return transposeMotif(motif, 2);
    case 'invert':
      return invertMotif(motif);
    case 'shift':
      return shiftMotif(motif, 1);
    case 'none':
      return motif;
  }
}

/** Deterministic per cycle; the lead half answers the room (the half with fewer human lead notes). */
export function chooseSection(music: MusicContext, grid: Grid): SectionChoices {
  const humanLead = grid.cells.filter((c) => c.track === 5 && c.owner === 'human');
  const early = humanLead.filter((c) => c.step < STEPS / 2).length;
  const late = humanLead.length - early;
  const leadHalf: 0 | 8 = early > late ? 8 : late > early ? 0 : music.cycle % 2 === 0 ? 0 : 8;
  return {
    bass: PEAK_BASS[music.cycle % PEAK_BASS.length] ?? 'octave-bounce',
    motif: music.cycle % MOTIFS.length,
    variation: MOTIF_VARIATIONS[music.cycle % MOTIF_VARIATIONS.length] ?? 'none',
    leadHalf,
  };
}

function leadNotes(music: MusicContext, choices: SectionChoices): { call: PhraseNote[]; answer: PhraseNote[] } {
  const motif = applyVariation(MOTIFS[choices.motif] ?? MOTIFS[0] ?? [], choices.variation);
  const call = realiseMotif(motif, music.key, choices.leadHalf).map((n) => ({ ...n, track: 5 as const, role: 'lead-call' }));
  const answer = realiseMotif(invertMotif(motif), music.key, (choices.leadHalf + STEPS / 2) % STEPS, 1).map((n) => ({ ...n, track: 5 as const, role: 'lead-answer' }));
  return { call, answer };
}

function padChords(music: MusicContext): PhraseNote[] {
  return [0, 4, 8, 12].map((step) => ({ step, track: 6 as const, note: padNoteFor(chordAtStep(music.chords, step), music.key), role: 'pad-chord' }));
}

function bass(music: MusicContext, template: BassTemplateName): PhraseNote[] {
  return bassLine(BASS_TEMPLATES[template], music.chords).map((n) => ({ ...n, track: 4 as const, role: 'bass' }));
}

const at = (enter: number, notes: readonly PhraseNote[]): TargetNote[] => notes.map((n) => ({ ...n, enter }));

/** The full target of the section, most important first; only notes whose entry bar has come. */
export function sectionTarget(music: MusicContext, choices: SectionChoices): PhraseNote[] {
  const drums = (section: keyof typeof DRUM_TEMPLATES, from: number, to: number): PhraseNote[] => DRUM_TEMPLATES[section].slice(from, to).map((d) => ({ ...d }));
  let target: TargetNote[];
  switch (music.section) {
    case 'intro':
      target = at(0, drums('intro', 0, 4));
      break;
    case 'build':
      // Kicks first, hats a bar later, the bass a bar after that: they also leave the peak one by one.
      target = [...at(0, drums('build', 0, 6)), ...at(1, drums('build', 6, 10)), ...at(2, bass(music, 'root-pulse'))];
      break;
    case 'peak': {
      const { call } = leadNotes(music, choices);
      target = at(0, [...drums('peak', 0, 4), ...bass(music, choices.bass), ...drums('peak', 4, 6), ...padChords(music), ...drums('peak', 6, 10), ...call, ...drums('peak', 10, 14)]);
      break;
    }
    case 'breakdown': {
      const { call, answer } = leadNotes(music, choices);
      target = at(0, [...padChords(music), ...call, ...answer, { step: 12, track: 7, note: FX_SWEEP_NOTE, role: 'fx-sweep' }]);
      break;
    }
  }
  return target.filter((n) => n.enter <= music.barInSection).map(({ enter: _enter, ...n }) => n);
}

// ---------------------------------------------------------------------------------------------
// The gate every phrase goes through

export const DROP_REASONS = ['invalid', 'duplicate', 'live cell', 'track full', 'room holds track', 'section', 'no free variant', 'over bar cap'] as const;
export type DropReason = (typeof DROP_REASONS)[number];

export interface SanitizeReport {
  kept: PhraseNote[];
  dropped: Array<{ candidate: unknown; reason: DropReason }>;
  /** Pitched notes moved to the nearest note in the key. */
  snapped: number;
}

export interface SanitizeOptions {
  maxNotes: number;
  /** Note lifetime (0 = no decay: no spill rule). */
  lifetimeBars: number;
}

const candidateSchema = z.object({
  step: z.number().int().min(0).max(STEPS - 1),
  track: z.number().int().min(0).max(7),
  note: z.number().int().min(0).max(31),
  role: z.string().max(40).optional(),
});

/** A human holds a track at this many live notes: the DJ leaves it to them. */
export const ROOM_HOLDS_TRACK = 3;
/** Without a voice cap the DJ still keeps a track to this many notes. */
const DEFAULT_TRACK_LIMIT = 6;

/** A live cell that goes dark before its step plays in the planned bar (the grid is read at that bar's start). */
function expiresBeforeItsStep(cell: GridCell): boolean {
  return cell.remainingBlocks !== undefined && cell.remainingBlocks <= cell.step + 1;
}

function cellsAt(grid: Grid, step: number, track: number): GridCell[] {
  return grid.cells.filter((c) => c.step === step && c.track === track);
}

export function sanitizePhrase(raw: readonly unknown[], grid: Grid, music: MusicContext, options: SanitizeOptions): SanitizeReport {
  const kept: PhraseNote[] = [];
  const dropped: SanitizeReport['dropped'] = [];
  let snapped = 0;
  const humanOn = new Map<number, number>();
  const voices = new Map<number, number>();
  for (const c of grid.cells) {
    voices.set(c.track, (voices.get(c.track) ?? 0) + 1);
    if (c.owner === 'human') humanOn.set(c.track, (humanOn.get(c.track) ?? 0) + 1);
  }
  const wanted = sectionSpec(music.section).wants;
  const cap = grid.decay && grid.maxLivePerTrack > 0 ? grid.maxLivePerTrack : DEFAULT_TRACK_LIMIT;
  const limitOf = (track: number): number => ((humanOn.get(track) ?? 0) > 0 ? cap - 1 : cap);
  const drop = (candidate: unknown, reason: DropReason): void => {
    dropped.push({ candidate, reason });
  };

  for (const candidate of raw) {
    if (kept.length >= options.maxNotes) {
      drop(candidate, 'over bar cap');
      continue;
    }
    const parsed = candidateSchema.safeParse(candidate);
    if (!parsed.success || !isTrackId(parsed.data.track)) {
      drop(candidate, 'invalid');
      continue;
    }
    const { step } = parsed.data;
    const track: TrackId = parsed.data.track;
    const role = parsed.data.role ?? 'fill';
    if (kept.some((k) => k.step === step && k.track === track)) {
      drop(candidate, 'duplicate');
      continue;
    }
    // A cell sounds in the planned bar unless every note on it goes dark before its step plays.
    const here = cellsAt(grid, step, track);
    const sounding = grid.decay ? here.some((c) => !expiresBeforeItsStep(c)) : here.length > 0;
    if (sounding) {
      drop(candidate, 'live cell');
      continue;
    }
    if (grid.decay && (humanOn.get(track) ?? 0) >= ROOM_HOLDS_TRACK) {
      drop(candidate, 'room holds track');
      continue;
    }
    // The section decides the tracks (an LLM added bass to the intro on the first live run), and a
    // drum or bass note must not ring through the breakdown.
    if (!wanted.has(track) || (grid.decay && options.lifetimeBars > 0 && spillBars(track, music.bar, options.lifetimeBars) > MAX_SPILL_BARS)) {
      drop(candidate, 'section');
      continue;
    }
    // Re-lighting an expiring cell reuses its voice; anything else needs a free one.
    const reuses = here.length > 0;
    const used = (voices.get(track) ?? 0) + kept.filter((k) => k.track === track && cellsAt(grid, k.step, k.track).length === 0).length;
    if (!reuses && used >= limitOf(track)) {
      drop(candidate, 'track full');
      continue;
    }
    const inKey = snapToKey(track, parsed.data.note, music.key);
    if (inKey !== parsed.data.note) snapped += 1;
    const drifts = (n: number): boolean =>
      [step + 1, step + STEPS - 1].some((s) => grid.isOn(s % STEPS, track, n) || kept.some((k) => k.track === track && k.note === n && k.step === s % STEPS));
    const note = pitchPreservingVariants(track, inKey).find((n) => !grid.recordedHuman(step, track, n) && !drifts(n));
    if (note === undefined) {
      drop(candidate, 'no free variant');
      continue;
    }
    // Re-lighting its own expiring note on the same cell clears the DJ's recorded bit: expected, not a toggle-off.
    const refresh = here.some((c) => c.note === note && c.owner === 'agent');
    kept.push(refresh ? { step, track, note, role, refresh } : { step, track, note, role });
  }
  return { kept, dropped, snapped };
}

// ---------------------------------------------------------------------------------------------
// Density and the composed phrase

/** Live notes the room (humans) is playing. */
export function humanLive(grid: Grid): number {
  return grid.cells.filter((c) => c.owner === 'human').length;
}

/** Notes the DJ plays this bar: the per-bar cap, scaled down when the room is busy, never over the budget. */
export function notesForBar(grid: Grid, maxNotesPerBar: number, budgetLeft: number): number {
  const human = humanLive(grid);
  const scale = human < 8 ? 1 : human < 16 ? 0.75 : human < 28 ? 0.5 : 0.25;
  const want = maxNotesPerBar <= 0 ? 0 : Math.max(1, Math.floor(maxNotesPerBar * scale));
  return Math.max(0, Math.min(want, budgetLeft));
}

export interface ComposeOptions {
  maxNotesPerBar: number;
  budgetLeft: number;
  lifetimeBars: number;
  /** Held for the cycle by the rules brain; derived from the grid when absent. */
  choices?: SectionChoices;
}

/** The rules phrase for the bar: the section target through the gate, most important first. */
export function composePhrase(grid: Grid, music: MusicContext, options: ComposeOptions): SanitizeReport {
  const max = notesForBar(grid, options.maxNotesPerBar, options.budgetLeft);
  const choices = options.choices ?? chooseSection(music, grid);
  return sanitizePhrase(sectionTarget(music, choices), grid, music, { maxNotes: max, lifetimeBars: options.lifetimeBars });
}
