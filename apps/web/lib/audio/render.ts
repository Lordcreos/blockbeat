/**
 * Offline rendering helpers built on Tone.Offline: used by the tests and the demo script,
 * and handy for anyone who wants to bounce a finalized pattern to a buffer.
 */
import { BLOCK_MS, STEPS, type Pattern, type TrackId } from '@blockbeat/shared';
import * as Tone from 'tone';
import type { BlockClock, BlockClockState } from '../types';
import { createAudioEngine } from './engine';
import { createKit } from './kit';
import { createMasterChain } from './master';
import { assertPattern } from './patternPlayer';

export interface RenderOptions {
  seconds: number;
  /** Seconds per step; defaults to one Monad block. */
  stepSec?: number;
  sampleRate?: number;
  channels?: number;
  masterDb?: number;
}

export interface Trigger {
  track: TrackId;
  note: number;
  /** Audio time in seconds. */
  at: number;
}

/** A BlockClock whose steps are fired by the caller. Useful for renders and tests. */
export class ScriptedClock implements BlockClock {
  private readonly listeners = new Set<(step: number, atAudioTime: number) => void>();
  private readonly headListeners = new Set<(blockNumber: bigint) => void>();
  private block = 0n;

  getState(): BlockClockState {
    return {
      currentBlock: this.block,
      currentStep: Number(this.block % BigInt(STEPS)),
      measuredBlockMs: BLOCK_MS,
      msSinceHead: 0,
      source: 'mock',
    };
  }

  onStep(cb: (step: number, atAudioTime: number) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  onHead(cb: (blockNumber: bigint) => void): () => void {
    this.headListeners.add(cb);
    return () => {
      this.headListeners.delete(cb);
    };
  }

  predictBlock(msFromNow: number): bigint {
    return this.block + BigInt(Math.max(0, Math.floor(msFromNow / BLOCK_MS)));
  }

  start(): void {}

  stop(): void {}

  /** Advance one block and fire the corresponding step at `atAudioTime`. */
  fire(step: number, atAudioTime: number): void {
    this.block += 1n;
    for (const cb of this.headListeners) cb(this.block);
    for (const cb of this.listeners) cb(step, atAudioTime);
  }
}

/**
 * Render `seconds` of a pattern looping at `stepSec` per step through the full engine.
 * Nothing is disposed inside the callback on purpose: Tone.Offline renders after the callback
 * returns, and disposing first would disconnect the graph. The offline context is discarded
 * with everything in it once the render resolves.
 */
export async function renderPattern(pattern: Pattern, options: RenderOptions): Promise<Tone.ToneAudioBuffer> {
  assertPattern(pattern);
  const stepSec = options.stepSec ?? BLOCK_MS / 1000;
  return Tone.Offline(
    async () => {
      const engine = createAudioEngine();
      engine.setMasterVolumeDb(options.masterDb ?? 0);
      await engine.start();
      if (!engine.isStarted()) throw new Error('offline engine failed to start');
      engine.setPattern(pattern);
      const clock = new ScriptedClock();
      engine.attachClock(clock);
      for (let k = 0; k * stepSec < options.seconds; k++) clock.fire(k % STEPS, k * stepSec);
    },
    options.seconds,
    options.channels ?? 2,
    options.sampleRate ?? 44100,
  );
}

/** Render arbitrary triggers straight through the kit and master chain. */
export async function renderTriggers(triggers: readonly Trigger[], options: RenderOptions): Promise<Tone.ToneAudioBuffer> {
  return Tone.Offline(
    async () => {
      const master = createMasterChain();
      master.setVolumeDb(options.masterDb ?? 0);
      const kit = createKit();
      kit.connect(master.input);
      await kit.ready;
      for (const t of triggers) kit.trigger(t.track, t.note, t.at);
    },
    options.seconds,
    options.channels ?? 2,
    options.sampleRate ?? 44100,
  );
}
