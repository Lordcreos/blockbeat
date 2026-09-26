import { describe, expect, it } from 'vitest';
import { STEPS } from '@blockbeat/shared';
import { PLAYHEAD_GEOMETRY, decodePatternProp, encodePatternProp, litCells, rowsToPattern } from './pattern';

const PATTERN: bigint[] = Array.from({ length: STEPS }, (_, i) => (i === 0 ? (1n << 255n) | 1n : i === 5 ? 1n << 64n : 0n));

describe('pattern props (bigint words across the server/client boundary)', () => {
  it('round-trips 16 words through hex strings', () => {
    const encoded = encodePatternProp(PATTERN);
    expect(encoded).toHaveLength(STEPS);
    expect(encoded[5]).toBe('0x10000000000000000');
    expect(decodePatternProp(encoded)).toEqual(PATTERN);
  });

  it('refuses anything that is not 16 hex words', () => {
    expect(() => decodePatternProp(['0x1'])).toThrow(/16/);
    expect(() => decodePatternProp(Array.from({ length: STEPS }, () => 'zz'))).toThrow(/hex/);
    expect(() => encodePatternProp([1n])).toThrow(/16/);
  });
});

describe('litCells', () => {
  it('lists every (step, track) with at least one note, in step then track order', () => {
    expect(litCells(PATTERN)).toEqual([
      { step: 0, track: 0 },
      { step: 0, track: 7 },
      { step: 5, track: 2 },
    ]);
  });
});

describe('rowsToPattern', () => {
  it('turns 8 boolean rows into step words with note 0 on each lit cell', () => {
    const rows = Array.from({ length: 8 }, (_, t) => Array.from({ length: STEPS }, (_, s) => (t === 1 && s === 4) || (t === 0 && s === 0)));
    const p = rowsToPattern(rows);
    expect(p[0]).toBe(1n);
    expect(p[4]).toBe(1n << 32n);
    expect(p.filter((w) => w !== 0n)).toHaveLength(2);
  });
});

describe('PLAYHEAD_GEOMETRY (matches Blockbeat._renderSvg: 336×176, cells at 8 + 20·i, 18 px)', () => {
  it('places column k over the cells of step k, as fractions of the SVG', () => {
    expect(PLAYHEAD_GEOMETRY.left(0)).toBeCloseTo(7 / 336, 6);
    expect(PLAYHEAD_GEOMETRY.left(15)).toBeCloseTo((7 + 300) / 336, 6);
    expect(PLAYHEAD_GEOMETRY.width).toBeCloseTo(20 / 336, 6);
    expect(PLAYHEAD_GEOMETRY.top).toBeCloseTo(7 / 176, 6);
    expect(PLAYHEAD_GEOMETRY.height).toBeCloseTo(160 / 176, 6);
  });
});
