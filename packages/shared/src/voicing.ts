/**
 * W17: how a 5-bit note sounds on the pitched tracks, as a contract between the stage kit
 * (apps/web/lib/audio/kitSpec.ts plays it) and the DJ (apps/agent composes in a key with it).
 * The kit keeps its own copy; apps/agent/src/lib/music/voicing.contract.test.ts checks the two agree.
 *
 * - bass (4) and lead (5): bits 0-3 = semitone above the track root, bit 4 = timbre.
 * - pad (6): bits 0-2 = chord root above A2 (0..7 semitones), bits 3-4 = chord type.
 */

/** MIDI note of semitone 0 on each pitched track: A1, A3, A2. */
export const PITCHED_TRACK_ROOT_MIDI = { 4: 33, 5: 57, 6: 45 } as const;
export type PitchedTrack = keyof typeof PITCHED_TRACK_ROOT_MIDI;

/** Every track root is an A (C = 0, so A = 9). */
export const KIT_ROOT_PITCH_CLASS = 9;

/** Semitones reachable on bass and lead (bits 0-3). */
export const PITCHED_SEMITONES = 16;
/** Chord roots reachable on the pad (bits 0-2). */
export const PAD_ROOTS = 8;

/** Pad chord intervals by chord type (bits 3-4): minor 7, major 7, sus2 add6, sus4. */
export const PAD_CHORD_INTERVALS: readonly (readonly number[])[] = [
  [0, 3, 7, 10],
  [0, 4, 7, 11],
  [0, 2, 7, 9],
  [0, 5, 7, 12],
];

/** MIDI pitch of a bass (4) or lead (5) note. */
export function pitchedMidiOf(track: 4 | 5, note: number): number {
  return PITCHED_TRACK_ROOT_MIDI[track] + (note & (PITCHED_SEMITONES - 1));
}

/** The bass / lead note for a semitone above the root (0..15) and a timbre (0 or 1). */
export function pitchedNoteOf(semitone: number, timbre: 0 | 1): number {
  if (!Number.isInteger(semitone) || semitone < 0 || semitone >= PITCHED_SEMITONES) throw new RangeError(`semitone out of range: ${semitone}`);
  return semitone + timbre * PITCHED_SEMITONES;
}

/** The pad note for a root above A2 (0..7) and a chord type (0..3). */
export function padNoteOf(root: number, chordType: number): number {
  if (!Number.isInteger(root) || root < 0 || root >= PAD_ROOTS) throw new RangeError(`pad root out of range: ${root}`);
  if (!Number.isInteger(chordType) || chordType < 0 || chordType >= PAD_CHORD_INTERVALS.length) throw new RangeError(`pad chord type out of range: ${chordType}`);
  return chordType * PAD_ROOTS + root;
}

/** Root MIDI note and intervals of a pad note. */
export function padVoicingOf(note: number): { rootMidi: number; intervals: readonly number[] } {
  return { rootMidi: PITCHED_TRACK_ROOT_MIDI[6] + (note & (PAD_ROOTS - 1)), intervals: PAD_CHORD_INTERVALS[(note >> 3) & 3] ?? [] };
}

/**
 * W19: the DJ's default harmony (ADR 0002) as note numbers, so simulated players stay in its
 * key: A minor, i-VI-III-VII = Am-F-C-G, one chord per 4 steps of the loop. `tones` are
 * semitones above A; `bass` and `lead` are bass / lead notes (timbre 0) on chord tones, root
 * first; `pad` is the DJ's voicing (Am7, Dm7 as F6, Cmaj7, Em7 as G6).
 */
export interface LoopChord {
  name: 'Am' | 'F' | 'C' | 'G';
  tones: readonly number[];
  bass: readonly number[];
  lead: readonly number[];
  pad: number;
}

export const A_MINOR_LOOP: readonly LoopChord[] = [
  { name: 'Am', tones: [0, 3, 7], bass: [0, 7, 12], lead: [0, 3, 7, 12, 15], pad: padNoteOf(0, 0) },
  { name: 'F', tones: [8, 0, 3], bass: [8, 3, 12], lead: [0, 3, 8, 12, 15], pad: padNoteOf(5, 0) },
  { name: 'C', tones: [3, 7, 10], bass: [3, 10, 7], lead: [3, 7, 10, 15], pad: padNoteOf(3, 1) },
  { name: 'G', tones: [10, 2, 5], bass: [10, 5, 14], lead: [2, 5, 10, 14], pad: padNoteOf(7, 0) },
];

/** The chord that sounds on a loop step (0..15). */
export function loopChordAt(step: number): LoopChord {
  const chord = Number.isInteger(step) && step >= 0 && step < 16 ? A_MINOR_LOOP[Math.floor(step / 4)] : undefined;
  if (!chord) throw new RangeError(`step out of range: ${step}`);
  return chord;
}

/** In-key notes for a pitched track on a step (bass 4, lead 5, pad 6); null for drums and fx. */
export function inKeyNotesFor(track: number, step: number): readonly number[] | null {
  const chord = loopChordAt(step);
  if (track === 4) return chord.bass;
  if (track === 5) return chord.lead;
  if (track === 6) return [chord.pad];
  return null;
}
