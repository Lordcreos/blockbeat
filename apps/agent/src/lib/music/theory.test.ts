/**
 * W17: the DJ's music theory, in code so the rules brain sounds like a track without an LLM.
 */
import { describe, expect, it } from 'vitest';
import { pitchedMidiOf, padVoicingOf } from '@blockbeat/shared';
import {
  A_MINOR,
  BASS_TEMPLATES,
  DRUM_TEMPLATES,
  MOTIFS,
  bassLine,
  bassNoteOf,
  chordAtStep,
  degreePitchClass,
  diatonicChord,
  invertMotif,
  isInKey,
  keyName,
  leadNoteOf,
  padNoteFor,
  parseKey,
  pitchPreservingVariants,
  progression,
  progressionName,
  realiseMotif,
  scalePitchClasses,
  shiftMotif,
  snapToKey,
  transposeMotif,
} from './theory';

const pc = (midi: number): number => ((midi % 12) + 12) % 12;

describe('keys and scale degrees', () => {
  it('A minor is A B C D E F G; C major is C D E F G A B', () => {
    expect(scalePitchClasses(A_MINOR)).toEqual([9, 11, 0, 2, 4, 5, 7]);
    expect(scalePitchClasses(parseKey('C major'))).toEqual([0, 2, 4, 5, 7, 9, 11]);
  });

  it('degrees wrap in both directions', () => {
    expect(degreePitchClass(A_MINOR, 0)).toBe(9);
    expect(degreePitchClass(A_MINOR, 4)).toBe(4);
    expect(degreePitchClass(A_MINOR, 7)).toBe(9);
    expect(degreePitchClass(A_MINOR, -1)).toBe(7);
  });

  it('parses and names keys, and rejects nonsense', () => {
    expect(keyName(parseKey('a minor'))).toBe('A minor');
    expect(keyName(parseKey('D minor'))).toBe('D minor');
    expect(keyName(parseKey('F# major'))).toBe('F# major');
    expect(() => parseKey('H dorian')).toThrow(/key/);
  });
});

describe('chords and the progression', () => {
  it('builds diatonic triads: i = Am, VI = F, III = C, VII = G in A minor', () => {
    expect(diatonicChord(A_MINOR, 0)).toMatchObject({ name: 'Am', root: 9, tones: [9, 0, 4] });
    expect(diatonicChord(A_MINOR, 5)).toMatchObject({ name: 'F', root: 5, tones: [5, 9, 0] });
    expect(diatonicChord(A_MINOR, 1).name).toBe('Bdim');
  });

  it('the default progression is i-VI-III-VII in minor (Am-F-C-G) and I-V-vi-IV in major', () => {
    expect(progressionName(progression(A_MINOR))).toBe('Am-F-C-G');
    expect(progressionName(progression(parseKey('C major')))).toBe('C-G-Am-F');
  });

  it('spreads the chords over the 16-step loop, four steps each', () => {
    const prog = progression(A_MINOR);
    expect([0, 3, 4, 7, 8, 12, 15].map((s) => chordAtStep(prog, s).name)).toEqual(['Am', 'Am', 'F', 'F', 'C', 'G', 'G']);
    expect(chordAtStep(progression(A_MINOR, [0, 5]), 9).name).toBe('F');
  });
});

