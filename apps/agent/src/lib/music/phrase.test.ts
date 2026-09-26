/**
 * W17: phrases. Each bar the DJ plays up to 8 notes that move the live grid toward the
 * section's target arrangement, within the voice cap and never over a human note.
 */
import { describe, expect, it } from 'vitest';
import { pitchedMidiOf, type TrackId } from '@blockbeat/shared';
import { createRoom, liveGrid, type Spec } from '../../../test/liveGrid';
import { musicAt } from './arrangement';
import { applyVariation, chooseSection, composePhrase, notesForBar, sanitizePhrase, sectionTarget, type PhraseNote } from './phrase';
import { A_MINOR, isInKey } from './theory';

const OPTS = { maxNotesPerBar: 8, budgetLeft: 160, lifetimeBars: 8 };
const pc = (midi: number): number => ((midi % 12) + 12) % 12;
const tracksOf = (notes: readonly { track: number }[]): Set<number> => new Set(notes.map((n) => n.track));

describe('section targets', () => {
  it('are in key, within six voices per track, and grow intro < build < peak', () => {
    const sizes: number[] = [];
    for (const bar of [0, 7, 8, 16]) {
      const music = musicAt(bar);
      const target = sectionTarget(music, chooseSection(music, liveGrid([])));
      sizes.push(target.length);
      const perTrack = new Map<number, number>();
      for (const n of target) {
        expect(isInKey(n.track, n.note, A_MINOR)).toBe(true);
        perTrack.set(n.track, (perTrack.get(n.track) ?? 0) + 1);
      }
      for (const count of perTrack.values()) expect(count).toBeLessThanOrEqual(6);
    }
    expect(sizes[0]).toBeLessThan(sizes[1] ?? 0);
    expect(sizes[1]).toBeLessThan(sizes[2] ?? 0);
  });

  it('play only what the section is for: intro kick and clap, build adds kicks, then hats, then bass, breakdown pad and lead', () => {
    const t = (bar: number): Set<number> => tracksOf(sectionTarget(musicAt(bar), chooseSection(musicAt(bar), liveGrid([]))));
    expect([...t(0)].sort()).toEqual([0, 3]);
    expect([...t(4)].sort()).toEqual([0, 3]); // build bar 1: more kicks first
    expect([...t(7)].sort()).toEqual([0, 2, 3, 4]); // then hats, then bass
    expect([...t(8)].sort()).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect([...t(16)].sort()).toEqual([5, 6, 7]);
  });

  it('the bass follows the chord of each step (Am-F-C-G)', () => {
    const music = musicAt(8);
    const bass = sectionTarget(music, chooseSection(music, liveGrid([]))).filter((n) => n.track === 4);
    expect(bass.length).toBeGreaterThanOrEqual(4);
    for (const n of bass) expect(music.chords[Math.floor(n.step / 4)]?.tones).toContain(pc(pitchedMidiOf(4, n.note)));
  });

  it('call and response: the lead motif goes in the half of the bar the room is not playing lead in', () => {
    const music = musicAt(16);
    const roomEarly = liveGrid([
      [1, 5, 3, 10],
      [3, 5, 7, 10],
    ]);
    expect(chooseSection(music, roomEarly).leadHalf).toBe(8);
    const roomLate = liveGrid([[12, 5, 3, 10]]);
    expect(chooseSection(music, roomLate).leadHalf).toBe(0);
  });
});

describe('motif variations', () => {
  const motif = [
    { step: 0, degree: 4 },
    { step: 3, degree: 2 },
  ];
  it('none, transpose +2, invert and shift +1 step each transform the motif', () => {
    expect(applyVariation(motif, 'none')).toEqual(motif);
    expect(applyVariation(motif, 'transpose')).toEqual([
      { step: 0, degree: 6 },
      { step: 3, degree: 4 },
    ]);
    expect(applyVariation(motif, 'invert')).toEqual([
      { step: 0, degree: 4 },
      { step: 3, degree: 6 },
    ]);
    expect(applyVariation(motif, 'shift')).toEqual([
      { step: 1, degree: 4 },
      { step: 4, degree: 2 },
    ]);
  });

  it('the cycle picks another variation, so the second peak does not repeat the first', () => {
    const lead = (bar: number): string =>
      sectionTarget(musicAt(bar), chooseSection(musicAt(bar), liveGrid([])))
        .filter((n) => n.track === 5)
        .map((n) => `${n.step}:${n.note}`)
        .join(' ');
    expect(lead(8)).not.toBe(lead(28));
  });
});

