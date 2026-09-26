import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stepForBlock } from '@blockbeat/shared';
import type { BlockClock, BlockClockState } from '@/lib/types';
import type { AimClock, AimLanding } from './aimQueue';

let block = 0n;
const steps = new Set<(step: number, at: number) => void>();
const fakeClock = {
  getState: (): BlockClockState => ({ currentBlock: block, currentStep: Number(block % 16n), measuredBlockMs: 300, msSinceHead: 0, source: 'mock' }),
  onStep(cb: (step: number, at: number) => void) {
    steps.add(cb);
    return () => steps.delete(cb);
  },
  onHead: () => () => undefined,
  predictBlock: () => block,
  start: vi.fn(),
  stop: vi.fn(),
  setStartBlock: vi.fn(),
} satisfies BlockClock & { setStartBlock(b: bigint | null): void };

const resetListeners = new Set<() => void>();
const fakeNonce = {
  onReset: vi.fn((cb: () => void) => {
    resetListeners.add(cb);
    return () => resetListeners.delete(cb);
  }),
};
vi.mock('@/lib/runtime', () => ({ getRuntime: () => ({ clock: fakeClock, burner: () => ({ account: { nonceManager: fakeNonce } }) }) }));
vi.mock('@/lib/localNonce', () => ({ isLocalNonceManager: (m: unknown) => m === fakeNonce }));

const { usePhoneClock, useClockHead, useAimQueue, usePhonePref, useSeenFlag } = await import('./usePhone');

function tick(to: bigint): void {
  block = to;
  for (const cb of [...steps]) cb(Number(to % 16n), 0);
}

afterEach(() => {
  cleanup();
  steps.clear();
  block = 0n;
  window.localStorage.clear();
});

describe('usePhoneClock', () => {
  beforeEach(() => {
    fakeClock.start.mockClear();
    fakeClock.setStartBlock.mockClear();
  });

  it('starts the runtime clock on the session start block; useClockHead follows it block by block', () => {
    const { result } = renderHook(() => {
      const clock = usePhoneClock(100n);
      return { clock, ...useClockHead(clock, 100n) };
    });
    expect(fakeClock.setStartBlock).toHaveBeenCalledWith(100n);
    expect(fakeClock.start).toHaveBeenCalled();
    expect(result.current.head).toBeNull();
    act(() => tick(105n));
    expect(result.current.head).toBe(105n);
    expect(result.current.step).toBe(5);
    expect(result.current.clock?.head()).toBe(105n);
  });

  it('has no step before the session start block is known', () => {
    const { result } = renderHook(() => useClockHead(usePhoneClock(null), null));
    act(() => tick(105n));
    expect(result.current.head).toBe(105n);
    expect(result.current.step).toBeNull();
  });

  it('stops listening to the runtime clock on unmount', () => {
    const { unmount } = renderHook(() => useClockHead(usePhoneClock(100n), 100n));
    expect(steps.size).toBe(1);
    unmount();
    expect(steps.size).toBe(0);
  });
});

