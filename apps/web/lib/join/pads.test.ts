import { describe, expect, it } from 'vitest';
import { KIT_ROOT_PITCH_CLASS, TRACK_META, isNote, padVoicingOf, pitchedMidiOf, type TrackId } from '@blockbeat/shared';
import { noteVariant } from '@/lib/audio/kitSpec';
import { PADS_PER_TRACK, noteName, padsFor } from './pads';

const TRACKS = TRACK_META.map((m) => m.id);
const semis = (a: number, b: number): number => Math.abs(12 * Math.log2(a / b));

describe('noteName', () => {
  it('names MIDI notes with octave numbers (A4 = 69)', () => {
    expect(noteName(69)).toBe('A4');
    expect(noteName(33)).toBe('A1');
    expect(noteName(36)).toBe('C2');
    expect(noteName(60)).toBe('C4');
    expect(noteName(70)).toBe('A#4');
  });
});

describe('padsFor', () => {
  it.each(TRACKS)('track %i has 8 pads with distinct valid notes and labels', (track) => {
    const pads = padsFor(track);
    expect(pads).toHaveLength(PADS_PER_TRACK);
    expect(new Set(pads.map((p) => p.note)).size).toBe(PADS_PER_TRACK);
    expect(new Set(pads.map((p) => p.label)).size).toBe(PADS_PER_TRACK);
    for (const p of pads) {
      expect(isNote(p.note)).toBe(true);
      expect(p.label.length).toBeGreaterThan(0);
      expect(p.label.length).toBeLessThanOrEqual(11);
    }
  });

  it('bass is A minor pentatonic from A1, labelled with note names', () => {
    const pads = padsFor(4);
    expect(pads.map((p) => p.label)).toEqual(['A1', 'C2', 'D2', 'E2', 'G2', 'A2', 'C3', 'A2 open']);
    // Every label matches the pitch the kit renders.
    expect(noteVariant(4, pads[1]!.note).pitchHz).toBeCloseTo(65.41, 1); // C2
    // The last pad is the same A2 with the filter opened (timbre bit), so it sounds different.
    expect(noteVariant(4, pads[7]!.note).timbre).toBe(1);
    expect(noteVariant(4, pads[7]!.note).pitchHz).toBeCloseTo(noteVariant(4, pads[5]!.note).pitchHz, 5);
  });

  it('lead is A minor pentatonic from A3', () => {
    expect(padsFor(5).map((p) => p.label)).toEqual(['A3', 'C4', 'D4', 'E4', 'G4', 'A4', 'C5', 'A4 saw']);
    expect(noteVariant(5, padsFor(5)[5]!.note).pitchHz).toBeCloseTo(440, 5);
  });

  it('pad plays diatonic chords of A minor', () => {
    // Chord type 2 is sus2 add6 (C D G A), hence C6sus2; an A with it would add F#, out of key.
    expect(padsFor(6).map((p) => p.label)).toEqual(['Am7', 'Cmaj7', 'Dm7', 'Em7', 'Asus4', 'C6sus2', 'Dsus4', 'Esus4']);
    expect(noteVariant(6, padsFor(6)[1]!.note).pitchHz).toBeCloseTo(130.81, 1); // C3 root
  });

  it('W17 key: every bass, lead and pad-chord pitch is in A natural minor, read through the shared voicing', () => {
    const aMinor = new Set([0, 2, 3, 5, 7, 8, 10].map((d) => (KIT_ROOT_PITCH_CLASS + d) % 12));
    for (const track of [4, 5] as const) {
      for (const pad of padsFor(track)) expect(aMinor.has(pitchedMidiOf(track, pad.note) % 12), `${track} ${pad.label}`).toBe(true);
    }
    for (const pad of padsFor(6)) {
      const { rootMidi, intervals } = padVoicingOf(pad.note);
      for (const i of intervals) expect(aMinor.has((rootMidi + i) % 12), `pad ${pad.label} +${i}`).toBe(true);
    }
  });

  it('melodic pads say they are melodic; drum pads do not', () => {
    expect(padsFor(4)[0]!.melodic).toBe(true);
    expect(padsFor(0)[0]!.melodic).toBe(false);
  });

  it('hat labels follow the rendered decay: closed pads are short, open pads long', () => {
    const pads = padsFor(2);
    const decay = (label: string): number => noteVariant(2, pads.find((p) => p.label === label)!.note).decaySec;
    expect(decay('Closed')).toBeLessThan(0.05);
    expect(decay('Open')).toBeGreaterThan(0.2);
    expect(decay('Half open')).toBeGreaterThan(decay('Closed'));
  });

  it('fx labels follow the rendered direction (riser = timbre 0, drop and zap = 1)', () => {
    for (const p of padsFor(7)) {
      const dir = noteVariant(7, p.note).timbre;
      expect(dir).toBe(/riser/i.test(p.label) ? 0 : 1);
    }
  });

  it.each(TRACKS)('track %i: every pair of pads is audibly different (>= 1 semitone, >= 30%% decay, or another timbre)', (track: TrackId) => {
    const vs = padsFor(track).map((p) => noteVariant(track, p.note));
    for (let i = 0; i < vs.length; i++) {
      for (let j = i + 1; j < vs.length; j++) {
        const a = vs[i]!;
        const b = vs[j]!;
        const differs = semis(a.pitchHz, b.pitchHz) >= 0.99 || Math.max(a.decaySec, b.decaySec) / Math.min(a.decaySec, b.decaySec) >= 1.3 || a.timbre !== b.timbre;
        expect(differs, `pads ${i} and ${j}`).toBe(true);
      }
    }
  });
});
