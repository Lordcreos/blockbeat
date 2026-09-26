/**
 * W17: the DJ's section clock. A deterministic 20-bar cycle, counted from the first bar the
 * DJ plans (every DJ start opens with the intro): intro 4 (sparse backbone), build 4 (hats and
 * bass come in), peak 8 (the full phrase), breakdown 4 (pad and lead only), then the intro again.
 *
 * The peak is 8 bars, the note lifetime, so drums laid in its first bar go dark exactly when the
 * breakdown starts. The breakdown is strict: a drum or bass note may ring at most
 * MAX_SPILL_BARS into it (spillBars), so the drop is audible although the DJ cannot remove notes.
 */
import type { TrackId } from '@blockbeat/shared';
import { A_MINOR, keyName, progression, progressionName, type Chord, type Key, type SectionName } from './theory';

export interface SectionSpec {
  name: SectionName;
  bars: number;
  /** Tracks the DJ plays in this section. */
  wants: ReadonlySet<TrackId>;
  /** A strict section must not hear the tracks it does not want (beyond MAX_SPILL_BARS). */
  strict: boolean;
}

export const ARRANGEMENT: readonly SectionSpec[] = [
  { name: 'intro', bars: 4, wants: new Set<TrackId>([0, 3]), strict: false },
  { name: 'build', bars: 4, wants: new Set<TrackId>([0, 2, 3, 4]), strict: false },
  { name: 'peak', bars: 8, wants: new Set<TrackId>([0, 1, 2, 3, 4, 5, 6]), strict: false },
  { name: 'breakdown', bars: 4, wants: new Set<TrackId>([5, 6, 7]), strict: true },
];

export const CYCLE_BARS = ARRANGEMENT.reduce((n, s) => n + s.bars, 0);

/** Bars a drum or bass note laid late in the peak may ring into the breakdown (it thins out over them). */
export const MAX_SPILL_BARS = 2;

export interface MusicOptions {
  key?: Key;
  /** Scale degrees of the progression (default i-VI-III-VII in minor, I-V-vi-IV in major). */
  degrees?: readonly number[];
}

export interface MusicContext {
  /** Bars since the DJ's first planned bar. */
  bar: number;
  cycle: number;
  section: SectionName;
  /** 0-based bar inside the section. */
  barInSection: number;
  sectionBars: number;
  key: Key;
  chords: Chord[];
}

function sectionOf(bar: number): { spec: SectionSpec; barInSection: number } {
  let offset = ((bar % CYCLE_BARS) + CYCLE_BARS) % CYCLE_BARS;
  for (const spec of ARRANGEMENT) {
    if (offset < spec.bars) return { spec, barInSection: offset };
    offset -= spec.bars;
  }
  throw new Error('unreachable: the arrangement covers the cycle');
}

export function musicAt(bar: number, options: MusicOptions = {}): MusicContext {
  const b = Math.max(0, Math.floor(bar));
  const { spec, barInSection } = sectionOf(b);
  const key = options.key ?? A_MINOR;
  return {
    bar: b,
    cycle: Math.floor(b / CYCLE_BARS),
    section: spec.name,
    barInSection,
    sectionBars: spec.bars,
    key,
    chords: options.degrees ? progression(key, options.degrees) : progression(key),
  };
}

/** "section build · A minor · Am-F-C-G": the status line and the stage DJ panel. */
export function musicLabel(music: MusicContext): string {
  return `section ${music.section} · ${keyName(music.key)} · ${progressionName(music.chords)}`;
}

export function sectionSpec(name: SectionName): SectionSpec {
  const spec = ARRANGEMENT.find((s) => s.name === name);
  if (!spec) throw new Error(`unknown section ${name}`);
  return spec;
}

/** Bars of [bar, bar + lifetimeBars) that fall in a strict section which does not want `track`. */
export function spillBars(track: TrackId, bar: number, lifetimeBars: number): number {
  let n = 0;
  for (let b = bar; b < bar + lifetimeBars; b++) {
    const { spec } = sectionOf(b);
    if (spec.strict && !spec.wants.has(track)) n += 1;
  }
  return n;
}