describe('useAimQueue', () => {
  function manualClock(): AimClock & { tick(b: bigint): void } {
    let head: bigint | null = 1000n;
    const ls = new Set<(b: bigint) => void>();
    return {
      head: () => head,
      onBlock(cb) {
        ls.add(cb);
        return () => ls.delete(cb);
      },
      tick(b) {
        head = b;
        for (const cb of [...ls]) cb(b);
      },
    };
  }

  it('aims through the queue and re-renders as notes wait, send and land', async () => {
    const clock = manualClock();
    let resolve: (l: AimLanding) => void = () => undefined;
    const send = vi.fn(() => new Promise<AimLanding>((r) => (resolve = r)));
    const onResult = vi.fn();
    const { result } = renderHook(() => useAimQueue({ clock, send, startBlock: 1000n, budget: null, onResult }));
    act(() => {
      expect(result.current.aim({ track: 0, note: 0, step: 3 })).toMatchObject({ ok: true });
    });
    expect(result.current.state.items).toHaveLength(1);
    act(() => clock.tick(1002n));
    expect(send).toHaveBeenCalledTimes(1);
    expect(result.current.state.items[0]?.status).toBe('sending');
    await act(async () => {
      resolve({ blockNumber: 1003n, step: stepForBlock(1000n, 1003n) });
    });
    expect(result.current.state.items).toHaveLength(0);
    expect(result.current.state.results[0]).toMatchObject({ ok: true, text: 'aimed step 3 · landed step 3' });
    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onResult.mock.calls[0]?.[0]).toMatchObject({ aimedStep: 3, landedStep: 3 });
  });

  it('re-times waiting notes when the burner nonce is reset, and stops listening on unmount', () => {
    const clock = manualClock();
    const send = vi.fn(() => new Promise<AimLanding>(() => undefined));
    const { result, unmount } = renderHook(() => useAimQueue({ clock, send, startBlock: 1000n, budget: null }));
    act(() => {
      result.current.aim({ track: 0, note: 0, step: 9 });
    });
    expect(resetListeners.size).toBe(1);
    const before = result.current.state;
    act(() => {
      for (const cb of [...resetListeners]) cb();
    });
    expect(result.current.state).not.toBe(before);
    expect(result.current.state.items).toHaveLength(1);
    unmount();
    expect(resetListeners.size).toBe(0);
  });

  it('refuses to aim without a clock', () => {
    const { result } = renderHook(() => useAimQueue({ clock: null, send: vi.fn(), startBlock: 1000n, budget: null }));
    expect(result.current.aim({ track: 0, note: 0, step: 3 })).toEqual({ ok: false, reason: 'no-clock' });
  });

  it('reads the latest budget without recreating the queue', () => {
    const clock = manualClock();
    const send = vi.fn(() => new Promise<AimLanding>(() => undefined));
    const { result, rerender } = renderHook((budget: number | null) => useAimQueue({ clock, send, startBlock: 1000n, budget }), { initialProps: 5 as number | null });
    act(() => {
      result.current.aim({ track: 0, note: 0, step: 8 });
    });
    rerender(1);
    let r: ReturnType<typeof result.current.aim> | null = null;
    act(() => {
      r = result.current.aim({ track: 0, note: 0, step: 9 });
    });
    expect(r).toEqual({ ok: false, reason: 'no-funds' });
    expect(result.current.state.items).toHaveLength(1);
  });
});

describe('usePhonePref', () => {
  it('defaults, persists and restores a choice', () => {
    const a = renderHook(() => usePhonePref('mode', ['aim', 'now'] as const, 'aim'));
    expect(a.result.current[0]).toBe('aim');
    act(() => a.result.current[1]('now'));
    expect(a.result.current[0]).toBe('now');
    a.unmount();
    const b = renderHook(() => usePhonePref('mode', ['aim', 'now'] as const, 'aim'));
    expect(b.result.current[0]).toBe('now');
  });

  it('ignores a stored value that is not allowed', () => {
    window.localStorage.setItem('blockbeat:phone:mode', 'nonsense');
    const { result } = renderHook(() => usePhonePref('mode', ['aim', 'now'] as const, 'aim'));
    expect(result.current[0]).toBe('aim');
  });
});

describe('useSeenFlag (tour)', () => {
  it('is false on a first visit, true once marked, and stays true for the next visit', () => {
    const a = renderHook(() => useSeenFlag('tour'));
    expect(a.result.current.seen).toBe(false);
    act(() => a.result.current.markSeen());
    expect(a.result.current.seen).toBe(true);
    a.unmount();
    expect(renderHook(() => useSeenFlag('tour')).result.current.seen).toBe(true);
  });

  it('still works in memory when storage throws (private mode), and says so once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    try {
      const { result } = renderHook(() => useSeenFlag('tour-private'));
      expect(result.current.seen).toBe(false);
      act(() => result.current.markSeen());
      expect(result.current.seen).toBe(true);
      expect(warn).toHaveBeenCalled();
    } finally {
      get.mockRestore();
      set.mockRestore();
      warn.mockRestore();
    }
  });
});
