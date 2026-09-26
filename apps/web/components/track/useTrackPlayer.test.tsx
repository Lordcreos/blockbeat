import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BLOCK_MS, type Pattern } from '@blockbeat/shared';
import type { AudioEngine, BlockClock } from '@/lib/types';
import { volumeToDb } from '@/lib/track/volume';
import { useTrackPlayer } from './useTrackPlayer';

interface FakeEngine extends AudioEngine {
  calls: string[];
  patterns: Pattern[];
  volumes: number[];
  attached: BlockClock[];
  started: boolean;
  failStart: boolean;
}

function fakeEngine(): FakeEngine {
  const e: FakeEngine = {
    calls: [],
    patterns: [],
    volumes: [],
    attached: [],
    started: false,
    failStart: false,
    async start() {
      e.calls.push('start');
      if (e.failStart) throw new Error('no gesture');
      e.started = true;
    },
    isStarted: () => e.started,
    setPattern(p) {
      e.patterns.push(p);
    },
    attachClock(clock) {
      e.attached.push(clock);
      return () => e.calls.push('detach');
    },
    playImmediate() {},
    setMasterVolumeDb(db) {
      e.volumes.push(db);
    },
    dispose() {
      e.calls.push('dispose');
    },
  };
  return e;
}

const A: bigint[] = Array.from({ length: 16 }, (_, i) => (i === 0 ? 1n : 0n));
const B: bigint[] = Array.from({ length: 16 }, (_, i) => (i === 4 ? 1n << 32n : 0n));

