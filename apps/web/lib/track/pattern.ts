/**
 * W15: the recorded pattern on its way to a player. Server components read bigint words from
 * the chain and hand them to client components as hex strings (the props stay plain JSON).
 */
import { STEPS, TRACKS, decodeStep, isTrackId, type Pattern, type TrackId } from '@blockbeat/shared';

const HEX_RE = /^0x[0-9a-f]+$/i;

export function encodePatternProp(pattern: Pattern): string[] {
  if (pattern.length !== STEPS) throw new Error(`a pattern has ${STEPS} step words, got ${pattern.length}`);
  return pattern.map((w) => `0x${w.toString(16)}`);
}

export function decodePatternProp(words: readonly string[]): bigint[] {
  if (words.length !== STEPS) throw new Error(`a pattern has ${STEPS} step words, got ${words.length}`);
  return words.map((w, i) => {
    if (!HEX_RE.test(w)) throw new Error(`step word ${i} is not hex`);
    return BigInt(w);
  });
}

export interface LitCell {
  step: number;
  track: TrackId;
}

/** Every (step, track) with at least one note, step-major. */
export function litCells(pattern: Pattern): LitCell[] {
  const out: LitCell[] = [];
  pattern.forEach((word, step) => {
    const tracks = new Set(decodeStep(word).map((n) => n.track));
    for (const track of [...tracks].sort((a, b) => a - b)) out.push({ step, track });
  });
  return out;
}

/** 8 rows of 16 booleans (track-major, like the landing demo) to step words, note 0 per lit cell. */
export function rowsToPattern(rows: readonly (readonly boolean[])[]): bigint[] {
  const words = Array.from({ length: STEPS }, () => 0n);
  rows.slice(0, TRACKS).forEach((row, track) => {
    if (!isTrackId(track)) return;
    row.slice(0, STEPS).forEach((lit, step) => {
      if (lit) words[step] = (words[step] ?? 0n) | (1n << BigInt(track * 32));
    });
  });
  return words;
}

/**
 * Where step k sits on the onchain cover, as fractions of the SVG box. Mirrors
 * `Blockbeat._renderSvg`: viewBox 336×176, cell (step, track) at x = 8 + 20·step,
 * y = 8 + 20·track, 18 px square. The column is padded 1 px each side.
 */
const SVG_W = 336;
const SVG_H = 176;
export const PLAYHEAD_GEOMETRY = {
  left: (step: number): number => (7 + 20 * step) / SVG_W,
  width: 20 / SVG_W,
  top: 7 / SVG_H,
  height: (20 * TRACKS) / SVG_H,
  aspect: `${SVG_W} / ${SVG_H}`,
} as const;
