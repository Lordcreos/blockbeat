import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BLOCK_MS } from '@blockbeat/shared';
import { createBlockClock, type HeadSource, type HeadSourceKind } from './blockClock';

/** A head source the test drives by hand. */
function fakeHeadSource(kind: HeadSourceKind = 'mock') {
  let onHead: ((n: bigint) => void) | null = null;
  let onError: ((e: Error) => void) | null = null;
  let subscribed = 0;
  let unsubscribed = 0;
  const source: HeadSource = {
    kind: () => kind,
    subscribe(head, error) {
      onHead = head;
      onError = error;
      subscribed += 1;
      return () => {
        unsubscribed += 1;
        onHead = null;
        onError = null;
      };
    },
  };
  return {
    source,
    emit(n: bigint) {
      if (!onHead) throw new Error('no subscriber');
      onHead(n);
    },
    fail(e: Error) {
      if (!onError) throw new Error('no subscriber');
      onError(e);
    },
    get subscribed() {
      return subscribed;
    },
    get unsubscribed() {
      return unsubscribed;
    },
  };
}

function setup(opts: { startBlock?: bigint | null; lookaheadMs?: number; nudgeGain?: number } = {}) {
  const heads = fakeHeadSource();
  const audio = { currentTime: 10 };
  const clock = createBlockClock({
    headSource: heads.source,
    startBlock: opts.startBlock === undefined ? 1000n : opts.startBlock,
    now: () => Date.now(),
    audioClock: audio,
    lookaheadMs: opts.lookaheadMs ?? 0,
    nudgeGain: opts.nudgeGain ?? 0.5,
  });
  const steps: Array<{ step: number; at: number; t: number }> = [];
  const headsSeen: bigint[] = [];
  clock.onStep((step, at) => steps.push({ step, at, t: Date.now() }));
  clock.onHead((n) => headsSeen.push(n));
  return { heads, audio, clock, steps, headsSeen };
}