describe('useTrackPlayer', () => {
  let engine: FakeEngine;
  let created: number;
  const createEngine = () => {
    created += 1;
    return engine;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    engine = fakeEngine();
    created = 0;
  });
  afterEach(() => vi.useRealTimers());

  it('builds no engine and plays nothing before the first click', () => {
    const { result } = renderHook(() => useTrackPlayer({ createEngine }));
    expect(created).toBe(0);
    expect(result.current.playingId).toBeNull();
    expect(result.current.step).toBeNull();
  });

  it('play() starts the engine inside the gesture, loads the pattern and sweeps a step every 300 ms', async () => {
    const { result } = renderHook(() => useTrackPlayer({ createEngine }));
    await act(() => result.current.play('1', A));
    expect(engine.calls[0]).toBe('start');
    expect(engine.patterns.at(-1)).toEqual(A);
    expect(engine.attached).toHaveLength(1);
    expect(result.current.playingId).toBe('1');
    expect(result.current.step).toBe(0);
    await act(async () => {
      vi.advanceTimersByTime(BLOCK_MS * 3);
    });
    expect(result.current.step).toBe(3);
    await act(async () => {
      vi.advanceTimersByTime(BLOCK_MS * 13);
    });
    expect(result.current.step).toBe(0);
  });

  it('stop() silences the loop and clears the playhead', async () => {
    const { result } = renderHook(() => useTrackPlayer({ createEngine }));
    await act(() => result.current.play('1', A));
    act(() => result.current.stop());
    expect(result.current.playingId).toBeNull();
    expect(result.current.step).toBeNull();
    const before = engine.attached[0]?.getState().currentBlock;
    await act(async () => {
      vi.advanceTimersByTime(BLOCK_MS * 5);
    });
    expect(engine.attached[0]?.getState().currentBlock).toBe(before);
  });

  it('toggle() plays then stops the same track', async () => {
    const { result } = renderHook(() => useTrackPlayer({ createEngine }));
    await act(() => result.current.toggle('1', A));
    expect(result.current.playingId).toBe('1');
    await act(() => result.current.toggle('1', A));
    expect(result.current.playingId).toBeNull();
  });

  it('plays one track at a time: a second track replaces the first from step 0 on one engine', async () => {
    const { result } = renderHook(() => useTrackPlayer({ createEngine }));
    await act(() => result.current.play('1', A));
    await act(async () => {
      vi.advanceTimersByTime(BLOCK_MS * 5);
    });
    await act(() => result.current.toggle('2', B));
    expect(result.current.playingId).toBe('2');
    expect(result.current.step).toBe(0);
    expect(engine.patterns.at(-1)).toEqual(B);
    expect(created).toBe(1);
  });

  it('maps the volume slider onto the master chain', async () => {
    const { result } = renderHook(() => useTrackPlayer({ createEngine }));
    await act(() => result.current.play('1', A));
    act(() => result.current.setVolume(0.5));
    expect(result.current.volume).toBe(0.5);
    expect(engine.volumes.at(-1)).toBe(volumeToDb(0.5));
    act(() => result.current.setVolume(3));
    expect(result.current.volume).toBe(1);
  });

  it('reports an engine that will not start and stays stopped', async () => {
    engine.failStart = true;
    const { result } = renderHook(() => useTrackPlayer({ createEngine }));
    await act(() => result.current.play('1', A));
    expect(result.current.playingId).toBeNull();
    expect(result.current.error).toMatch(/no gesture/);
    engine.failStart = false;
    await act(() => result.current.play('1', A));
    expect(result.current.playingId).toBe('1');
    expect(result.current.error).toBeNull();
  });

  it('a slow start never resumes a track after a newer Stop or Play (review: race)', async () => {
    let release: () => void = () => undefined;
    engine.start = async () => {
      engine.calls.push('start');
      await new Promise<void>((r) => {
        release = r;
      });
      engine.started = true;
    };
    const { result } = renderHook(() => useTrackPlayer({ createEngine }));
    let first: Promise<void> = Promise.resolve();
    await act(async () => {
      first = result.current.play('1', A);
      for (let i = 0; i < 5; i++) await Promise.resolve();
    });
    expect(engine.calls).toContain('start');
    act(() => result.current.stop());
    await act(async () => {
      release();
      await first;
    });
    expect(result.current.playingId).toBeNull();
    expect(result.current.starting).toBe(false);
    const clock = engine.attached[0];
    expect(clock?.getState().currentBlock).toBe(0n);
    await act(async () => {
      vi.advanceTimersByTime(BLOCK_MS * 3);
    });
    expect(clock?.getState().currentBlock).toBe(0n);
    expect(engine.patterns).toEqual([]);
  });

  it('names the track that is starting, and clears it once playing', async () => {
    let release: () => void = () => undefined;
    engine.start = async () => {
      await new Promise<void>((r) => {
        release = r;
      });
      engine.started = true;
    };
    const { result } = renderHook(() => useTrackPlayer({ createEngine }));
    let p: Promise<void> = Promise.resolve();
    await act(async () => {
      p = result.current.play('7', A);
      for (let i = 0; i < 5; i++) await Promise.resolve();
    });
    expect(result.current.starting).toBe(true);
    expect(result.current.startingId).toBe('7');
    await act(async () => {
      release();
      await p;
    });
    expect(result.current.startingId).toBeNull();
    expect(result.current.playingId).toBe('7');
  });

  it('unmounting while the engine starts disposes it and never starts the clock', async () => {
    let release: () => void = () => undefined;
    engine.start = async () => {
      engine.calls.push('start');
      await new Promise<void>((r) => {
        release = r;
      });
      engine.started = true;
    };
    const { result, unmount } = renderHook(() => useTrackPlayer({ createEngine }));
    let p: Promise<void> = Promise.resolve();
    await act(async () => {
      p = result.current.play('1', A);
      for (let i = 0; i < 5; i++) await Promise.resolve();
    });
    const clock = engine.attached[0];
    unmount();
    expect(engine.calls).toContain('dispose');
    release();
    await p;
    vi.advanceTimersByTime(BLOCK_MS * 3);
    expect(engine.patterns).toEqual([]);
    expect(clock?.getState().currentBlock).toBe(0n);
  });

  it('disposes the engine and stops the clock on unmount', async () => {
    const { result, unmount } = renderHook(() => useTrackPlayer({ createEngine }));
    await act(() => result.current.play('1', A));
    const clock = engine.attached[0];
    unmount();
    expect(engine.calls).toContain('dispose');
    const block = clock?.getState().currentBlock;
    vi.advanceTimersByTime(BLOCK_MS * 4);
    expect(clock?.getState().currentBlock).toBe(block);
  });
});
