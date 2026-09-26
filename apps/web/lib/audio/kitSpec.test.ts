import { describe, expect, it } from 'vitest';
import { NOTES_PER_TRACK, TRACKS, TRACK_META, type TrackId } from '@blockbeat/shared';
import { KIT_KEYS, assertTrackNote, noteVariant } from './kitSpec';

describe('kit spec', () => {
  it('defines exactly eight voices in TRACK_META order', () => {
    expect(KIT_KEYS).toHaveLength(8);
    expect(KIT_KEYS).toEqual(TRACK_META.map((m) => m.key));
  });

  it('maps every (track, note) pair to a distinct, finite variant', () => {
    for (let t = 0; t < TRACKS; t++) {
      const seen = new Set<string>();
      for (let n = 0; n < NOTES_PER_TRACK; n++) {
        const v = noteVariant(t as TrackId, n);
        expect(Number.isFinite(v.pitchHz) && v.pitchHz > 0).toBe(true);
        expect(Number.isFinite(v.decaySec) && v.decaySec > 0).toBe(true);
        expect(Number.isInteger(v.timbre) && v.timbre >= 0).toBe(true);
        seen.add(`${v.pitchHz}|${v.decaySec}|${v.timbre}`);
      }
      expect(seen.size).toBe(NOTES_PER_TRACK);
    }
  });

  it('keeps every kick variant tight enough to be silent by 150 ms', () => {
    for (let n = 0; n < NOTES_PER_TRACK; n++) {
      expect(noteVariant(0, n).decaySec).toBeLessThanOrEqual(0.1);
    }
  });

  it('rejects out-of-range tracks and notes', () => {
    expect(() => assertTrackNote(8, 0)).toThrow(RangeError);
    expect(() => assertTrackNote(-1, 0)).toThrow(RangeError);
    expect(() => assertTrackNote(0, 32)).toThrow(RangeError);
    expect(() => assertTrackNote(0, 1.5)).toThrow(RangeError);
    expect(() => assertTrackNote(7, 31)).not.toThrow();
  });
});
