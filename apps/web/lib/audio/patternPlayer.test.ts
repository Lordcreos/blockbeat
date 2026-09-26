import { describe, expect, it, vi } from 'vitest';
import { STEPS, emptyPattern, toggle, type TrackId } from '@blockbeat/shared';
import type { BlockClock } from '../types';
import { PatternPlayer, type TriggerSink } from './patternPlayer';

interface FakeClock {
  clock: Pick<BlockClock, 'onStep'>;
  fire(step: number, atAudioTime: number): void;
  unsubscribed: number;
}

function fakeClock(): FakeClock {
  const listeners = new Set<(step: number, at: number) => void>();
  const state: FakeClock = {
    unsubscribed: 0,
    fire: (step, at) => listeners.forEach((cb) => cb(step, at)),
    clock: {
      onStep: (cb) => {
        listeners.add(cb);
        return () => {
          listeners.delete(cb);
          state.unsubscribed += 1;
        };
      },
    },
  };
  return state;
}

function fakeSink(): TriggerSink & { calls: Array<[TrackId, number, number]> } {
  const calls: Array<[TrackId, number, number]> = [];
  return { calls, trigger: (track, note, at) => calls.push([track, note, at]) };
}

function patternWith(hits: Array<[step: number, track: TrackId, note: number]>): bigint[] {
  const p = emptyPattern();
  for (const [s, t, n] of hits) p[s] = toggle(p[s] ?? 0n, t, n);
  return p;
}

describe('PatternPlayer', () => {
  it('rejects a pattern that is not exactly STEPS words long', () => {
    const player = new PatternPlayer(fakeSink(), { now: () => 0 });
    expect(() => player.setPattern(Array.from({ length: STEPS - 1 }, () => 0n))).toThrow(RangeError);
    expect(() => player.setPattern([...emptyPattern(), 0n])).toThrow(RangeError);
    expect(() => player.setPattern(emptyPattern())).not.toThrow();
  });

  it('triggers every active (track, note) pair of a step at the clock time', () => {
    const sink = fakeSink();
    const player = new PatternPlayer(sink, { now: () => 0 });
    player.setPattern(patternWith([[0, 0, 3], [0, 4, 12], [5, 2, 0]]));
    const clock = fakeClock();
    player.attachClock(clock.clock);

    clock.fire(0, 1.25);
    expect(sink.calls).toEqual([[0, 3, 1.25], [4, 12, 1.25]]);

    clock.fire(5, 2.75);
    expect(sink.calls[2]).toEqual([2, 0, 2.75]);
  });

  it('does nothing for empty steps', () => {
    const sink = fakeSink();
    const player = new PatternPlayer(sink, { now: () => 0 });
    player.setPattern(patternWith([[1, 0, 0]]));
    const clock = fakeClock();
    player.attachClock(clock.clock);
    clock.fire(0, 0);
    expect(sink.calls).toEqual([]);
  });

  it('attachClock returns an unsubscribe that stops scheduling', () => {
    const sink = fakeSink();
    const player = new PatternPlayer(sink, { now: () => 0 });
    player.setPattern(patternWith([[0, 0, 0]]));
    const clock = fakeClock();
    const unsubscribe = player.attachClock(clock.clock);
    clock.fire(0, 0.1);
    expect(sink.calls).toHaveLength(1);

    unsubscribe();
    clock.fire(0, 0.4);
    expect(sink.calls).toHaveLength(1);
    expect(clock.unsubscribed).toBe(1);
  });

  it('attaching a second clock detaches the first', () => {
    const sink = fakeSink();
    const player = new PatternPlayer(sink, { now: () => 0 });
    player.setPattern(patternWith([[0, 0, 0]]));
    const a = fakeClock();
    const b = fakeClock();
    player.attachClock(a.clock);
    player.attachClock(b.clock);
    a.fire(0, 0);
    expect(sink.calls).toHaveLength(0);
    b.fire(0, 0);
    expect(sink.calls).toHaveLength(1);
    expect(a.unsubscribed).toBe(1);
  });

  it('never schedules in the past: late steps are nudged to now plus the minimum lead', () => {
    const sink = fakeSink();
    const now = vi.fn(() => 10);
    const player = new PatternPlayer(sink, { now, minLeadSec: 0.02, lateToleranceSec: 0.25 });
    player.setPattern(patternWith([[0, 0, 0]]));
    const clock = fakeClock();
    player.attachClock(clock.clock);
    clock.fire(0, 9.9);
    expect(sink.calls).toEqual([[0, 0, 10.02]]);
  });

  it('drops steps that are later than the tolerance (a stale event would smear the groove)', () => {
    const sink = fakeSink();
    const player = new PatternPlayer(sink, { now: () => 10, minLeadSec: 0.02, lateToleranceSec: 0.25 });
    player.setPattern(patternWith([[0, 0, 0]]));
    const clock = fakeClock();
    player.attachClock(clock.clock);
    clock.fire(0, 9.5);
    expect(sink.calls).toEqual([]);
  });

  it('drops steps whose clock time is not finite instead of scheduling NaN', () => {
    const sink = fakeSink();
    const player = new PatternPlayer(sink, { now: () => 0 });
    player.setPattern(patternWith([[0, 0, 0]]));
    const clock = fakeClock();
    player.attachClock(clock.clock);
    clock.fire(0, Number.NaN);
    clock.fire(0, Number.POSITIVE_INFINITY);
    expect(sink.calls).toEqual([]);
    clock.fire(0, 1);
    expect(sink.calls).toEqual([[0, 0, 1]]);
  });

  it('getPattern returns a copy, not the live schedule', () => {
    const player = new PatternPlayer(fakeSink(), { now: () => 0 });
    player.setPattern(patternWith([[0, 0, 0]]));
    const copy = player.getPattern() as bigint[];
    copy[0] = 0n;
    expect(player.getPattern()[0]).not.toBe(0n);
  });

  it('ignores step indices outside 0..15', () => {
    const sink = fakeSink();
    const player = new PatternPlayer(sink, { now: () => 0 });
    player.setPattern(patternWith([[0, 0, 0]]));
    const clock = fakeClock();
    player.attachClock(clock.clock);
    clock.fire(16, 0);
    clock.fire(-1, 0);
    expect(sink.calls).toEqual([]);
  });

  it('picks up a replaced pattern on the next step', () => {
    const sink = fakeSink();
    const player = new PatternPlayer(sink, { now: () => 0 });
    player.setPattern(patternWith([[0, 0, 0]]));
    const clock = fakeClock();
    player.attachClock(clock.clock);
    player.setPattern(patternWith([[0, 7, 31]]));
    clock.fire(0, 1);
    expect(sink.calls).toEqual([[7, 31, 1]]);
  });

  it('triggerNow plays one note at now plus the minimum lead', () => {
    const sink = fakeSink();
    const player = new PatternPlayer(sink, { now: () => 3, minLeadSec: 0.02 });
    player.triggerNow(4, 9);
    expect(sink.calls).toEqual([[4, 9, 3.02]]);
  });

  it('detach() stops scheduling and is safe to call twice', () => {
    const sink = fakeSink();
    const player = new PatternPlayer(sink, { now: () => 0 });
    player.setPattern(patternWith([[0, 0, 0]]));
    const clock = fakeClock();
    player.attachClock(clock.clock);
    player.detach();
    player.detach();
    clock.fire(0, 0);
    expect(sink.calls).toEqual([]);
    expect(clock.unsubscribed).toBe(1);
  });
});
