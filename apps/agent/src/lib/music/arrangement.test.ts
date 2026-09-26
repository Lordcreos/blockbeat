import { describe, expect, it } from 'vitest';
import { CYCLE_BARS, musicAt, musicLabel, spillBars } from './arrangement';
import { parseKey } from './theory';

describe('section clock (W17)', () => {
  it('runs intro 4, build 4, peak 8, breakdown 4, then loops', () => {
    expect(CYCLE_BARS).toBe(20);
    const sections = Array.from({ length: 22 }, (_, bar) => musicAt(bar).section);
    expect(sections.slice(0, 4)).toEqual(['intro', 'intro', 'intro', 'intro']);
    expect(sections.slice(4, 8)).toEqual(['build', 'build', 'build', 'build']);
    expect(sections.slice(8, 16).every((s) => s === 'peak')).toBe(true);
    expect(sections.slice(16, 20).every((s) => s === 'breakdown')).toBe(true);
    expect(sections.slice(20, 22)).toEqual(['intro', 'intro']);
    expect(musicAt(21)).toMatchObject({ cycle: 1, barInSection: 1, sectionBars: 4 });
    expect(musicAt(-3).section).toBe('intro'); // before the DJ's first bar: clamps to the start
  });

  it('is deterministic and carries the key and the progression', () => {
    expect(musicAt(9)).toEqual(musicAt(9));
    expect(musicAt(5).chords.map((c) => c.name)).toEqual(['Am', 'F', 'C', 'G']);
    expect(musicAt(5, { key: parseKey('C major') }).chords.map((c) => c.name)).toEqual(['C', 'G', 'Am', 'F']);
  });

  it('prints the status label the stage shows', () => {
    expect(musicLabel(musicAt(5))).toBe('section build · A minor · Am-F-C-G');
    expect(musicLabel(musicAt(0, { degrees: [0, 5] }))).toBe('section intro · A minor · Am-F');
  });

  it('counts the bars a new note would ring into a section that must not hear its track', () => {
    // Kick laid in peak bar 1 (bar 8) rings 8..15: all peak. Laid in bar 12 it rings 4 bars into the breakdown.
    expect(spillBars(0, 8, 8)).toBe(0);
    expect(spillBars(0, 12, 8)).toBe(4);
    expect(spillBars(4, 10, 8)).toBe(2);
    // The breakdown wants pad and lead; the intro tolerates anything fading out.
    expect(spillBars(6, 16, 8)).toBe(0);
    expect(spillBars(5, 12, 8)).toBe(0);
    // No decay (lifetime 0): nothing rings on.
    expect(spillBars(0, 15, 0)).toBe(0);
  });
});
