/**
 * W17: the DJ's music theory. The rules brain composes with it, and the LLM prompt is built
 * from it, so the DJ plays in a key even without an LLM (docs/adr/0002-dj-phrases.md).
 *
 * Pitch classes use C = 0. The kit tunes every pitched track to an A (see
 * @blockbeat/shared voicing.ts), so a pitch class becomes a note by its distance above A.
 *
 * Harmony lives inside the 16-step loop: every note repeats every bar for 8 bars, so a chord
 * change per bar would clash with notes still ringing. Instead the 4-chord progression spans
 * the bar, one chord per 4 steps, and stays fixed for the session.
 */
import { KIT_ROOT_PITCH_CLASS, PAD_CHORD_INTERVALS, PAD_ROOTS, PITCHED_SEMITONES, STEPS, pitchedMidiOf, padVoicingOf, type TrackId } from '@blockbeat/shared';

export type Mode = 'minor' | 'major';

export interface Key {
  /** Pitch class of the tonic, C = 0. */
  tonic: number;
  mode: Mode;
}

export const A_MINOR: Key = { tonic: 9, mode: 'minor' };

const SCALE_INTERVALS: Record<Mode, readonly number[]> = {
  minor: [0, 2, 3, 5, 7, 8, 10],
  major: [0, 2, 4, 5, 7, 9, 11],
};

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;
const LETTER_PC: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

const mod = (n: number, m: number): number => ((n % m) + m) % m;

export function pitchClassName(pc: number): string {
  return NOTE_NAMES[mod(pc, 12)] ?? '?';
}