describe('createBlockClock', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts idle with the startBlock, default cadence and the source kind', () => {
    const { clock, heads } = setup({ startBlock: 1000n });
    const s = clock.getState();
    expect(s.currentBlock).toBe(1000n);
    expect(s.currentStep).toBe(0);
    expect(s.measuredBlockMs).toBe(BLOCK_MS);
    expect(s.msSinceHead).toBe(0);
    expect(s.source).toBe('mock');
    expect(heads.subscribed).toBe(0);
  });

  it('subscribes on start and locks to the first head, firing onHead and onStep at the audio time', () => {
    const { clock, heads, steps, headsSeen, audio } = setup({ startBlock: 1000n });
    clock.start();
    expect(heads.subscribed).toBe(1);
    heads.emit(1005n);
    expect(clock.getState().currentBlock).toBe(1005n);
    expect(clock.getState().currentStep).toBe(5);
    expect(headsSeen).toEqual([1005n]);
    expect(steps).toEqual([{ step: 5, at: audio.currentTime, t: 0 }]);
  });

  it('free-runs one step per block interval without further heads', () => {
    const { clock, heads, steps } = setup({ startBlock: 1000n });
    clock.start();
    heads.emit(1000n);
    vi.advanceTimersByTime(BLOCK_MS * 3);
    expect(steps.map((s) => s.step)).toEqual([0, 1, 2, 3]);
    expect(clock.getState().currentBlock).toBe(1003n);
    expect(steps[3]?.t).toBe(BLOCK_MS * 3);
  });

  it('wraps the step at 16', () => {
    const { clock, heads, steps } = setup({ startBlock: 1000n });
    clock.start();
    heads.emit(1015n);
    vi.advanceTimersByTime(BLOCK_MS);
    expect(steps.map((s) => s.step)).toEqual([15, 0]);
  });

  it('derives the step from block % 16 when no startBlock is known', () => {
    const { clock, heads } = setup({ startBlock: null });
    clock.start();
    heads.emit(35n);
    expect(clock.getState().currentStep).toBe(3);
  });

  it('nudges the phase toward a late head without skipping or repeating a step', () => {
    const { clock, heads, steps } = setup({ startBlock: 1000n, nudgeGain: 0.5 });
    clock.start();
    heads.emit(1000n); // t=0, next tick expected at 300
    vi.advanceTimersByTime(300); // tick -> 1001 at 300, next at 600
    vi.advanceTimersByTime(50); // t=350
    heads.emit(1001n); // 50 ms late for block 1001 -> nudge next tick by +25
    vi.advanceTimersByTime(274); // t=624, tick for 1002 not yet fired
    expect(clock.getState().currentBlock).toBe(1001n);
    vi.advanceTimersByTime(1); // t=625 -> tick 1002
    expect(clock.getState().currentBlock).toBe(1002n);
    expect(steps.map((s) => s.step)).toEqual([0, 1, 2]);
  });

  it('nudges the phase toward an early head', () => {
    const { clock, heads } = setup({ startBlock: 1000n, nudgeGain: 0.5 });
    clock.start();
    heads.emit(1000n); // next tick at 300
    vi.advanceTimersByTime(250);
    heads.emit(1001n); // 50 ms early for block 1001 -> next tick at 275
    vi.advanceTimersByTime(24);
    expect(clock.getState().currentBlock).toBe(1000n);
    vi.advanceTimersByTime(1);
    expect(clock.getState().currentBlock).toBe(1001n);
  });

  it('hard-jumps only when the drift exceeds one block and fires the new step immediately', () => {
    const { clock, heads, steps } = setup({ startBlock: 1000n });
    clock.start();
    heads.emit(1000n);
    vi.advanceTimersByTime(600); // scheduler at 1002
    heads.emit(1010n); // 8 blocks ahead: drift far beyond one step
    expect(clock.getState().currentBlock).toBe(1010n);
    expect(steps.map((s) => s.step)).toEqual([0, 1, 2, 10]);
    vi.advanceTimersByTime(300);
    expect(clock.getState().currentBlock).toBe(1011n);
    expect(steps.at(-1)?.step).toBe(11);
  });

  it('hard-jumps backwards when the scheduler ran ahead by more than one block', () => {
    const { clock, heads, steps } = setup({ startBlock: 1000n });
    clock.start();
    heads.emit(1000n);
    vi.advanceTimersByTime(1500); // scheduler at 1005, chain stalled
    heads.emit(1002n); // the chain is 3 blocks behind
    expect(clock.getState().currentBlock).toBe(1002n);
    expect(steps.at(-1)?.step).toBe(2);
  });

  it('ignores stale and duplicate heads', () => {
    const { clock, heads, headsSeen } = setup({ startBlock: 1000n });
    clock.start();
    heads.emit(1005n);
    heads.emit(1005n);
    heads.emit(1004n);
    expect(headsSeen).toEqual([1005n]);
    expect(clock.getState().currentBlock).toBe(1005n);
  });

  it('measures the block interval over the last 32 heads', () => {
    const { clock, heads } = setup({ startBlock: 1000n });
    clock.start();
    // 10 heads at 500 ms, then 32 heads at 320 ms: only the last 32 must count.
    let block = 1000n;
    heads.emit(block);
    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(500);
      heads.emit(++block);
    }
    for (let i = 0; i < 32; i++) {
      vi.advanceTimersByTime(320);
      heads.emit(++block);
    }
    expect(clock.getState().measuredBlockMs).toBeCloseTo(320, 5);
  });

  it('keeps the nominal cadence until enough heads were seen', () => {
    const { clock, heads } = setup({ startBlock: 1000n });
    clock.start();
    heads.emit(1000n);
    vi.advanceTimersByTime(250);
    heads.emit(1001n);
    expect(clock.getState().measuredBlockMs).toBe(BLOCK_MS);
  });

  it('clamps the measured interval to a sane range', () => {
    const { clock, heads } = setup({ startBlock: 1000n });
    clock.start();
    let block = 1000n;
    heads.emit(block);
    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(1);
      heads.emit(++block);
    }
    expect(clock.getState().measuredBlockMs).toBe(100);
    for (let i = 0; i < 40; i++) {
      vi.advanceTimersByTime(60_000);
      heads.emit(++block);
    }
    expect(clock.getState().measuredBlockMs).toBe(2000);
  });

  it('predicts the block that will be current after a delay', () => {
    const { clock, heads } = setup({ startBlock: 1000n });
    clock.start();
    expect(clock.predictBlock(1000)).toBe(1000n);
    heads.emit(1000n); // next tick at 300
    expect(clock.predictBlock(0)).toBe(1000n);
    expect(clock.predictBlock(299)).toBe(1000n);
    expect(clock.predictBlock(300)).toBe(1001n);
    expect(clock.predictBlock(1000)).toBe(1003n);
    vi.advanceTimersByTime(100);
    expect(clock.predictBlock(200)).toBe(1001n);
  });

  it('reports msSinceHead', () => {
    const { clock, heads } = setup();
    clock.start();
    heads.emit(1000n);
    vi.advanceTimersByTime(120);
    expect(clock.getState().msSinceHead).toBe(120);
  });

  it('schedules the step early by the lookahead and reports the exact audio time', () => {
    const { clock, heads, steps, audio } = setup({ startBlock: 1000n, lookaheadMs: 40 });
    clock.start();
    heads.emit(1000n); // next tick at 300, fires at 260
    vi.advanceTimersByTime(259);
    expect(steps).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(steps).toHaveLength(2);
    expect(steps[1]?.at).toBeCloseTo(audio.currentTime + 0.04, 6);
  });

  it('uses a replaced audio clock', () => {
    const { clock, heads, steps } = setup({ startBlock: 1000n });
    clock.setAudioClock({ currentTime: 99 });
    clock.start();
    heads.emit(1000n);
    expect(steps[0]?.at).toBe(99);
  });

  it('unsubscribes listeners', () => {
    const { clock, heads } = setup();
    const seen: number[] = [];
    const off = clock.onStep((s) => seen.push(s));
    clock.start();
    heads.emit(1000n);
    off();
    vi.advanceTimersByTime(300);
    expect(seen).toEqual([0]);
  });

  it('stop() cancels the scheduler and the subscription; start() is idempotent', () => {
    const { clock, heads, steps } = setup();
    clock.start();
    clock.start();
    expect(heads.subscribed).toBe(1);
    heads.emit(1000n);
    clock.stop();
    expect(heads.unsubscribed).toBe(1);
    vi.advanceTimersByTime(900);
    expect(steps).toHaveLength(1);
    expect(clock.getState().currentBlock).toBe(1000n);
  });

  it('forgets the phase on stop so a restart waits for a fresh head', () => {
    const { clock, heads, steps } = setup({ startBlock: 1000n });
    clock.start();
    heads.emit(1000n);
    vi.advanceTimersByTime(300);
    clock.stop();
    vi.advanceTimersByTime(5_000);
    clock.start();
    vi.advanceTimersByTime(1_000);
    expect(steps).toHaveLength(2); // nothing ticks until a head re-locks the phase
    heads.emit(1020n);
    expect(clock.getState().currentBlock).toBe(1020n);
    vi.advanceTimersByTime(300);
    expect(clock.getState().currentBlock).toBe(1021n);
  });

  it('reports head-source errors to onError listeners instead of swallowing them', () => {
    const { clock, heads } = setup();
    const errors: Error[] = [];
    clock.onError((e) => errors.push(e));
    clock.start();
    heads.fail(new Error('socket closed'));
    expect(errors.map((e) => e.message)).toEqual(['socket closed']);
  });

  it('keeps ticking through a head-source error', () => {
    const { clock, heads } = setup();
    clock.onError(() => undefined);
    clock.start();
    heads.emit(1000n);
    heads.fail(new Error('socket closed'));
    vi.advanceTimersByTime(300);
    expect(clock.getState().currentBlock).toBe(1001n);
  });

  it('setStartBlock re-derives the step', () => {
    const { clock, heads } = setup({ startBlock: 1000n });
    clock.start();
    heads.emit(1005n);
    clock.setStartBlock(1003n);
    expect(clock.getState().currentStep).toBe(2);
  });
});
