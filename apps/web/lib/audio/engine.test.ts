import { describe, expect, it, vi } from 'vitest';
import { emptyPattern, toggle, type TrackId } from '@blockbeat/shared';
import type { BlockClock } from '../types';
import { AudioStartError, createAudioEngine, type AudioContextAdapter, type EngineDeps, type Kit, type MasterChain } from './engine';

type AdapterState = ReturnType<AudioContextAdapter['getState']>;

function fakeAdapter(opts: { state?: AdapterState; resume?: () => Promise<void>; offline?: boolean } = {}) {
  let state: AdapterState = opts.state ?? 'suspended';
  const adapter: AudioContextAdapter & { setState(s: AdapterState): void; resumeCalls: number } = {
    resumeCalls: 0,
    resume: async () => {
      adapter.resumeCalls += 1;
      if (opts.resume) return opts.resume();
      state = 'running';
    },
    getState: () => state,
    now: () => 1,
    rawContext: () => ({ currentTime: 1 }),
    isOffline: () => opts.offline ?? false,
    setState: (s) => {
      state = s;
    },
  };
  return adapter;
}

function fakeKit(): Kit & { calls: Array<[TrackId, number, number]>; disposed: number; connectedTo: unknown } {
  const kit = {
    size: 8,
    keys: ['kick', 'snare', 'hat', 'clap', 'bass', 'lead', 'pad', 'fx'] as const,
    ready: Promise.resolve(),
    calls: [] as Array<[TrackId, number, number]>,
    disposed: 0,
    connectedTo: undefined as unknown,
    trigger: (track: TrackId, note: number, at: number) => {
      kit.calls.push([track, note, at]);
    },
    connect: (target: unknown) => {
      kit.connectedTo = target;
    },
    dispose: () => {
      kit.disposed += 1;
    },
  };
  return kit;
}

function fakeMaster(): MasterChain & { volumeDb: number[]; disposed: number } {
  const master = {
    input: { id: 'master-input' } as unknown as MasterChain['input'],
    volumeDb: [] as number[],
    disposed: 0,
    setVolumeDb: (db: number) => {
      master.volumeDb.push(db);
    },
    dispose: () => {
      master.disposed += 1;
    },
  };
  return master;
}

function fakeClock() {
  const listeners = new Set<(step: number, at: number) => void>();
  const clock: Pick<BlockClock, 'onStep' | 'setAudioClock'> & {
    fire(step: number, at: number): void;
    unsubscribed: number;
    audioClocks: unknown[];
  } = {
    unsubscribed: 0,
    audioClocks: [],
    setAudioClock: (ctx) => {
      clock.audioClocks.push(ctx);
    },
    fire: (step, at) => listeners.forEach((cb) => cb(step, at)),
    onStep: (cb) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
        clock.unsubscribed += 1;
      };
    },
  };
  return clock;
}

function harness(adapterOpts: Parameters<typeof fakeAdapter>[0] = {}) {
  const adapter = fakeAdapter(adapterOpts);
  const kit = fakeKit();
  const master = fakeMaster();
  const deps: EngineDeps = {
    createAdapter: vi.fn(() => adapter),
    createKit: vi.fn(() => kit),
    createMaster: vi.fn(() => master),
    resumeTimeoutMs: 20,
  };
  const engine = createAudioEngine(deps);
  return { engine, adapter, kit, master, deps };
}

