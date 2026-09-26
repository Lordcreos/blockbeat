/**
 * W15: a BlockClock with no chain behind it, for replaying a minted track at 100 BPM.
 *
 * The recorded pattern is chain state, but playing it back needs no heads: one step every
 * BLOCK_MS (300 ms) from a local timer. Each step fires `lookaheadMs` before it should sound
 * and carries its time on the audio clock, so the audio engine schedules it sample-accurately.
 * Step k is due at `start + k × stepMs` measured from the start, never from the previous
 * timer, so late timers do not accumulate drift.
 */
import { BLOCK_MS, STEPS } from '@blockbeat/shared';
import type { BlockClock, BlockClockState } from '../types';

export const LOCAL_CLOCK_LOOKAHEAD_MS = 40;

export interface LocalClockOptions {
  stepMs?: number;
  lookaheadMs?: number;
  /** Wall clock, ms. Defaults to Date.now so fake timers work. */
  now?: () => number;
}

export interface AudioClockLike {
  readonly currentTime: number;
}

export interface LocalClock extends BlockClock {
  setAudioClock(ctx: AudioClockLike): void;
}

function defaultAudioClock(): AudioClockLike {
  return {
    get currentTime() {
      return performance.now() / 1000;
    },
  };
}

export function createLocalClock(options: LocalClockOptions = {}): LocalClock {
  const stepMs = options.stepMs ?? BLOCK_MS;
  const lookaheadMs = options.lookaheadMs ?? LOCAL_CLOCK_LOOKAHEAD_MS;
  const now = options.now ?? (() => Date.now());

  let audioClock: AudioClockLike = defaultAudioClock();
  let running = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** Wall time at which step 0 fires (it sounds `lookaheadMs` later). */
  let startedAt = 0;
  /** Steps fired since start; the current block is `fired - 1`. */
  let fired = 0;
  const stepListeners = new Set<(step: number, atAudioTime: number) => void>();
  const headListeners = new Set<(blockNumber: bigint) => void>();

  const currentBlock = (): bigint => BigInt(Math.max(0, fired - 1));

  function fire(): void {
    const block = fired;
    fired += 1;
    const soundsAt = startedAt + block * stepMs + lookaheadMs;
    const atAudioTime = audioClock.currentTime + Math.max(0, soundsAt - now()) / 1000;
    const step = block % STEPS;
    for (const cb of headListeners) cb(BigInt(block));
    for (const cb of stepListeners) cb(step, atAudioTime);
  }

  function schedule(): void {
    if (!running) return;
    const nextAt = startedAt + fired * stepMs;
    timer = setTimeout(tick, Math.max(0, nextAt - now()));
  }

  function tick(): void {
    timer = null;
    if (!running) return;
    fire();
    schedule();
  }

  return {
    getState(): BlockClockState {
      const block = currentBlock();
      return { currentBlock: block, currentStep: Number(block % BigInt(STEPS)), measuredBlockMs: stepMs, msSinceHead: 0, source: 'mock' };
    },
    onStep(cb) {
      stepListeners.add(cb);
      return () => {
        stepListeners.delete(cb);
      };
    },
    onHead(cb) {
      headListeners.add(cb);
      return () => {
        headListeners.delete(cb);
      };
    },
    predictBlock(msFromNow: number): bigint {
      if (!running) return currentBlock();
      const elapsed = now() + msFromNow - startedAt;
      return BigInt(Math.max(0, Math.floor(elapsed / stepMs)));
    },
    start() {
      if (running) return;
      running = true;
      startedAt = now();
      fired = 0;
      fire();
      schedule();
    },
    stop() {
      running = false;
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
    setAudioClock(ctx) {
      audioClock = ctx;
    },
  };
}