/** "A minor", "c major", "F# major", "Bb minor". */
export function parseKey(text: string): Key {
  const m = /^\s*([A-Ga-g])([#b]?)\s+(minor|major)\s*$/i.exec(text);
  const letter = m?.[1]?.toUpperCase();
  const mode = m?.[3]?.toLowerCase();
  if (!m || letter === undefined || (mode !== 'minor' && mode !== 'major')) throw new Error(`not a key: "${text}" (expected e.g. "A minor" or "C major")`);
  const accidental = m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0;
  return { tonic: mod((LETTER_PC[letter] ?? 0) + accidental, 12), mode };
}

export function keyName(key: Key): string {
  return `${pitchClassName(key.tonic)} ${key.mode}`;
}

export function scalePitchClasses(key: Key): number[] {
  return SCALE_INTERVALS[key.mode].map((i) => mod(key.tonic + i, 12));
}

/** Semitones above the tonic of a scale degree (0-based, any integer: 7 is the octave, -1 the leading tone below). */
function degreeSemitones(key: Key, degree: number): number {
  const intervals = SCALE_INTERVALS[key.mode];
  return (intervals[mod(degree, 7)] ?? 0) + 12 * Math.floor(degree / 7);
}

export function degreePitchClass(key: Key, degree: number): number {
  return mod(key.tonic + degreeSemitones(key, degree), 12);
}

export interface Chord {
  /** Scale degree the chord is built on (0-based). */
  degree: number;
  root: number;
  quality: 'minor' | 'major' | 'dim';
  name: string;
  /** Root, third, fifth (pitch classes). */
  tones: [number, number, number];
}

export function diatonicChord(key: Key, degree: number): Chord {
  const root = degreePitchClass(key, degree);
  const third = degreePitchClass(key, degree + 2);
  const fifth = degreePitchClass(key, degree + 4);
  const quality = mod(fifth - root, 12) === 6 ? 'dim' : mod(third - root, 12) === 3 ? 'minor' : 'major';
  const suffix = quality === 'dim' ? 'dim' : quality === 'minor' ? 'm' : '';
  return { degree, root, quality, name: `${pitchClassName(root)}${suffix}`, tones: [root, third, fifth] };
}

/** i-VI-III-VII in minor (Am-F-C-G), I-V-vi-IV in major (C-G-Am-F). */
export const DEFAULT_PROGRESSION: Record<Mode, readonly number[]> = { minor: [0, 5, 2, 6], major: [0, 4, 5, 3] };

export function progression(key: Key, degrees: readonly number[] = DEFAULT_PROGRESSION[key.mode]): Chord[] {
  if (degrees.length === 0 || STEPS % degrees.length !== 0) throw new Error(`a progression needs 1, 2, 4, 8 or 16 chords, got ${degrees.length}`);
  return degrees.map((d) => diatonicChord(key, d));
}

export function progressionName(chords: readonly Chord[]): string {
  return chords.map((c) => c.name).join('-');
}

/** The chord that sounds on a step: the progression is spread evenly over the 16 steps. */
export function chordAtStep(chords: readonly Chord[], step: number): Chord {
  const chord = chords[Math.floor((mod(step, STEPS) * chords.length) / STEPS)] ?? chords[0];
  if (!chord) throw new Error('empty progression');
  return chord;
}

function semitoneAboveKitRoot(pc: number): number {
  return mod(pc - KIT_ROOT_PITCH_CLASS, 12);
}

/** Fold a semitone offset into the 0..15 range of bass and lead. */
function foldPitched(semitone: number): number {
  let s = semitone;
  while (s >= PITCHED_SEMITONES) s -= 12;
  while (s < 0) s += 12;
  return s;
}

/** A bass note (track 4) sounding pitch class `pc`; `octave` takes the upper octave when it fits (A..C only). */
export function bassNoteOf(pc: number, options: { octave?: boolean; timbre?: 0 | 1 } = {}): number {
  const s = semitoneAboveKitRoot(pc);
  const semitone = options.octave && s + 12 < PITCHED_SEMITONES ? s + 12 : s;
  return semitone + (options.timbre ?? 0) * PITCHED_SEMITONES;
}

/** A lead note (track 5) for a scale degree, keeping the melodic contour where the 16 semitones allow. */
export function leadNoteOf(key: Key, degree: number, timbre: 0 | 1 = 0): number {
  return foldPitched(semitoneAboveKitRoot(key.tonic) + degreeSemitones(key, degree)) + timbre * PITCHED_SEMITONES;
}

function padTones(note: number): number[] {
  const { rootMidi, intervals } = padVoicingOf(note);
  return [...new Set(intervals.map((i) => mod(rootMidi + i, 12)))];
}

/**
 * The pad voicing (track 6) for a chord. The pad only reaches roots A..E, so this scores all 32
 * voicings: chord tones shared x2, tones outside the key x3 against, +1 for the chord's own root.
 * Am -> Am7, F -> Dm7 (F6 over the bass), C -> Cmaj7, G -> Em7 (G6).
 */
export function padNoteFor(chord: Chord, key: Key): number {
  const scale = new Set(scalePitchClasses(key));
  let best = 0;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (let chordType = 0; chordType < PAD_CHORD_INTERVALS.length; chordType++) {
    for (let root = 0; root < PAD_ROOTS; root++) {
      const note = chordType * PAD_ROOTS + root;
      const tones = padTones(note);
      const shared = chord.tones.filter((t) => tones.includes(t)).length;
      const outside = tones.filter((t) => !scale.has(t)).length;
      const rootBonus = mod(KIT_ROOT_PITCH_CLASS + root, 12) === chord.root ? 1 : 0;
      const score = shared * 2 - outside * 3 + rootBonus;
      if (score > bestScore) {
        bestScore = score;
        best = note;
      }
    }
  }
  return best;
}

const isPitchedLine = (track: number): track is 4 | 5 => track === 4 || track === 5;

/** Whether a note sounds in the key: bass and lead by pitch class, pad by every chord tone; drums and fx always. */
export function isInKey(track: TrackId, note: number, key: Key): boolean {
  const scale = new Set(scalePitchClasses(key));
  if (isPitchedLine(track)) return scale.has(mod(pitchedMidiOf(track, note), 12));
  if (track === 6) return padTones(note).every((t) => scale.has(t));
  return true;
}

/** The nearest in-key note (bass and lead: a semitone down first, timbre kept; pad: an in-key voicing on the same root, else the tonic chord). */
export function snapToKey(track: TrackId, note: number, key: Key): number {
  if (isInKey(track, note, key)) return note;
  if (isPitchedLine(track)) {
    const timbre = note & PITCHED_SEMITONES;
    const s = note & (PITCHED_SEMITONES - 1);
    for (let d = 1; d < 12; d++) {
      for (const c of [s - d, s + d]) if (c >= 0 && c < PITCHED_SEMITONES && isInKey(track, c + timbre, key)) return c + timbre;
    }
    return note;
  }
  if (track === 6) {
    const root = note & (PAD_ROOTS - 1);
    for (let chordType = 0; chordType < PAD_CHORD_INTERVALS.length; chordType++) {
      const alt = chordType * PAD_ROOTS + root;
      if (isInKey(6, alt, key)) return alt;
    }
    return padNoteFor(diatonicChord(key, 0), key);
  }
  return note;
}

/**
 * Stand-ins for a note that cannot be played as is (the cell is live, a human's recorded bit, a
 * drift clash), best first. Bass and lead keep the pitch class (timbre flip, then the other
 * octave), so a moved note stays in key; the pad has no stand-in (another voicing is another
 * chord); drums and fx change the decay bits first, then the pitch index (architect review).
 */
export function pitchPreservingVariants(track: TrackId, note: number): number[] {
  if (isPitchedLine(track)) {
    const s = note & (PITCHED_SEMITONES - 1);
    const t = note & PITCHED_SEMITONES;
    const other = PITCHED_SEMITONES - t;
    const octaves = [s + 12, s - 12].filter((o) => o >= 0 && o < PITCHED_SEMITONES);
    return [note, s + other, ...octaves.map((o) => o + t), ...octaves.map((o) => o + other)];
  }
  if (track === 6) return [note];
  const p = note & 7;
  const order: number[] = [];
  for (let dp = 0; dp < 8; dp++) {
    for (const q of dp === 0 ? [p] : [p + dp, p - dp]) {
      if (q < 0 || q > 7) continue;
      for (let k = 0; k < 4; k++) order.push(((note & 24) ^ (k * 8)) + q);
    }
  }
  return [...new Set(order)];
}

// ---------------------------------------------------------------------------------------------
// Templates

export type SectionName = 'intro' | 'build' | 'peak' | 'breakdown';

export type ChordTone = 'root' | 'third' | 'fifth' | 'octave';

export interface BassTemplate {
  name: string;
  notes: ReadonlyArray<{ step: number; tone: ChordTone }>;
}

export const BASS_TEMPLATES = {
  'root-pulse': { name: 'root-pulse', notes: [0, 4, 8, 12].map((step) => ({ step, tone: 'root' as const })) },
  offbeat: { name: 'offbeat', notes: [2, 6, 10, 14].map((step) => ({ step, tone: 'root' as const })) },
  'octave-bounce': {
    name: 'octave-bounce',
    notes: [
      { step: 0, tone: 'root' },
      { step: 2, tone: 'octave' },
      { step: 4, tone: 'root' },
      { step: 8, tone: 'root' },
      { step: 10, tone: 'octave' },
      { step: 12, tone: 'root' },
    ],
  },
  walk: {
    name: 'walk',
    notes: [
      { step: 0, tone: 'root' },
      { step: 3, tone: 'fifth' },
      { step: 4, tone: 'root' },
      { step: 8, tone: 'root' },
      { step: 11, tone: 'fifth' },
      { step: 12, tone: 'root' },
    ],
  },
} as const satisfies Record<string, BassTemplate>;

export type BassTemplateName = keyof typeof BASS_TEMPLATES;

/** A bass line: each template note on the chord of its step. */
export function bassLine(template: BassTemplate, chords: readonly Chord[], timbre: 0 | 1 = 0): Array<{ step: number; note: number }> {
  return template.notes.map(({ step, tone }) => {
    const chord = chordAtStep(chords, step);
    const pc = tone === 'third' ? chord.tones[1] : tone === 'fifth' ? chord.tones[2] : chord.tones[0];
    return { step, note: bassNoteOf(pc, { octave: tone === 'octave', timbre }) };
  });
}

export type DrumRole = 'kick' | 'clap' | 'hat' | 'open-hat' | 'snare-ghost';

export interface DrumHit {
  step: number;
  track: 0 | 1 | 2 | 3;
  note: number;
  role: DrumRole;
}

/** The kit voices tuned for the W4 demo: kick 10 = A1, clap 11, closed hat 1, open hat 25, snare ghost 2. */
const KICK = (step: number): DrumHit => ({ step, track: 0, note: 10, role: 'kick' });
const CLAP = (step: number): DrumHit => ({ step, track: 3, note: 11, role: 'clap' });
const HAT = (step: number): DrumHit => ({ step, track: 2, note: 1, role: 'hat' });
const OPEN_HAT = (step: number): DrumHit => ({ step, track: 2, note: 25, role: 'open-hat' });
const GHOST = (step: number): DrumHit => ({ step, track: 1, note: 2, role: 'snare-ghost' });

/** Drums per section, most important first (at most 6 per track: the voice cap). */
export const DRUM_TEMPLATES: Record<SectionName, readonly DrumHit[]> = {
  intro: [KICK(0), KICK(8), CLAP(4), CLAP(12)],
  build: [KICK(0), KICK(8), CLAP(4), CLAP(12), KICK(4), KICK(12), HAT(2), HAT(6), HAT(10), HAT(14)],
  peak: [KICK(0), KICK(8), CLAP(4), CLAP(12), KICK(4), KICK(12), HAT(2), HAT(6), HAT(10), HAT(14), GHOST(7), GHOST(15), OPEN_HAT(11), KICK(14)],
  breakdown: [],
};

/** A motif: scale degrees on steps of a half bar (0..7). */
export type Motif = ReadonlyArray<{ step: number; degree: number }>;

export const MOTIFS: readonly Motif[] = [
  // E - C - A, falling: an answer.
  [
    { step: 0, degree: 4 },
    { step: 3, degree: 2 },
    { step: 6, degree: 0 },
  ],
  // A - C - E - D, rising: a call.
  [
    { step: 0, degree: 0 },
    { step: 2, degree: 2 },
    { step: 3, degree: 4 },
    { step: 6, degree: 3 },
  ],
];

export function transposeMotif(motif: Motif, degrees: number): Motif {
  return motif.map((n) => ({ step: n.step, degree: n.degree + degrees }));
}

/** Mirror the contour around the first note. */
export function invertMotif(motif: Motif): Motif {
  const first = motif[0]?.degree ?? 0;
  return motif.map((n) => ({ step: n.step, degree: 2 * first - n.degree }));
}

/** Move every note by `steps`, wrapping in the bar. */
export function shiftMotif(motif: Motif, steps: number): Motif {
  return motif.map((n) => ({ step: mod(n.step + steps, STEPS), degree: n.degree }));
}

/** Lead notes (track 5) of a motif placed at `offset` in the bar. */
export function realiseMotif(motif: Motif, key: Key, offset: number, timbre: 0 | 1 = 0): Array<{ step: number; note: number }> {
  return motif.map((n) => ({ step: mod(offset + n.step, STEPS), note: leadNoteOf(key, n.degree, timbre) }));
}