describe('pitches on the kit', () => {
  it('bass notes sound the requested pitch class, an octave up when it fits', () => {
    for (const p of [9, 5, 0, 7]) expect(pc(pitchedMidiOf(4, bassNoteOf(p)))).toBe(p);
    expect(bassNoteOf(9)).toBe(0);
    expect(bassNoteOf(9, { octave: true })).toBe(12);
    // F is semitone 8: no octave above within 0..15, so the same F.
    expect(bassNoteOf(5, { octave: true })).toBe(8);
    expect(bassNoteOf(9, { timbre: 1 })).toBe(16);
  });

  it('lead notes follow scale degrees', () => {
    expect(pc(pitchedMidiOf(5, leadNoteOf(A_MINOR, 2)))).toBe(0);
    expect(leadNoteOf(A_MINOR, 7)).toBe(12);
  });

  it('pads voice every chord with at least three of its tones and nothing outside the key', () => {
    for (const chord of progression(A_MINOR)) {
      const { rootMidi, intervals } = padVoicingOf(padNoteFor(chord, A_MINOR));
      const tones = intervals.map((i) => pc(rootMidi + i));
      expect(chord.tones.filter((t) => tones.includes(t)).length).toBe(3);
      for (const t of tones) expect(scalePitchClasses(A_MINOR)).toContain(t);
    }
    expect(padNoteFor(diatonicChord(A_MINOR, 0), A_MINOR)).toBe(0); // Am7 on A
    // The pad cannot reach an F root (A2 + 0..7): Dm7 (D F A C) over the F bass reads as F6 (architect review).
    expect(padNoteFor(diatonicChord(A_MINOR, 5), A_MINOR)).toBe(5);
  });

  it('checks and snaps notes to the key, keeping the timbre bit', () => {
    expect(isInKey(4, 0, A_MINOR)).toBe(true);
    expect(isInKey(4, 1, A_MINOR)).toBe(false); // A#
    expect(snapToKey(4, 1, A_MINOR)).toBe(0);
    expect(snapToKey(5, 16 + 6, A_MINOR)).toBe(16 + 5); // D# -> D, timbre kept
    expect(isInKey(0, 13, A_MINOR)).toBe(true); // drums have no key
    expect(isInKey(6, 0, A_MINOR)).toBe(true); // Am7
    expect(isInKey(6, 1, A_MINOR)).toBe(false); // A#m7
  });

  it('snaps a pad voicing to an in-key chord type on the same root, else to the tonic chord', () => {
    expect(snapToKey(6, 8, A_MINOR)).toBe(0); // Amaj7 (C#, G#) -> Am7
    expect(snapToKey(6, 1, A_MINOR)).toBe(padNoteFor(diatonicChord(A_MINOR, 0), A_MINOR)); // no A# chord fits A minor
  });

  it('pitch-preserving variants keep the pitch class of bass and lead notes', () => {
    const variants = pitchPreservingVariants(4, 0);
    expect(variants[0]).toBe(0);
    expect(variants).toEqual(expect.arrayContaining([16, 12, 28]));
    for (const v of variants) expect(pc(pitchedMidiOf(4, v))).toBe(9);
    expect(pitchPreservingVariants(4, 8)).toEqual([8, 24]); // F: no octave twin, only the timbre flip
  });

  it('drum variants change the decay bits before the pitch (a kick a semitone off sounds wrong)', () => {
    expect(pitchPreservingVariants(0, 0).slice(0, 4)).toEqual([0, 8, 16, 24]);
    expect(pitchPreservingVariants(0, 0).length).toBe(32);
    expect(pitchPreservingVariants(6, 5)).toEqual([5]); // a pad chord has no stand-in
  });
});

describe('templates', () => {
  it('bass templates follow the chord of each step and stay within the six voices of a track', () => {
    const prog = progression(A_MINOR);
    for (const template of Object.values(BASS_TEMPLATES)) {
      const line = bassLine(template, prog);
      expect(line.length).toBeGreaterThan(0);
      expect(line.length).toBeLessThanOrEqual(6);
      for (const n of line) expect(chordAtStep(prog, n.step).tones).toContain(pc(pitchedMidiOf(4, n.note)));
    }
    expect(bassLine(BASS_TEMPLATES['root-pulse'], prog).map((n) => n.note)).toEqual([0, 8, 3, 10]);
  });

  it('drum templates grow from intro to peak and the breakdown has none', () => {
    const count = (s: keyof typeof DRUM_TEMPLATES): number => DRUM_TEMPLATES[s].length;
    expect(count('intro')).toBeLessThan(count('build'));
    expect(count('build')).toBeLessThan(count('peak'));
    expect(count('breakdown')).toBe(0);
    for (const s of Object.keys(DRUM_TEMPLATES) as Array<keyof typeof DRUM_TEMPLATES>) {
      const perTrack = new Map<number, number>();
      for (const d of DRUM_TEMPLATES[s]) perTrack.set(d.track, (perTrack.get(d.track) ?? 0) + 1);
      for (const n of perTrack.values()) expect(n).toBeLessThanOrEqual(6);
    }
  });
});

describe('motifs and their variations', () => {
  const motif = MOTIFS[0] ?? [];
  it('transpose moves every degree', () => {
    expect(transposeMotif(motif, 2).map((n) => n.degree)).toEqual(motif.map((n) => n.degree + 2));
  });

  it('invert mirrors around the first note', () => {
    const first = motif[0]?.degree ?? 0;
    expect(invertMotif(motif).map((n) => n.degree)).toEqual(motif.map((n) => 2 * first - n.degree));
  });

  it('shift moves steps and wraps in the bar', () => {
    expect(shiftMotif([{ step: 15, degree: 0 }], 2)).toEqual([{ step: 1, degree: 0 }]);
  });

  it('realises a motif in key at an offset', () => {
    const notes = realiseMotif(motif, A_MINOR, 8);
    expect(notes.length).toBe(motif.length);
    for (const n of notes) {
      expect(n.step).toBeGreaterThanOrEqual(8);
      expect(isInKey(5, n.note, A_MINOR)).toBe(true);
    }
  });
});
