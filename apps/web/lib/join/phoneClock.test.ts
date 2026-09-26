import { describe, expect, it, vi } from 'vitest';
import type { BlockClock, BlockClockState } from '@/lib/types';
import { aimClockFrom, createClockProxy } from './phoneClock';

function fakeBlockClock() {
  let block = 0n;
  const steps = new Set<(step: number, at: number) => void>();
  const heads = new Set<(b: bigint) => void>();
  const clock: BlockClock = {
    getState: (): BlockClockState => ({ currentBlock: block, currentStep: Number(block % 16n), measuredBlockMs: 300, msSinceHead: 0, source: 'mock' }),
    onStep(cb) {
      steps.add(cb);
      return () => steps.delete(cb);
    },
    onHead(cb) {
      heads.add(cb);
      return () => heads.delete(cb);
    },
    predictBlock: () => block,
    start: vi.fn(),
    stop: vi.fn(),
  };
  return {
    clock,
    step(to: bigint) {
      block = to;
      for (const cb of [...steps]) cb(Number(to % 16n), 0);
    },
    head(to: bigint) {
      block = to;
      for (const cb of [...heads]) cb(to);
    },
    listeners: () => steps.size + heads.size,
  };
}

describe('aimClockFrom', () => {
  it('has no head until the clock emitted one', () => {
    const f = fakeBlockClock();
    const aim = aimClockFrom(f.clock);
    expect(aim.head()).toBeNull();
    f.head(500n);
    expect(aim.head()).toBe(500n);
  });

  it('fires onBlock once per block, from predicted ticks and heads alike', () => {
    const f = fakeBlockClock();
    const aim = aimClockFrom(f.clock);
    const seen: bigint[] = [];
    aim.onBlock((b) => seen.push(b));
    f.head(500n);
    f.step(500n); // the lock emits the same block as a step: no duplicate
    f.step(501n);
    f.head(501n);
    f.step(502n);
    expect(seen).toEqual([500n, 501n, 502n]);
  });

  it('bases the sub-block position on the last real head once one arrived', () => {
    const f = fakeBlockClock();
    let t = 10_000;
    const aim = aimClockFrom(f.clock, () => t);
    f.head(800n);
    t += 90;
    f.step(801n); // a predicted tick does not move the ruler
    expect(aim.position?.()).toBeCloseTo(800.3, 5);
    t += 300;
    expect(aim.position?.()).toBeCloseTo(801.3, 5); // a late head: the position keeps going
    t += 3000;
    expect(aim.position?.()).toBe(803); // but not forever
    f.head(802n);
    expect(aim.position?.()).toBe(802);
  });

  it('knows its sub-block position from the last tick before any head', () => {
    const f = fakeBlockClock();
    let t = 10_000;
    const aim = aimClockFrom(f.clock, () => t);
    expect(aim.position?.()).toBeNull();
    f.step(500n);
    expect(aim.position?.()).toBe(500);
    t += 150;
    expect(aim.position?.()).toBeCloseTo(500.5, 5);
    t += 400; // no tick yet: never past the next block
    expect(aim.position?.()).toBeCloseTo(500.999, 5);
    expect(aim.blockMs?.()).toBe(300);
  });

  it('dispose unsubscribes from the block clock', () => {
    const f = fakeBlockClock();
    const aim = aimClockFrom(f.clock);
    expect(f.listeners()).toBe(2);
    aim.dispose();
    expect(f.listeners()).toBe(0);
  });
});

describe('createClockProxy', () => {
  it('has no head and fires nothing until attached, then forwards the attached clock', () => {
    const f = fakeBlockClock();
    const proxy = createClockProxy();
    const seen: bigint[] = [];
    proxy.onBlock((b) => seen.push(b));
    expect(proxy.head()).toBeNull();
    const detach = proxy.attach(aimClockFrom(f.clock));
    f.head(700n);
    expect(proxy.head()).toBe(700n);
    expect(proxy.position?.()).toBeGreaterThanOrEqual(700);
    expect(proxy.blockMs?.()).toBe(300);
    expect(seen).toEqual([700n]);
    detach();
    f.head(701n);
    expect(proxy.head()).toBeNull();
    expect(seen).toEqual([700n]);
  });

  it('a stale detach does not drop a newer attachment', () => {
    const a = fakeBlockClock();
    const b = fakeBlockClock();
    const proxy = createClockProxy();
    const detachA = proxy.attach(aimClockFrom(a.clock));
    proxy.attach(aimClockFrom(b.clock));
    detachA();
    b.head(9n);
    expect(proxy.head()).toBe(9n);
  });
});
