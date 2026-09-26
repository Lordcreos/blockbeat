import { describe, expect, it, vi } from 'vitest';
import { createBlockClock, type HeadSource } from './blockClock';

interface FakeHeads {
  source: HeadSource;
  emit(block: bigint): void;
  fail(error: Error): void;
  unsubscribed: () => boolean;
}

function fakeHeads(kind: 'ws' | 'poll' = 'ws'): FakeHeads {
  let onHead: ((b: bigint) => void) | null = null;
  let onError: ((e: Error) => void) | null = null;
  let unsubscribed = false;
  return {
    source: {
      kind: () => kind,
      subscribe(h, e) {
        onHead = h;
        onError = e;
        return () => {
          unsubscribed = true;
        };
      },
    },
    emit: (b) => onHead?.(b),
    fail: (e) => onError?.(e),
    unsubscribed: () => unsubscribed,
  };
}

function setup(opts: { blockMs?: number } = {}) {
  let t = 0;
  const heads = fakeHeads();
  const clock = createBlockClock({ headSource: heads.source, now: () => t, ...opts });
  clock.start();
  return { heads, clock, advance: (ms: number) => (t += ms) };
}

describe('blockClock', () => {
  it('starts at block 0 with the nominal 300 ms cadence and no lock', () => {
    const { clock } = setup();
    expect(clock.currentBlock()).toBe(0n);
    expect(clock.measuredBlockMs()).toBe(300);
    expect(clock.locked()).toBe(false);
  });

  it('follows heads and ignores stale or duplicate ones', () => {
    const { heads, clock } = setup();
    heads.emit(100n);
    expect(clock.currentBlock()).toBe(100n);
    expect(clock.locked()).toBe(true);
    heads.emit(100n);
    heads.emit(99n);
    expect(clock.currentBlock()).toBe(100n);
    heads.emit(101n);
    expect(clock.currentBlock()).toBe(101n);
  });

  it('measures the block cadence from head arrival times', () => {
    const { heads, clock, advance } = setup();
    for (let i = 0; i < 12; i++) {
      heads.emit(BigInt(1000 + i));
      advance(500);
    }
    expect(clock.measuredBlockMs()).toBe(500);
  });

  it('predicts the block that will be current in N ms from the measured cadence', () => {
    const { heads, clock, advance } = setup();
    heads.emit(100n);
    expect(clock.predictBlockIn(0)).toBe(100n);
    expect(clock.predictBlockIn(299)).toBe(100n);
    expect(clock.predictBlockIn(300)).toBe(101n);
    expect(clock.predictBlockIn(1000)).toBe(103n);
    advance(200);
    expect(clock.predictBlockIn(100)).toBe(101n);
  });

  it('computes the milliseconds until a target block becomes current', () => {
    const { heads, clock, advance } = setup();
    heads.emit(100n);
    expect(clock.msUntilBlock(102n)).toBe(600);
    advance(200);
    expect(clock.msUntilBlock(102n)).toBe(400);
    expect(clock.msUntilBlock(100n)).toBe(0);
    expect(clock.msUntilBlock(50n)).toBe(0);
  });

  it('notifies head listeners in order and reports errors', () => {
    const { heads, clock } = setup();
    const seen: bigint[] = [];
    const errors: Error[] = [];
    clock.onHead((b) => seen.push(b));
    clock.onError((e) => errors.push(e));
    heads.emit(5n);
    heads.emit(6n);
    heads.fail(new Error('socket closed'));
    expect(seen).toEqual([5n, 6n]);
    expect(errors.map((e) => e.message)).toEqual(['socket closed']);
  });

  it('unsubscribes from the head source on stop and ignores later heads', () => {
    const { heads, clock } = setup();
    heads.emit(1n);
    clock.stop();
    expect(heads.unsubscribed()).toBe(true);
    heads.emit(2n);
    expect(clock.currentBlock()).toBe(1n);
  });

  it('exposes the head source kind', () => {
    const heads = fakeHeads('poll');
    const clock = createBlockClock({ headSource: heads.source, now: () => 0 });
    expect(clock.source()).toBe('poll');
  });

  it('is idempotent on start', () => {
    const heads = fakeHeads();
    const subscribe = vi.spyOn(heads.source, 'subscribe');
    const clock = createBlockClock({ headSource: heads.source, now: () => 0 });
    clock.start();
    clock.start();
    expect(subscribe).toHaveBeenCalledTimes(1);
  });
});
