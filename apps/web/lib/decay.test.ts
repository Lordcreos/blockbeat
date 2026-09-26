import { afterEach, describe, expect, it, vi } from 'vitest';
import { emptyPattern, isOn, toggle, type HitEvent } from '@blockbeat/shared';
import { decayConfig, estimateBlock, liveView, ownLiveSteps, sameSteps } from './decay';

const A = '0x1111111111111111111111111111111111111111' as const;
const B = '0x2222222222222222222222222222222222222222' as const;

function hit(blockNumber: bigint, step: number, track: HitEvent['track'], note: number, player: HitEvent['player'] = A, logIndex = 0): HitEvent {
  return { sessionId: 1n, player, blockNumber, step, track, note, on: true, txHash: `0x${blockNumber.toString(16).padStart(64, '0')}`, logIndex };
}

describe('decayConfig', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('defaults to 8 bars and a 6-voice cap', () => {
    vi.stubEnv('NEXT_PUBLIC_NOTE_LIFETIME_BARS', '');
    vi.stubEnv('NEXT_PUBLIC_MAX_LIVE_PER_TRACK', '');
    expect(decayConfig()).toEqual({ lifetimeBars: 8, maxLivePerTrack: 6 });
  });

  it('reads both knobs, 0 meaning off', () => {
    vi.stubEnv('NEXT_PUBLIC_NOTE_LIFETIME_BARS', '0');
    vi.stubEnv('NEXT_PUBLIC_MAX_LIVE_PER_TRACK', '0');
    expect(decayConfig()).toEqual({ lifetimeBars: 0, maxLivePerTrack: 0 });
  });

  it('throws a readable error on a bad value', () => {
    vi.stubEnv('NEXT_PUBLIC_NOTE_LIFETIME_BARS', 'soon');
    expect(() => decayConfig()).toThrow(/NOTE_LIFETIME_BARS/);
  });
});

describe('liveView', () => {
  const config = { lifetimeBars: 8, maxLivePerTrack: 6 };

  it('plays only live notes: an old hit is dark while the recorded pattern still has its bit', () => {
    const hits = [hit(1000n, 3, 0, 0), hit(1100n, 5, 2, 1)];
    const recorded = emptyPattern();
    recorded[3] = toggle(0n, 0, 0);
    recorded[5] = toggle(0n, 2, 1);
    const view = liveView(hits, recorded, 1130n, config);
    expect(view.decay).toBe(true);
    expect(view.count).toBe(1);
    expect(isOn(view.steps[3] ?? 0n, 0, 0)).toBe(false);
    expect(isOn(view.steps[5] ?? 0n, 2, 1)).toBe(true);
    expect(isOn(recorded[3] ?? 0n, 0, 0)).toBe(true);
  });

  it('with decay off it is the recorded pattern, every cell at full life', () => {
    const recorded = emptyPattern();
    recorded[3] = toggle(0n, 0, 0);
    const view = liveView([hit(1000n, 3, 0, 0, B)], recorded, 999_999n, { lifetimeBars: 0, maxLivePerTrack: 6 });
    expect(view.decay).toBe(false);
    expect(view.steps).toEqual(recorded);
    expect(view.cells).toEqual([expect.objectContaining({ step: 3, track: 0, note: 0, player: B, remainingBlocks: Number.POSITIVE_INFINITY })]);
    expect(view.evicted).toEqual([]);
  });

  it('applies the voice cap', () => {
    const hits = Array.from({ length: 8 }, (_, i) => hit(1000n + BigInt(i), i, 1, 0));
    const view = liveView(hits, emptyPattern(), 1008n, config);
    expect(view.count).toBe(6);
    expect(view.evicted.map((c) => c.step)).toEqual([0, 1]);
  });
});

describe('ownLiveSteps', () => {
  it('lists the steps where this player has a live note, with the longest life left', () => {
    const hits = [hit(900n, 9, 0, 0), hit(1000n, 3, 0, 0), hit(1100n, 3, 0, 1), hit(1100n, 7, 0, 0, B, 1)];
    const own = ownLiveSteps(hits, 1120n, A, { lifetimeBars: 8, maxLivePerTrack: 6 });
    expect([...own.entries()]).toEqual([[3, 108]]);
  });

  it('is empty with decay off (the strip then shows landings only) or without an address', () => {
    expect(ownLiveSteps([hit(1000n, 3, 0, 0)], 1000n, A, { lifetimeBars: 0, maxLivePerTrack: 6 }).size).toBe(0);
    expect(ownLiveSteps([hit(1000n, 3, 0, 0)], 1000n, null, { lifetimeBars: 8, maxLivePerTrack: 6 }).size).toBe(0);
  });
});

describe('sameSteps', () => {
  it('compares 16 step words by value', () => {
    expect(sameSteps(emptyPattern(), emptyPattern())).toBe(true);
    const other = emptyPattern();
    other[4] = 1n;
    expect(sameSteps(emptyPattern(), other)).toBe(false);
  });
});

describe('estimateBlock', () => {
  it('adds one block per 300 ms since the hint, never going back', () => {
    expect(estimateBlock({ block: 1000n, atMs: 5_000 }, 5_000)).toBe(1000n);
    expect(estimateBlock({ block: 1000n, atMs: 5_000 }, 5_899)).toBe(1002n);
    expect(estimateBlock({ block: 1000n, atMs: 5_000 }, 4_000)).toBe(1000n);
    expect(estimateBlock(null, 5_000)).toBeNull();
  });
});
