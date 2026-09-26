'use client';
/**
 * Binds the W4 audio engine to the stage: one engine per mounted stage, attached to the
 * runtime block clock, fed the live pattern, and asked to play a hit immediately when it
 * lands on the step the playhead is on. Mute and volume drive the master chain.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { HitEvent, Pattern } from '@blockbeat/shared';
import { createAudioEngine } from '@/lib/audio';
import { getRuntime } from '@/lib/runtime';
import type { AudioEngine } from '@/lib/types';

/** Effectively silent without disabling the chain (the master ignores non-finite values). */
export const MUTE_DB = -100;

/** Slider position 0..1 to master gain in dB: 1 → 0 dB, 0 → MUTE_DB, log taper between. */
export function volumeToDb(volume: number): number {
  if (!Number.isFinite(volume) || volume <= 0) return MUTE_DB;
  if (volume >= 1) return 0;
  return Math.max(MUTE_DB, 20 * Math.log10(volume));
}

export interface StageAudioOptions {
  pattern: Pattern;
  lastHit: HitEvent | null;
  /**
   * W13: with note decay every Hit is a note played, whatever its `on` flag. False (decay off)
   * keeps the recorded semantics, where `on` false is a toggle-off and nothing sounds.
   */
  everyHitSounds?: boolean;
  /** Injectable for tests; defaults to the Tone.js engine. */
  createEngine?: () => AudioEngine;
}

export interface StageAudio {
  /** Must run inside the user gesture that unlocks audio. Rejects when the context stays suspended. */
  start(): Promise<void>;
  started: boolean;
  muted: boolean;
  setMuted(muted: boolean): void;
  /** 0..1 */
  volume: number;
  setVolume(volume: number): void;
}

export function useStageAudio({ pattern, lastHit, everyHitSounds = false, createEngine = createAudioEngine }: StageAudioOptions): StageAudio {
  const engineRef = useRef<AudioEngine | null>(null);
  // The factory is read once, on mount; later prop changes never rebuild the engine.
  const [factory] = useState(() => createEngine);
  const [started, setStarted] = useState(false);
  const [muted, setMutedState] = useState(false);
  const [volume, setVolumeState] = useState(1);

  // Nothing touches WebAudio until start(), so the engine can be built in an effect; the
  // cleanup disposes it (Fast Refresh, StrictMode double-invoke) so master chains never stack.
  useEffect(() => {
    const engine = factory();
    engineRef.current = engine;
    const detach = engine.attachClock(getRuntime().clock);
    return () => {
      detach();
      engine.dispose();
      if (engineRef.current === engine) engineRef.current = null;
    };
  }, [factory]);

  useEffect(() => {
    engineRef.current?.setPattern(pattern);
  }, [pattern]);

  useEffect(() => {
    engineRef.current?.setMasterVolumeDb(muted ? MUTE_DB : volumeToDb(volume));
  }, [muted, volume]);

  // A hit that lands on the current step is heard now; otherwise the pattern player picks it
  // up on the next pass. Without decay `on` false is a toggle-off: nothing to hear. With decay
  // (W13) every tap sounds.
  useEffect(() => {
    if (!lastHit || (!lastHit.on && !everyHitSounds)) return;
    if (lastHit.step !== getRuntime().clock.getState().currentStep) return;
    engineRef.current?.playImmediate(lastHit.track, lastHit.note);
  }, [lastHit, everyHitSounds]);

  // macOS suspends the context on an output-device change, the lid, or a hidden tab; the
  // engine keeps its flag but isStarted() reads the real state. Poll it so the overlay
  // comes back and the next click calls start() again.
  useEffect(() => {
    if (!started) return;
    const id = setInterval(() => {
      const engine = engineRef.current;
      if (engine && !engine.isStarted()) setStarted(false);
    }, 1000);
    return () => clearInterval(id);
  }, [started]);

  const start = useCallback(async () => {
    const engine = engineRef.current;
    if (!engine) throw new Error('audio engine is not mounted');
    await engine.start();
    // Unmounted (and disposed) while the context was unlocking: nothing to report.
    if (engineRef.current !== engine) return;
    if (!engine.isStarted()) throw new Error('audio context did not start; click again');
    setStarted(true);
  }, []);

  const setMuted = useCallback((next: boolean) => setMutedState(next), []);
  const setVolume = useCallback((next: number) => setVolumeState(Math.min(1, Math.max(0, next))), []);

  return { start, started, muted, setMuted, volume, setVolume };
}
