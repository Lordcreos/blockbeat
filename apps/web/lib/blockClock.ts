/**
 * Block clock: a free-running step scheduler phase-locked to Monad heads.
 *
 * The chain is the metronome, but audio must never wait for the network. The clock keeps
 * its own 300 ms (measured) scheduler and, on every new head, compares when that block
 * was expected versus when it arrived. Small drift nudges the phase; drift beyond one
 * full block hard-jumps so the playhead never lags visibly.
 *
 * Everything time-related is injectable so tests run on fake timers with a fake head source.
 */
import { BLOCK_MS, STEPS, stepForBlock } from '@blockbeat/shared';
import type { BlockClock, BlockClockState } from './types';

export type HeadSourceKind = BlockClockState['source'];

/** Anything that delivers new block numbers: a WebSocket subscription, a poller, or the simulator. */
export interface HeadSource {
  kind(): HeadSourceKind;
  subscribe(onHead: (blockNumber: bigint) => void, onError: (error: Error) => void): () => void;
}

/** The subset of AudioContext the clock needs. Tone exposes it via `getContext().rawContext`. */
export interface AudioClockLike {
  readonly currentTime: number;
}

export interface BlockClockOptions {
  headSource: HeadSource;
  /** Session start block; null derives the step from `block % 16`. */
  startBlock?: bigint | null;
  /** Wall clock in ms. Defaults to Date.now so fake timers work. */
  now?: () => number;
  /** Audio clock used for the `atAudioTime` argument of onStep. */
  audioClock?: AudioClockLike;
  /** Fire onStep this many ms before the step so audio can be scheduled precisely. */
  lookaheadMs?: number;
  /** Fraction of the measured drift applied to the phase per head (0..1). */
  nudgeGain?: number;
  /** Heads used for the cadence measurement. */
  historySize?: number;
  /** Initial block interval, ms. */
  blockMs?: number;
}

export interface BlockClockController extends BlockClock {
  onError(cb: (error: Error) => void): () => void;
  setAudioClock(clock: AudioClockLike): void;
  setStartBlock(startBlock: bigint | null): void;
}

const MIN_BLOCK_MS = 100;
const MAX_BLOCK_MS = 2000;
/** Heads needed before the measured cadence replaces the nominal BLOCK_MS. */
const MIN_SAMPLES = 8;

interface HeadSample {
  block: bigint;
  at: number;
}

function defaultAudioClock(): AudioClockLike {
  return {
    get currentTime() {
      return performance.now() / 1000;
    },
  };
}

export function createBlockClock(options: BlockClockOptions): BlockClockController {
  const { headSource } = options;
  const now = options.now ?? (() => Date.now());
  const lookaheadMs = options.lookaheadMs ?? 40;
  const nudgeGain = options.nudgeGain ?? 0.3;
  const historySize = options.historySize ?? 32;

  let audioClock: AudioClockLike = options.audioClock ?? defaultAudioClock();
  let startBlock: bigint | null = options.startBlock ?? null;
  let measuredBlockMs = options.blockMs ?? BLOCK_MS;

  let currentBlock: bigint = startBlock ?? 0n;
  let locked = false;
  /** Wall time at which `currentBlock` became current (its scheduled tick). */
  let lastTickAt = 0;
  /** Wall time at which `currentBlock + 1` is expected. */
  let nextTickAt = 0;
  let lastHeadAt: number | null = null;
  let lastHeadBlock: bigint | null = null;
  const history: HeadSample[] = [];

  let timer: ReturnType<typeof setTimeout> | null = null;
  let unsubscribe: (() => void) | null = null;
  let running = false;

  const stepListeners = new Set<(step: number, atAudioTime: number) => void>();
  const headListeners = new Set<(blockNumber: bigint) => void>();
  const errorListeners = new Set<(error: Error) => void>();

  function stepOf(block: bigint): number {
    return startBlock === null ? Number(block % BigInt(STEPS)) : stepForBlock(startBlock, block);
  }

  function emitStep(block: bigint, atWallTime: number): void {
    const t = now();
    const atAudioTime = audioClock.currentTime + Math.max(0, atWallTime - t) / 1000;
    const step = stepOf(block);
    for (const cb of stepListeners) cb(step, atAudioTime);
  }

  function clearTimer(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function schedule(): void {
    clearTimer();
    if (!running || !locked) return;
    const delay = Math.max(0, nextTickAt - lookaheadMs - now());
    timer = setTimeout(tick, delay);
  }

  function tick(): void {
    timer = null;
    if (!running || !locked) return;
    currentBlock += 1n;
    lastTickAt = nextTickAt;
    nextTickAt = lastTickAt + measuredBlockMs;
    emitStep(currentBlock, lastTickAt);
    schedule();
  }

  function recordHead(block: bigint, at: number): void {
    history.push({ block, at });
    while (history.length > historySize) history.shift();
    if (history.length < MIN_SAMPLES) return;
    const first = history[0];
    const last = history[history.length - 1];
    if (!first || !last || first === last) return;
    const blocks = Number(last.block - first.block);
    if (blocks <= 0) return;
    const avg = (last.at - first.at) / blocks;
    measuredBlockMs = Math.min(MAX_BLOCK_MS, Math.max(MIN_BLOCK_MS, avg));
  }

  function lockTo(block: bigint, at: number): void {
    currentBlock = block;
    lastTickAt = at;
    nextTickAt = at + measuredBlockMs;
    locked = true;
    emitStep(block, at);
    schedule();
  }

  function onHead(block: bigint): void {
    if (lastHeadBlock !== null && block <= lastHeadBlock) return; // stale or duplicate
    const at = now();
    lastHeadBlock = block;
    lastHeadAt = at;
    recordHead(block, at);

    if (!locked) {
      lockTo(block, at);
    } else {
      const expectedAt = lastTickAt + Number(block - currentBlock) * measuredBlockMs;
      const drift = at - expectedAt;
      if (Math.abs(drift) > measuredBlockMs) {
        lockTo(block, at);
      } else {
        nextTickAt += drift * nudgeGain;
        schedule();
      }
    }
    for (const cb of headListeners) cb(block);
  }

  function onError(error: Error): void {
    for (const cb of errorListeners) cb(error);
  }

  return {
    getState(): BlockClockState {
      return {
        currentBlock,
        currentStep: stepOf(currentBlock),
        measuredBlockMs,
        msSinceHead: lastHeadAt === null ? 0 : Math.max(0, now() - lastHeadAt),
        source: headSource.kind(),
      };
    },
    onStep(cb) {
      stepListeners.add(cb);
      return () => stepListeners.delete(cb);
    },
    onHead(cb) {
      headListeners.add(cb);
      return () => headListeners.delete(cb);
    },
    onError(cb) {
      errorListeners.add(cb);
      return () => errorListeners.delete(cb);
    },
    predictBlock(msFromNow: number): bigint {
      if (!locked) return currentBlock;
      const target = now() + msFromNow;
      if (target < nextTickAt) return currentBlock;
      return currentBlock + 1n + BigInt(Math.floor((target - nextTickAt) / measuredBlockMs));
    },
    start() {
      if (running) return;
      running = true;
      unsubscribe = headSource.subscribe(onHead, onError);
      schedule();
    },
    stop() {
      if (!running) return;
      running = false;
      clearTimer();
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
      // Forget the phase: a restart must wait for a fresh head instead of replaying stale ticks.
      locked = false;
      lastHeadBlock = null;
    },
    setAudioClock(clock) {
      audioClock = clock;
    },
    setStartBlock(block) {
      startBlock = block;
    },
  };
}