describe('composePhrase', () => {
  it('opens an empty room with the intro backbone', () => {
    const { kept } = composePhrase(liveGrid([]), musicAt(0), OPTS);
    expect(kept.map((n) => `${n.role}@${n.step}`)).toEqual(['kick@0', 'kick@8', 'clap@4', 'clap@12']);
  });

  it('plays up to 8 notes across tracks at the peak', () => {
    const { kept } = composePhrase(liveGrid([]), musicAt(8), OPTS);
    expect(kept.length).toBe(8);
    expect(tracksOf(kept).size).toBeGreaterThanOrEqual(3);
  });

  it('never targets a sounding cell, but re-lights one that goes dark before its step plays', () => {
    // kick@0 plays the whole next bar; kick@8 has 8 blocks left, so it is dark by step 8.
    const grid = liveGrid([
      [0, 0, 10, 20, 'agent'],
      [8, 0, 10, 120, 'agent'],
    ]);
    const { kept, dropped } = composePhrase(grid, musicAt(1), OPTS);
    expect(kept.some((n) => n.track === 0 && n.step === 0)).toBe(false);
    expect(kept.some((n) => n.track === 0 && n.step === 8 && n.note === 10)).toBe(true);
    expect(dropped.some((d) => d.reason === 'live cell')).toBe(true);
  });

  it('never exceeds the voice cap, and leaves one voice for the room on a track humans play', () => {
    // Two human kicks and three DJ kicks = 5 live: with a human on the track the DJ stops at 5 (cap − 1).
    const grid = liveGrid([
      [1, 0, 3, 10],
      [5, 0, 3, 10],
      [0, 0, 10, 10, 'agent'],
      [8, 0, 10, 10, 'agent'],
      [4, 0, 10, 10, 'agent'],
    ]);
    const { kept, dropped } = composePhrase(grid, musicAt(5), OPTS);
    expect(kept.filter((n) => n.track === 0)).toEqual([]);
    expect(dropped.some((d) => d.reason === 'track full')).toBe(true);
  });

  it('stays off a track the room holds (three or more human notes)', () => {
    const grid = liveGrid([
      [0, 3, 1, 10],
      [6, 3, 1, 10],
      [10, 3, 1, 10],
    ]);
    const { kept } = composePhrase(grid, musicAt(0), OPTS);
    expect(kept.some((n) => n.track === 3)).toBe(false);
    expect(kept.some((n) => n.track === 0)).toBe(true);
  });

  it('plays fewer notes when the room is busy', () => {
    const busy: Spec[] = Array.from({ length: 20 }, (_, i): Spec => [i % 16, (5 + (i % 3)) as TrackId, 20 + (i % 8), 10]);
    expect(notesForBar(liveGrid([]), 8, 160)).toBe(8);
    expect(notesForBar(liveGrid(busy), 8, 160)).toBe(4);
    expect(notesForBar(liveGrid([]), 8, 3)).toBe(3);
    expect(composePhrase(liveGrid(busy), musicAt(8), OPTS).kept.length).toBeLessThanOrEqual(4);
  });

  it('moves a note off a human recorded bit to a variant that keeps its pitch', () => {
    // A human played bass A (note 0) on step 0 long ago: the recorded bit is theirs, the cell is dark.
    const grid = liveGrid([[0, 4, 0, 400]]);
    const { kept } = composePhrase(grid, musicAt(6), { ...OPTS, maxNotesPerBar: 16 });
    const bass = kept.find((n) => n.track === 4 && n.step === 0);
    expect(bass).toBeDefined();
    expect(bass?.note).not.toBe(0);
    expect(pc(pitchedMidiOf(4, bass?.note ?? 0))).toBe(9);
  });

  it('adds no drums or bass that would ring through the breakdown', () => {
    // Peak bar 6 (arrangement bar 13): a kick laid now would ring 5 bars into the breakdown.
    const { kept } = composePhrase(liveGrid([]), musicAt(13), OPTS);
    expect(kept.some((n) => [0, 1, 3, 4].includes(n.track))).toBe(false);
    expect(kept.length).toBeGreaterThan(0);
  });

  it('is deterministic', () => {
    const grid = liveGrid([[3, 5, 7, 30]]);
    expect(composePhrase(grid, musicAt(9), OPTS)).toEqual(composePhrase(grid, musicAt(9), OPTS));
  });
});

