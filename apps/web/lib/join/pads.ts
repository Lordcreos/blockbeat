/**
 * W16: what the eight phone pads play on each track, and what they are called. The notes are
 * chosen from what lib/audio/kitSpec actually renders (noteVariant), so a label never lies:
 *
 * - bass and lead: A minor pentatonic across the 16 semitones the kit covers (A..C an octave
 *   and a third up), plus the top A with the timbre bit (bass filter open, lead saw).
 * - pad: chords of A minor whose every note is in the key (root in the low 3 bits, chord
 *   type in the high 2).
 * Pitched notes are built with the shared voicing (packages/shared/src/voicing.ts, W17), the
 * same table the DJ composes with, so the phone stays in the DJ's key (A minor by default).
 * - drums and fx: variants named after their rendered pitch, decay or direction.
 *
 * Any two pads of a track differ by at least a semitone, 30 % of decay or a timbre (tested),
 * so a player hears that different places make different sounds.
 */
import { PITCHED_SEMITONES, PITCHED_TRACK_ROOT_MIDI, padNoteOf, pitchedNoteOf, type TrackId } from '@blockbeat/shared';

export const PADS_PER_TRACK = 8;

export interface PadSpec {
  /** The 5-bit note sent to hit(). */
  note: number;
  /** Short name on the pad: a note name, a chord or a drum variant. */
  label: string;
  /** True when the label is a pitch or a chord (bass, lead, pad). */
  melodic: boolean;
}

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;

/** Scientific pitch name of a MIDI note (69 = A4). */
export function noteName(midi: number): string {
  return `${NAMES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;
}

/** A minor pentatonic inside the kit's 16 semitones above A. */
const PENTATONIC = [0, 3, 5, 7, 10, 12, 15] as const;
const OCTAVE = 12;

/** Bass or lead: the pentatonic, then the octave A with the timbre bit (bass filter open, lead saw). */
function scale(track: 4 | 5, altSuffix: string): PadSpec[] {
  const root = PITCHED_TRACK_ROOT_MIDI[track];
  const pads: PadSpec[] = PENTATONIC.filter((semi) => semi < PITCHED_SEMITONES).map((semi) => ({ note: pitchedNoteOf(semi, 0), label: noteName(root + semi), melodic: true }));
  pads.push({ note: pitchedNoteOf(OCTAVE, 1), label: `${noteName(root + OCTAVE)} ${altSuffix}`, melodic: true });
  return pads;
}

/** Pad chord types (packages/shared voicing): minor 7, major 7, sus2 add6, sus4. */
const M7 = 0;
const MAJ7 = 1;
const SIX_SUS2 = 2;
const SUS4 = 3;
const chord = (root: number, type: number, label: string): PadSpec => ({ note: padNoteOf(root, type), label, melodic: true });

/** Drums, pad and fx: note = pitch index p (0..7) | variant d (0..3) << 3. */
const pd = (p: number, d: number): number => p | (d << 3);
const drum = (list: ReadonlyArray<readonly [number, number, string]>): PadSpec[] => list.map(([p, d, label]) => ({ note: pd(p, d), label, melodic: false }));

const TABLE: Readonly<Record<TrackId, readonly PadSpec[]>> = {
  // kick: pitch G1 + p semitones, decay grows with d
  0: drum([
    [0, 3, 'Deep'],
    [0, 0, 'Deep short'],
    [2, 2, 'Round'],
    [2, 0, 'Round tight'],
    [4, 2, 'Punch'],
    [4, 0, 'Tight'],
    [7, 3, 'High'],
    [7, 0, 'Click'],
  ]),
  // snare: body pitch D3 + p, decay with d, white noise on even d and pink on odd d
  1: drum([
    [7, 0, 'Rim'],
    [4, 0, 'Tight'],
    [5, 2, 'Crack'],
    [5, 1, 'Snap'],
    [0, 1, 'Warm'],
    [2, 3, 'Fat'],
    [0, 0, 'Ghost'],
    [7, 2, 'Long'],
  ]),
  // hat: metallic pitch 280 + 45p Hz, decay 30 / 60 / 120 / 250 ms by d
  2: drum([
    [3, 0, 'Closed'],
    [7, 0, 'Tick'],
    [0, 0, 'Low tick'],
    [1, 1, 'Pedal'],
    [4, 2, 'Half open'],
    [7, 2, 'Sizzle'],
    [3, 3, 'Open'],
    [0, 3, 'Open low'],
  ]),
  // clap: band centre 900 + 160p Hz, decay and room send grow with d
  3: drum([
    [7, 0, 'Snap'],
    [3, 0, 'Dry'],
    [0, 0, 'Low dry'],
    [4, 1, 'Room'],
    [4, 2, 'Big room'],
    [3, 3, 'Hall'],
    [7, 3, 'Hall bright'],
    [0, 3, 'Low hall'],
  ]),
  4: scale(4, 'open'),
  5: scale(5, 'saw'),
  // pad: root A2 + semitones (A=0, C=3, D=5, E=7); every chord tone is in A minor (tested)
  6: [
    chord(0, M7, 'Am7'),
    chord(3, MAJ7, 'Cmaj7'),
    chord(5, M7, 'Dm7'),
    chord(7, M7, 'Em7'),
    chord(0, SUS4, 'Asus4'),
    chord(3, SIX_SUS2, 'C6sus2'),
    chord(5, SUS4, 'Dsus4'),
    chord(7, SUS4, 'Esus4'),
  ],
  // fx: start 150 * 2^(p & 3) Hz, length 0.15 * 2^d s, p >= 4 = drop (zap down), else riser
  7: drum([
    [0, 1, 'Riser short'],
    [1, 2, 'Riser'],
    [0, 3, 'Riser long'],
    [3, 2, 'High riser'],
    [4, 0, 'Zap'],
    [7, 0, 'Zap high'],
    [5, 2, 'Drop'],
    [4, 3, 'Drop long'],
  ]),
};

export function padsFor(track: TrackId): readonly PadSpec[] {
  return TABLE[track];
}

/** The pad a note came from on this track, or null (another phone's or the DJ's variant). */
export function padIndexOf(track: TrackId, note: number): number | null {
  const i = TABLE[track].findIndex((p) => p.note === note);
  return i < 0 ? null : i;
}
