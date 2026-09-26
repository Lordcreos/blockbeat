/**
 * Pure description of the Blockbeat kit: which voice sits on which track and how a 5-bit
 * note (0..31) maps to a sound variant. No WebAudio here, so this is unit-testable anywhere.
 *
 * Note layout (drums, pad, fx): low 3 bits = pitch index p (0..7), high 2 bits = variant d (0..3).
 * Bass and lead: low 4 bits = semitone, bit 4 = timbre.
 */
import { NOTES_PER_TRACK, TRACKS, TRACK_META, isNote, isTrackId, type TrackId, type TrackMeta } from '@blockbeat/shared';

export type KitKey = TrackMeta['key'];

/** Voice keys in track order. Derived from the shared contract, never hand-written. */
export const KIT_KEYS: readonly KitKey[] = TRACK_META.map((m) => m.key);

export interface NoteVariant {
  /** Fundamental (drums), chord root (pad) or sweep start (fx), in Hz. */
  pitchHz: number;
  /** Envelope decay in seconds. */
  decaySec: number;
  /** Small integer selecting a timbre (noise colour, chord type, sweep direction, ...). */
  timbre: number;
}

export function assertTrackNote(track: number, note: number): asserts track is TrackId {
  if (!isTrackId(track)) throw new RangeError(`track out of range: ${track} (expected 0..${TRACKS - 1})`);
  if (!isNote(note)) throw new RangeError(`note out of range: ${note} (expected 0..${NOTES_PER_TRACK - 1})`);
}

export function midiToHz(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12);
}

/** Chord intervals for the pad, indexed by the variant bits. */
export const PAD_CHORDS: readonly (readonly number[])[] = [
  [0, 3, 7, 10], // minor 7
  [0, 4, 7, 11], // major 7
  [0, 2, 7, 9], // sus2 add6
  [0, 5, 7, 12], // sus4
];

const KICK_MIDI_BASE = 31; // G1, 49 Hz
const SNARE_MIDI_BASE = 50; // D3 body
const BASS_MIDI_BASE = 33; // A1
const LEAD_MIDI_BASE = 57; // A3
const PAD_MIDI_BASE = 45; // A2
const HAT_DECAYS: readonly number[] = [0.03, 0.06, 0.12, 0.25];

export function noteVariant(track: TrackId, note: number): NoteVariant {
  assertTrackNote(track, note);
  const p = note & 7;
  const d = note >> 3;
  switch (track) {
    case 0: // kick: pitch x decay; every variant is silent well before 150 ms
      return { pitchHz: midiToHz(KICK_MIDI_BASE + p), decaySec: 0.055 + d * 0.015, timbre: d };
    case 1: // snare: body pitch x decay, noise colour alternates with d
      return { pitchHz: midiToHz(SNARE_MIDI_BASE + p), decaySec: 0.09 + d * 0.04, timbre: d };
    case 2: // hat: metallic pitch x closed..open decay
      return { pitchHz: 280 + p * 45, decaySec: HAT_DECAYS[d] ?? 0.03, timbre: d };
    case 3: // clap: band centre x decay, reverb amount follows d
      return { pitchHz: 900 + p * 160, decaySec: 0.08 + d * 0.05, timbre: d };
    case 4: // bass: 16 semitones from A1, bit 4 opens the filter
      return { pitchHz: midiToHz(BASS_MIDI_BASE + (note & 15)), decaySec: 0.16, timbre: note >> 4 };
    case 5: // lead: 16 semitones from A3, bit 4 switches oscillator
      return { pitchHz: midiToHz(LEAD_MIDI_BASE + (note & 15)), decaySec: 0.12, timbre: note >> 4 };
    case 6: // pad: chord root x chord type
      return { pitchHz: midiToHz(PAD_MIDI_BASE + p), decaySec: 0.9, timbre: d };
    case 7: // fx: sweep start x length, direction from bit 2
      return { pitchHz: 150 * 2 ** (p & 3), decaySec: 0.15 * 2 ** d, timbre: p >> 2 };
  }
}
