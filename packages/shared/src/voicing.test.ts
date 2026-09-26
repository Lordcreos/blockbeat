import { describe, expect, it } from 'vitest';
import { A_MINOR_LOOP, KIT_ROOT_PITCH_CLASS, PAD_CHORD_INTERVALS, PITCHED_TRACK_ROOT_MIDI, inKeyNotesFor, loopChordAt, padNoteOf, padVoicingOf, pitchedMidiOf, pitchedNoteOf } from './voicing';

describe('note layout of the pitched tracks (W17)', () => {
  it('bass and lead: bits 0-3 are the semitone above the track root, bit 4 the timbre', () => {
    expect(pitchedMidiOf(4, 0)).toBe(PITCHED_TRACK_ROOT_MIDI[4]);
    expect(pitchedMidiOf(4, 15)).toBe(PITCHED_TRACK_ROOT_MIDI[4] + 15);
    expect(pitchedMidiOf(4, 16 + 3)).toBe(PITCHED_TRACK_ROOT_MIDI[4] + 3);
    expect(pitchedMidiOf(5, 7)).toBe(PITCHED_TRACK_ROOT_MIDI[5] + 7);
    expect(pitchedNoteOf(3, 1)).toBe(19);
    expect(pitchedNoteOf(3, 0)).toBe(3);
  });

  it('pad: bits 0-2 are the chord root above A2, bits 3-4 the chord type', () => {
    expect(padNoteOf(0, 0)).toBe(0);
    expect(padNoteOf(3, 1)).toBe(11);
    expect(padVoicingOf(11)).toEqual({ rootMidi: PITCHED_TRACK_ROOT_MIDI[6] + 3, intervals: PAD_CHORD_INTERVALS[1] });
    expect(() => padNoteOf(8, 0)).toThrow(RangeError);
    expect(() => pitchedNoteOf(16, 0)).toThrow(RangeError);
  });

  it('every root is an A, so the kit tonic is pitch class 9', () => {
    expect(KIT_ROOT_PITCH_CLASS).toBe(9);
    for (const midi of Object.values(PITCHED_TRACK_ROOT_MIDI)) expect(midi % 12).toBe(KIT_ROOT_PITCH_CLASS);
  });
});

describe('A-minor loop harmony (W19, the DJ\'s Am-F-C-G across the 16 steps)', () => {
  const A_MINOR_PCS = new Set([9, 11, 0, 2, 4, 5, 7]); // A B C D E F G

  it('one chord per 4 steps: Am on 0-3, F on 4-7, C on 8-11, G on 12-15', () => {
    expect([0, 3, 4, 7, 8, 11, 12, 15].map((s) => loopChordAt(s).name)).toEqual(['Am', 'Am', 'F', 'F', 'C', 'C', 'G', 'G']);
    expect(A_MINOR_LOOP).toHaveLength(4);
    expect(() => loopChordAt(16)).toThrow(RangeError);
  });

  it('bass and lead notes are chord tones inside the kit range, pad notes are the DJ voicings', () => {
    for (const chord of A_MINOR_LOOP) {
      const tones = new Set(chord.tones.map((t) => t % 12));
      for (const note of chord.bass) {
        expect(note).toBeGreaterThanOrEqual(0);
        expect(note).toBeLessThan(16);
        expect(tones.has(note % 12)).toBe(true);
        expect(A_MINOR_PCS.has(pitchedMidiOf(4, note) % 12)).toBe(true);
      }
      for (const note of chord.lead) {
        expect(tones.has(note % 12)).toBe(true);
        expect(A_MINOR_PCS.has(pitchedMidiOf(5, note) % 12)).toBe(true);
      }
      const { rootMidi, intervals } = padVoicingOf(chord.pad);
      for (const i of intervals) expect(A_MINOR_PCS.has((rootMidi + i) % 12)).toBe(true);
    }
    // ADR 0002: Am -> Am7, F -> Dm7, C -> Cmaj7, G -> Em7.
    expect(A_MINOR_LOOP.map((c) => c.pad)).toEqual([padNoteOf(0, 0), padNoteOf(5, 0), padNoteOf(3, 1), padNoteOf(7, 0)]);
    expect(A_MINOR_LOOP.map((c) => c.bass[0])).toEqual([0, 8, 3, 10]);
  });

  it('inKeyNotesFor gives the chord of the step for melodic tracks and null for drums and fx', () => {
    expect(inKeyNotesFor(4, 5)).toEqual(A_MINOR_LOOP[1]?.bass);
    expect(inKeyNotesFor(5, 9)).toEqual(A_MINOR_LOOP[2]?.lead);
    expect(inKeyNotesFor(6, 13)).toEqual([A_MINOR_LOOP[3]?.pad]);
    for (const t of [0, 1, 2, 3, 7]) expect(inKeyNotesFor(t, 0)).toBeNull();
  });
});