describe('sanitizePhrase (any brain)', () => {
  it('drops invalid entries and duplicates, snaps pitched notes to the key, and says why', () => {
    const raw: unknown[] = [
      { step: 0, track: 4, note: 1, role: 'bass' }, // A# -> A
      { step: 0, track: 4, note: 3, role: 'bass' }, // duplicate cell
      { step: 99, track: 0, note: 0, role: 'kick' },
      'nonsense',
      { step: 5, track: 5, note: 7, role: 'lead-call' },
    ];
    const report = sanitizePhrase(raw, liveGrid([]), musicAt(8), { maxNotes: 8, lifetimeBars: 8 });
    expect(report.kept).toEqual([
      { step: 0, track: 4, note: 0, role: 'bass' },
      { step: 5, track: 5, note: 7, role: 'lead-call' },
    ]);
    expect(report.snapped).toBe(1);
    expect(report.dropped.map((d) => d.reason).sort()).toEqual(['duplicate', 'invalid', 'invalid']);
  });

  it('drops notes on tracks the section does not play, so the arrangement stays audible (live run: bass in the intro)', () => {
    const raw = [
      { step: 0, track: 0, note: 10, role: 'kick' },
      { step: 4, track: 4, note: 8, role: 'bass' },
    ];
    const report = sanitizePhrase(raw, liveGrid([]), musicAt(0), { maxNotes: 8, lifetimeBars: 8 });
    expect(report.kept.map((n) => n.track)).toEqual([0]);
    expect(report.dropped.map((d) => d.reason)).toEqual(['section']);
  });

  it('caps the phrase at maxNotes', () => {
    const raw = Array.from({ length: 12 }, (_, i) => ({ step: i, track: 2, note: 1 + 8 * (i % 2), role: 'hat' }));
    const report = sanitizePhrase(raw, liveGrid([]), musicAt(8), { maxNotes: 3, lifetimeBars: 8 });
    expect(report.kept.length).toBe(3);
    expect(report.dropped.filter((d) => d.reason === 'over bar cap').length).toBe(9);
  });

  it('applies the drift guard inside the phrase: the same note on neighbouring steps gets a variant', () => {
    const raw = [
      { step: 2, track: 2, note: 1, role: 'hat' },
      { step: 3, track: 2, note: 1, role: 'hat' },
    ];
    const { kept } = sanitizePhrase(raw, liveGrid([]), musicAt(8), { maxNotes: 8, lifetimeBars: 8 });
    expect(kept.map((n) => n.note)).toEqual([1, 9]);
  });
});

describe('drift guard against the grid (W14b, testnet session 4)', () => {
  const one = (step: number, track: TrackId, note: number, specs: Spec[]): number[] =>
    sanitizePhrase([{ step, track, note, role: 'kick' }], liveGrid(specs), musicAt(8), { maxNotes: 8, lifetimeBars: 8 }).kept.map((n) => n.note);

  it('moves a target to a variant when the same note is live one step before or after (a ±1 block landing would toggle it off)', () => {
    // Session 4: a kick landed on step 15 (a -1 miss); the next kick on step 0 landed on 15 again and toggled it off.
    // Drums change the decay bits first, so the pitch stays: 0 -> 8.
    expect(one(0, 0, 0, [[15, 0, 0, 30, 'agent']])).toEqual([8]);
    expect(one(8, 3, 0, [[9, 3, 0, 30, 'agent']])).toEqual([8]);
    // The other wrap: a target on step 15 with the same note live on step 0.
    expect(one(15, 2, 0, [[0, 2, 0, 30, 'agent']])).toEqual([8]);
    expect(one(8, 0, 0, [[10, 0, 0, 30, 'agent']])).toEqual([0]);
  });
});

describe('16 bars in an empty room (the rules DJ alone)', () => {
  const room = createRoom();
  const phrases: PhraseNote[][] = [];
  for (let bar = 0; bar < 16; bar++) {
    const grid = room.gridAt(bar);
    const { kept } = composePhrase(grid, musicAt(bar), OPTS);
    phrases.push(kept);
    room.play(bar, kept);
  }

  it('stays in key, within 8 notes a bar, and never over 6 live notes per track', () => {
    for (let bar = 0; bar < 16; bar++) {
      const phrase = phrases[bar] ?? [];
      expect(phrase.length).toBeLessThanOrEqual(8);
      for (const n of phrase) expect(isInKey(n.track, n.note, A_MINOR)).toBe(true);
      const grid = room.gridAt(bar + 1);
      for (let t = 0; t < 8; t++) expect(grid.cells.filter((c) => c.track === t).length).toBeLessThanOrEqual(6);
    }
  });

  it('varies: the phrases differ bar to bar and between sections', () => {
    const signatures = phrases.map((p) => p.map((n) => `${n.track}@${n.step}n${n.note}`).join(' '));
    const played = signatures.filter((s) => s !== '');
    expect(new Set(played).size).toBe(played.length); // no phrase is ever repeated
    expect(played.length).toBeGreaterThanOrEqual(6);
    expect(tracksOf(phrases.slice(0, 4).flat())).not.toEqual(tracksOf(phrases.slice(8, 16).flat()));
  });

  it('reaches a full groove at the peak: at least 5 tracks sounding with 20+ live notes', () => {
    const grid = room.gridAt(11);
    expect(tracksOf(grid.cells).size).toBeGreaterThanOrEqual(5);
    expect(grid.cells.length).toBeGreaterThanOrEqual(20);
  });
});
