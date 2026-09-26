import { describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import { STEPS } from './constants';
import {
  FADE_BARS,
  MAX_LIVE_PER_TRACK,
  NOTE_LIFETIME_BARS,
  fadeOf,
  ghostFadeOf,
  livePattern,
  noteLifetimeBlocks,
  parseMaxLivePerTrack,
  parseNoteLifetimeBars,
  replayFromBlock,
  type LiveHit,
} from './decay';
import { isOn } from './types';

const ALICE = '0x00000000000000000000000000000000000000a1' as Address;
const BOB = '0x00000000000000000000000000000000000000b0' as Address;

function hit(blockNumber: bigint, step: number, track: LiveHit['track'], note: number, extra: Partial<LiveHit> = {}): LiveHit {
  return { blockNumber, logIndex: 0, step, track, note, player: ALICE, on: true, ...extra };
}

describe('constants', () => {
  it('lives 8 bars = 128 blocks (~38 s at 300 ms) and fades over the last 2 bars', () => {
    expect(NOTE_LIFETIME_BARS).toBe(8);
    expect(noteLifetimeBlocks(NOTE_LIFETIME_BARS)).toBe(128n);
    expect(FADE_BARS).toBe(2);
  });
});

describe('livePattern', () => {
  it('a hit is alive at its own block with age 0 and the full life left', () => {
    const live = livePattern([hit(1000n, 3, 0, 5)], 1000n, 8);
    expect(live.count).toBe(1);
    expect(isOn(live.steps[3] ?? 0n, 0, 5)).toBe(true);
    expect(live.steps).toHaveLength(STEPS);
    expect(live.cells).toEqual([
      { step: 3, track: 0, note: 5, lastBlock: 1000n, ageBlocks: 0, remainingBlocks: 128, player: ALICE, hits: 1 },
    ]);
  });

  it('expires at exactly 128 blocks: alive at +127, dark at +128', () => {
    const hits = [hit(1000n, 3, 0, 5)];
    const at127 = livePattern(hits, 1127n, 8);
    expect(at127.count).toBe(1);
    expect(at127.cells[0]?.remainingBlocks).toBe(1);
    const at128 = livePattern(hits, 1128n, 8);
    expect(at128.count).toBe(0);
    expect(at128.steps.every((w) => w === 0n)).toBe(true);
  });

  it('a second hit on the same cell (on=false in the log) refreshes it instead of silencing it', () => {
    const hits = [hit(1000n, 3, 0, 5, { on: true }), hit(1096n, 3, 0, 5, { on: false, player: BOB })];
    const live = livePattern(hits, 1200n, 8);
    expect(live.count).toBe(1);
    expect(live.cells[0]).toMatchObject({ lastBlock: 1096n, ageBlocks: 104, remainingBlocks: 24, player: BOB, hits: 2 });
    // Without the refresh the first hit would be dead by now.
    expect(livePattern(hits.slice(0, 1), 1200n, 8).count).toBe(0);
  });

  it('orders by (blockNumber, logIndex) whatever the input order', () => {
    const later = hit(1010n, 2, 1, 0, { logIndex: 1, player: BOB });
    const earlier = hit(1010n, 2, 1, 0, { logIndex: 0, player: ALICE });
    const older = hit(990n, 2, 1, 0, { logIndex: 7, player: ALICE });
    const live = livePattern([later, older, earlier], 1020n, 8);
    expect(live.cells[0]).toMatchObject({ player: BOB, lastBlock: 1010n, hits: 3 });
  });

  it('keeps cells on different notes of one step and track apart', () => {
    const live = livePattern([hit(1000n, 0, 4, 0), hit(1001n, 1, 4, 7), hit(1001n, 1, 4, 3)], 1001n, 8);
    expect(live.count).toBe(3);
    expect(live.cells.map((c) => `${c.step}:${c.track}:${c.note}`)).toEqual(['0:4:0', '1:4:3', '1:4:7']);
  });

  it('treats a hit ahead of the clock as just played (age 0)', () => {
    const live = livePattern([hit(1005n, 5, 2, 0)], 1000n, 8);
    expect(live.cells[0]).toMatchObject({ ageBlocks: 0, remainingBlocks: 128 });
  });

  it('is empty for no hits and for an all-expired history', () => {
    expect(livePattern([], 5000n, 8).count).toBe(0);
    expect(livePattern([hit(1000n, 0, 0, 0), hit(1100n, 4, 3, 0)], 5000n, 8)).toMatchObject({ count: 0, cells: [] });
  });

  it('honours a custom lifetime', () => {
    const hits = [hit(1000n, 0, 0, 0)];
    expect(livePattern(hits, 1015n, 1).count).toBe(1);
    expect(livePattern(hits, 1016n, 1).count).toBe(0);
  });

  it('rejects a lifetime that is not a positive integer (0 means "no decay", handled by the caller)', () => {
    expect(() => livePattern([], 0n, 0)).toThrow(/positive integer/);
    expect(() => livePattern([], 0n, 1.5)).toThrow(/positive integer/);
  });

  it('is deterministic and does not mutate its input', () => {
    const hits = [hit(1010n, 1, 1, 1, { logIndex: 2 }), hit(1000n, 1, 1, 1)];
    const copy = [...hits];
    expect(livePattern(hits, 1050n, 8)).toEqual(livePattern(copy.reverse(), 1050n, 8));
    expect(hits[0]?.blockNumber).toBe(1010n);
  });
});

describe('fadeOf', () => {
  it('is 1 until the last 2 bars, then falls linearly toward 0', () => {
    expect(fadeOf(128, 8)).toBe(1);
    expect(fadeOf(33, 8)).toBe(1);
    expect(fadeOf(32, 8)).toBe(1);
    expect(fadeOf(16, 8)).toBe(0.5);
    expect(fadeOf(1, 8)).toBeCloseTo(1 / 32);
    expect(fadeOf(0, 8)).toBe(0);
  });

  it('steps in whole bars when motion is reduced', () => {
    expect(fadeOf(32, 8, { reducedMotion: true })).toBe(1);
    expect(fadeOf(31, 8, { reducedMotion: true })).toBe(1);
    expect(fadeOf(17, 8, { reducedMotion: true })).toBe(1);
    expect(fadeOf(16, 8, { reducedMotion: true })).toBe(0.5);
    expect(fadeOf(1, 8, { reducedMotion: true })).toBe(0.5);
    expect(fadeOf(0, 8, { reducedMotion: true })).toBe(0);
  });

  it('fades over the whole life when it is shorter than 2 bars', () => {
    expect(fadeOf(8, 1)).toBe(0.5);
  });
});

describe('parseNoteLifetimeBars', () => {
  it('defaults to 8 when unset or blank', () => {
    expect(parseNoteLifetimeBars(undefined)).toBe(8);
    expect(parseNoteLifetimeBars('  ')).toBe(8);
  });

  it('reads 0 (no decay) and positive integers', () => {
    expect(parseNoteLifetimeBars('0')).toBe(0);
    expect(parseNoteLifetimeBars(' 4 ')).toBe(4);
  });

  it('refuses anything else loudly', () => {
    expect(() => parseNoteLifetimeBars('-1')).toThrow(/NOTE_LIFETIME_BARS/);
    expect(() => parseNoteLifetimeBars('2.5')).toThrow(/NOTE_LIFETIME_BARS/);
    expect(() => parseNoteLifetimeBars('eight')).toThrow(/NOTE_LIFETIME_BARS/);
    expect(() => parseNoteLifetimeBars('1000')).toThrow(/NOTE_LIFETIME_BARS/);
  });
});

describe('livePattern with a voice cap (maxLivePerTrack)', () => {
  const cap = { maxLivePerTrack: 2 };

  it('keeps only the newest K live notes per track and reports the evicted one', () => {
    const hits = [hit(1000n, 0, 0, 0), hit(1001n, 1, 0, 0), hit(1002n, 2, 0, 0), hit(1002n, 2, 1, 0, { logIndex: 1 })];
    const live = livePattern(hits, 1003n, 8, cap);
    expect(live.cells.map((c) => `${c.step}:${c.track}`)).toEqual(['1:0', '2:0', '2:1']);
    expect(live.evicted).toEqual([{ step: 0, track: 0, note: 0, evictedAt: 1002n, sinceBlocks: 1, player: ALICE }]);
    // Without a cap all four are alive.
    expect(livePattern(hits, 1003n, 8).count).toBe(4);
    expect(livePattern(hits, 1003n, 8, { maxLivePerTrack: 0 }).count).toBe(4);
  });

  it('a refresh moves the cell to the newest place instead of adding a voice', () => {
    const hits = [hit(1000n, 0, 0, 0), hit(1001n, 1, 0, 0), hit(1002n, 0, 0, 0), hit(1003n, 2, 0, 0)];
    const live = livePattern(hits, 1003n, 8, cap);
    expect(live.cells.map((c) => c.step)).toEqual([0, 2]);
    expect(live.evicted.map((c) => c.step)).toEqual([1]);
  });

  it('breaks ties inside a block by log index', () => {
    const hits = [hit(1000n, 0, 0, 0, { logIndex: 2 }), hit(1000n, 1, 0, 0, { logIndex: 0 }), hit(1000n, 2, 0, 0, { logIndex: 1 })];
    expect(livePattern(hits, 1000n, 8, cap).cells.map((c) => c.step)).toEqual([0, 2]);
  });

  it('expired notes do not count toward the cap', () => {
    const hits = [hit(1000n, 0, 0, 0), hit(1001n, 1, 0, 0), hit(1200n, 2, 0, 0)];
    const live = livePattern(hits, 1200n, 8, cap);
    expect(live.cells.map((c) => c.step)).toEqual([2]);
    expect(live.evicted).toEqual([]);
  });

  it('an evicted cell hit again comes back as the newest note', () => {
    const hits = [hit(1000n, 0, 0, 0), hit(1001n, 1, 0, 0), hit(1002n, 2, 0, 0), hit(1003n, 0, 0, 0)];
    const live = livePattern(hits, 1003n, 8, cap);
    expect(live.cells.map((c) => c.step)).toEqual([0, 2]);
    expect(live.evicted.map((c) => c.step)).toEqual([1]);
  });

  it('forgets an eviction once it is older than the fade window (2 bars)', () => {
    const hits = [hit(1000n, 0, 0, 0), hit(1001n, 1, 0, 0), hit(1002n, 2, 0, 0)];
    expect(livePattern(hits, 1033n, 8, cap).evicted).toHaveLength(1);
    expect(livePattern(hits, 1034n, 8, cap).evicted).toHaveLength(0);
  });

  it('caps each track on its own', () => {
    const hits = [0, 1, 2].flatMap((s) => [hit(1000n + BigInt(s), s, 0, 0), hit(1000n + BigInt(s), s, 4, 0, { logIndex: 1 })]);
    const live = livePattern(hits, 1003n, 8, cap);
    expect(live.count).toBe(4);
  });
});

describe('ghostFadeOf', () => {
  it('starts at half brightness and reaches 0 after the fade window', () => {
    expect(ghostFadeOf(0, 8)).toBe(0.5);
    expect(ghostFadeOf(16, 8)).toBe(0.25);
    expect(ghostFadeOf(32, 8)).toBe(0);
    expect(ghostFadeOf(16, 8, { reducedMotion: true })).toBe(0.25);
    expect(ghostFadeOf(1, 8, { reducedMotion: true })).toBe(0.5);
  });
});

describe('parseMaxLivePerTrack', () => {
  it('defaults to 6, reads 0 (no cap) and positive integers, refuses the rest', () => {
    expect(MAX_LIVE_PER_TRACK).toBe(6);
    expect(parseMaxLivePerTrack(undefined)).toBe(6);
    expect(parseMaxLivePerTrack('0')).toBe(0);
    expect(parseMaxLivePerTrack('12')).toBe(12);
    expect(() => parseMaxLivePerTrack('-3')).toThrow(/MAX_LIVE_PER_TRACK/);
    expect(() => parseMaxLivePerTrack('513')).toThrow(/MAX_LIVE_PER_TRACK/);
  });
});

describe('a 60-player room at peak (architect review)', () => {
  // ~7 hits/s = 2 per 300 ms block, 60 players spread over the 8 tracks, a deterministic LCG.
  function room(blocks: number): LiveHit[] {
    let seed = 42;
    const next = (n: number): number => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return (seed >>> 16) % n;
    };
    const out: LiveHit[] = [];
    for (let b = 0; b < blocks; b++) {
      for (let i = 0; i < 2; i++) {
        const player = next(60);
        out.push(hit(1000n + BigInt(b), b % 16, (player % 8) as LiveHit['track'], next(8), { logIndex: i, player: `0x${player.toString(16).padStart(40, '0')}` as Address }));
      }
    }
    return out;
  }
  const occupied = (live: ReturnType<typeof livePattern>): number => new Set(live.cells.map((c) => `${c.step}:${c.track}`)).size;

  it('replays only the window that can matter: same answer as the whole history, sorted or presorted', () => {
    const hits = room(2000);
    const now = 2999n;
    const opts = { maxLivePerTrack: MAX_LIVE_PER_TRACK };
    const reference = livePattern([...hits].reverse(), now, 8, opts);
    expect(livePattern(hits, now, 8, { ...opts, presorted: true })).toEqual(reference);
    expect(replayFromBlock(now, 8)).toBe(now - 288n);
    // An old history before the window changes nothing.
    const withOld = [...room(3).map((h) => ({ ...h, blockNumber: h.blockNumber - 900n })), ...hits];
    expect(livePattern(withOld, now, 8, opts)).toEqual(reference);
  });

  it('decay alone keeps most of the grid lit; the 6-voice cap holds it at or under 48 of 128 cells', () => {
    const hits = room(600);
    const now = 1599n;
    expect(occupied(livePattern(hits, now, 8))).toBeGreaterThan(90);
    const capped = livePattern(hits, now, 8, { maxLivePerTrack: MAX_LIVE_PER_TRACK });
    expect(capped.count).toBeLessThanOrEqual(48);
    expect(occupied(capped)).toBeLessThanOrEqual(48);
    // The newest hit of the room always sounds.
    const newest = hits.at(-1);
    expect(capped.cells.some((c) => c.step === newest?.step && c.track === newest.track && c.note === newest.note)).toBe(true);
  });
});
