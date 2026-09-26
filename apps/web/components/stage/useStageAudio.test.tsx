import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Hash } from 'viem';
import { emptyPattern, type HitEvent, type Pattern } from '@blockbeat/shared';
import type { AudioEngine, BlockClock } from '@/lib/types';
import { createSimulator } from '@/lib/mock/simulator';
import { loadOrCreateBurner } from '@/lib/burner';
import { createRuntime, type BlockbeatRuntime } from '@/lib/runtime';

let runtime: BlockbeatRuntime;
vi.mock('@/lib/runtime', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/lib/runtime')>();
  return { ...mod, getRuntime: () => runtime };
});

const { useStageAudio, volumeToDb, MUTE_DB } = await import('./useStageAudio');

interface FakeEngine extends AudioEngine {
  calls: string[];
  patterns: Pattern[];
  immediate: Array<[number, number]>;
  volumes: number[];
  attached: BlockClock[];
  started: boolean;
  failStart: boolean;
}

function fakeEngine(): FakeEngine {
  const e: FakeEngine = {
    calls: [],
    patterns: [],
    immediate: [],
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
    playImmediate(track, note) {
      e.immediate.push([track, note]);
    },
    setMasterVolumeDb(db) {
      e.volumes.push(db);
    },
    dispose() {
      e.calls.push('dispose');
    },
  };
  return e;
}

function hit(step: number, on = true): HitEvent {
  return { sessionId: 1n, player: '0x0000000000000000000000000000000000000001', blockNumber: 5n, step, track: 2, note: 3, on, txHash: `0x${'ab'.repeat(32)}` as Hash, logIndex: 0 };
}

describe('useStageAudio', () => {
  let engine: FakeEngine;
  beforeEach(() => {
    runtime = createRuntime({ mode: 'mock', simulator: createSimulator({ startBlock: 100n, blockMs: 1_000_000 }), burner: loadOrCreateBurner({ storage: null }) });
    engine = fakeEngine();
  });
  afterEach(() => {
    runtime.clock.stop();
    runtime.simulator?.stop();
  });

  it('creates the engine, attaches the runtime clock and disposes on unmount', () => {
    const { unmount } = renderHook(() => useStageAudio({ pattern: emptyPattern(), lastHit: null, createEngine: () => engine }));
    expect(engine.attached).toEqual([runtime.clock]);
    unmount();
    expect(engine.calls).toEqual(['detach', 'dispose']);
  });

  it('drops started when the context leaves the running state so the overlay can come back', async () => {
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => useStageAudio({ pattern: emptyPattern(), lastHit: null, createEngine: () => engine }));
      await act(() => result.current.start());
      expect(result.current.started).toBe(true);
      engine.started = false; // macOS suspended the AudioContext (speaker change, lid, tab hidden)
      await act(async () => {
        vi.advanceTimersByTime(1100);
      });
      expect(result.current.started).toBe(false);
      engine.started = true;
      await act(async () => {
        vi.advanceTimersByTime(1100);
      });
      expect(result.current.started).toBe(false); // only a click (start) brings it back
    } finally {
      vi.useRealTimers();
    }
  });

  it('start() starts the engine and reports started; a failure surfaces as a rejection', async () => {
    const { result } = renderHook(() => useStageAudio({ pattern: emptyPattern(), lastHit: null, createEngine: () => engine }));
    expect(result.current.started).toBe(false);
    await act(() => result.current.start());
    expect(engine.calls).toContain('start');
    expect(result.current.started).toBe(true);

    const failing = fakeEngine();
    failing.failStart = true;
    const bad = renderHook(() => useStageAudio({ pattern: emptyPattern(), lastHit: null, createEngine: () => failing }));
    await expect(act(() => bad.result.current.start())).rejects.toThrow('no gesture');
    expect(bad.result.current.started).toBe(false);
  });

  it('forwards every pattern change to the engine', () => {
    const p1 = emptyPattern();
    const { rerender } = renderHook(({ pattern }: { pattern: Pattern }) => useStageAudio({ pattern, lastHit: null, createEngine: () => engine }), { initialProps: { pattern: p1 } });
    const p2 = [...p1];
    p2[3] = 1n;
    rerender({ pattern: p2 });
    expect(engine.patterns).toEqual([p1, p2]);
  });

  it('plays a hit immediately only when it lands on the current step and turns a note on', async () => {
    runtime.clock.start();
    // Lock the clock to a head so currentStep is defined: startBlock 100, head 100 → step 0.
    runtime.clock.setStartBlock(100n);
    const { rerender } = renderHook(({ lastHit }: { lastHit: HitEvent | null }) => useStageAudio({ pattern: emptyPattern(), lastHit, createEngine: () => engine }), { initialProps: { lastHit: null as HitEvent | null } });
    const current = runtime.clock.getState().currentStep;
    rerender({ lastHit: hit(current) });
    expect(engine.immediate).toEqual([[2, 3]]);
    rerender({ lastHit: hit((current + 1) % 16) });
    expect(engine.immediate).toEqual([[2, 3]]);
    rerender({ lastHit: hit(current, false) });
    expect(engine.immediate).toEqual([[2, 3]]);
  });

  it('W13: with decay every hit on the current step sounds, the on=false refresh included', async () => {
    runtime.clock.start();
    runtime.clock.setStartBlock(100n);
    const { rerender } = renderHook(({ lastHit }: { lastHit: HitEvent | null }) => useStageAudio({ pattern: emptyPattern(), lastHit, everyHitSounds: true, createEngine: () => engine }), {
      initialProps: { lastHit: null as HitEvent | null },
    });
    const current = runtime.clock.getState().currentStep;
    rerender({ lastHit: hit(current, false) });
    expect(engine.immediate).toEqual([[2, 3]]);
  });

  it('mute and volume map to master dB and restore on unmute', () => {
    const { result } = renderHook(() => useStageAudio({ pattern: emptyPattern(), lastHit: null, createEngine: () => engine }));
    expect(result.current.muted).toBe(false);
    expect(result.current.volume).toBe(1);
    act(() => result.current.setMuted(true));
    expect(result.current.muted).toBe(true);
    expect(engine.volumes.at(-1)).toBe(MUTE_DB);
    act(() => result.current.setVolume(0.5));
    expect(result.current.volume).toBe(0.5);
    expect(engine.volumes.at(-1)).toBe(MUTE_DB); // still muted
    act(() => result.current.setMuted(false));
    expect(engine.volumes.at(-1)).toBeCloseTo(volumeToDb(0.5), 6);
  });

  it('volumeToDb is 0 dB at 1, MUTE_DB at 0 and monotonic in between', () => {
    expect(volumeToDb(1)).toBe(0);
    expect(volumeToDb(0)).toBe(MUTE_DB);
    expect(volumeToDb(0.5)).toBeLessThan(0);
    expect(volumeToDb(0.5)).toBeGreaterThan(volumeToDb(0.25));
    expect(volumeToDb(2)).toBe(0);
    expect(volumeToDb(Number.NaN)).toBe(MUTE_DB);
  });
});