describe('AudioEngine', () => {
  it('is not started before start() is called and builds nothing eagerly', () => {
    const { engine, deps } = harness();
    expect(engine.isStarted()).toBe(false);
    expect(deps.createKit).not.toHaveBeenCalled();
  });

  it('start() resumes the context, builds the kit once and wires it to the master chain', async () => {
    const { engine, adapter, kit, master, deps } = harness();
    await engine.start();
    expect(engine.isStarted()).toBe(true);
    expect(adapter.resumeCalls).toBe(1);
    expect(deps.createKit).toHaveBeenCalledTimes(1);
    expect(kit.connectedTo).toBe(master.input);
  });

  it('start() is idempotent', async () => {
    const { engine, adapter, deps } = harness();
    await Promise.all([engine.start(), engine.start()]);
    await engine.start();
    expect(adapter.resumeCalls).toBe(1);
    expect(deps.createKit).toHaveBeenCalledTimes(1);
    expect(deps.createMaster).toHaveBeenCalledTimes(1);
  });

  it('start() without a user gesture rejects with the reason instead of hanging, and can be retried (review L5)', async () => {
    const { engine, adapter } = harness({ resume: () => new Promise<void>(() => undefined) });
    const err = (await engine.start().catch((e: unknown) => e)) as AudioStartError;
    expect(err).toBeInstanceOf(AudioStartError);
    expect(err.message).toMatch(/20 ms/);
    expect(err.message).toMatch(/suspended/);
    expect(engine.isStarted()).toBe(false);
    expect(adapter.resumeCalls).toBe(1);

    adapter.setState('running');
    await engine.start();
    expect(engine.isStarted()).toBe(true);
  });

  it('start() carries a rejected resume() as the cause of the thrown error (review L5)', async () => {
    const reason = new Error('NotAllowedError: play() failed because the user did not interact');
    const { engine } = harness({ resume: () => Promise.reject(reason) });
    const err = (await engine.start().catch((e: unknown) => e)) as AudioStartError;
    expect(err).toBeInstanceOf(AudioStartError);
    expect(err.cause).toBe(reason);
    expect(err.message).toContain('NotAllowedError');
    expect(engine.isStarted()).toBe(false);
  });

  it('treats an offline context as started once resumed', async () => {
    const { engine } = harness({ offline: true, resume: async () => undefined });
    await engine.start();
    expect(engine.isStarted()).toBe(true);
  });

  it('playImmediate rejects out-of-range tracks and notes even before start', () => {
    const { engine } = harness();
    expect(() => engine.playImmediate(8 as TrackId, 0)).toThrow(RangeError);
    expect(() => engine.playImmediate(0, 32)).toThrow(RangeError);
    expect(() => engine.playImmediate(0, -1)).toThrow(RangeError);
  });

  it('playImmediate is a no-op before start and triggers the kit after', async () => {
    const { engine, kit } = harness();
    engine.playImmediate(3, 5);
    expect(kit.calls).toEqual([]);
    await engine.start();
    engine.playImmediate(3, 5);
    expect(kit.calls).toHaveLength(1);
    expect(kit.calls[0]?.[0]).toBe(3);
    expect(kit.calls[0]?.[1]).toBe(5);
    expect(kit.calls[0]?.[2]).toBeGreaterThanOrEqual(1);
  });

  it('setPattern rejects a wrong-length array', () => {
    const { engine } = harness();
    expect(() => engine.setPattern([0n, 0n])).toThrow(RangeError);
  });

  it('attachClock schedules pattern steps and the unsubscribe stops it', async () => {
    const { engine, kit } = harness();
    const pattern = emptyPattern();
    pattern[2] = toggle(0n, 1, 4);
    engine.setPattern(pattern);
    const clock = fakeClock();
    const unsubscribe = engine.attachClock(clock as unknown as BlockClock);

    clock.fire(2, 5);
    expect(kit.calls).toEqual([]);

    await engine.start();
    clock.fire(2, 5);
    expect(kit.calls).toEqual([[1, 4, 5]]);

    unsubscribe();
    clock.fire(2, 6);
    expect(kit.calls).toHaveLength(1);
    expect(clock.unsubscribed).toBe(1);
  });

  it('setMasterVolumeDb applies now if built and is remembered for the build', async () => {
    const { engine, master } = harness();
    engine.setMasterVolumeDb(-12);
    await engine.start();
    expect(master.volumeDb).toEqual([-12]);
    engine.setMasterVolumeDb(-3);
    expect(master.volumeDb).toEqual([-12, -3]);
  });

  it('dispose() tears everything down and stops further scheduling', async () => {
    const { engine, kit, master } = harness();
    const pattern = emptyPattern();
    pattern[0] = toggle(0n, 0, 0);
    engine.setPattern(pattern);
    const clock = fakeClock();
    engine.attachClock(clock as unknown as BlockClock);
    await engine.start();
    engine.dispose();
    expect(engine.isStarted()).toBe(false);
    expect(kit.disposed).toBe(1);
    expect(master.disposed).toBe(1);
    expect(clock.unsubscribed).toBe(1);
    clock.fire(0, 0);
    expect(kit.calls).toEqual([]);
    await expect(engine.start()).rejects.toThrow(/disposed/);
  });

  it('dispose() during an in-flight start() leaves the engine stopped and torn down', async () => {
    let releaseResume: () => void = () => undefined;
    const { engine, kit, master } = harness({
      resume: () =>
        new Promise<void>((resolve) => {
          releaseResume = resolve;
        }),
    });
    const starting = engine.start();
    engine.dispose();
    releaseResume();
    await starting;
    expect(engine.isStarted()).toBe(false);
    expect(kit.disposed).toBe(1);
    expect(master.disposed).toBe(1);
  });

  it('dispose() is idempotent and playImmediate afterwards is a silent no-op', async () => {
    const { engine, kit, master } = harness();
    await engine.start();
    engine.dispose();
    engine.dispose();
    expect(kit.disposed).toBe(1);
    expect(master.disposed).toBe(1);
    expect(() => engine.playImmediate(0, 0)).not.toThrow();
    expect(() => engine.playImmediate(9 as TrackId, 0)).toThrow(RangeError);
    expect(kit.calls).toEqual([]);
  });

  it('setMasterVolumeDb before start survives a failed start and applies on the retry build', async () => {
    const { engine, adapter, master } = harness({ resume: () => new Promise<void>(() => undefined) });
    engine.setMasterVolumeDb(-6);
    await expect(engine.start()).rejects.toBeInstanceOf(AudioStartError);
    expect(master.volumeDb).toEqual([-6]);
    adapter.setState('running');
    await engine.start();
    expect(engine.isStarted()).toBe(true);
    expect(master.volumeDb).toEqual([-6]);
  });

  it('recovers when the browser suspends the context behind our back', async () => {
    const { engine, adapter } = harness();
    await engine.start();
    expect(engine.isStarted()).toBe(true);
    adapter.setState('suspended');
    expect(engine.isStarted()).toBe(false);
    await engine.start();
    expect(adapter.resumeCalls).toBe(2);
    expect(engine.isStarted()).toBe(true);
  });

  it('hands the raw audio context to a clock attached before start, once started', async () => {
    const { engine } = harness();
    const clock = fakeClock();
    engine.attachClock(clock as unknown as BlockClock);
    expect(clock.audioClocks).toEqual([]);
    await engine.start();
    expect(clock.audioClocks).toEqual([{ currentTime: 1 }]);
  });

  it('hands the raw audio context immediately to a clock attached after start', async () => {
    const { engine } = harness();
    await engine.start();
    const clock = fakeClock();
    engine.attachClock(clock as unknown as BlockClock);
    expect(clock.audioClocks).toEqual([{ currentTime: 1 }]);
  });

  it('does not hand the context to a clock when start failed (no gesture yet)', async () => {
    const { engine } = harness({ resume: () => new Promise<void>(() => undefined) });
    const clock = fakeClock();
    engine.attachClock(clock as unknown as BlockClock);
    await expect(engine.start()).rejects.toBeInstanceOf(AudioStartError);
    expect(clock.audioClocks).toEqual([]);
  });
});
