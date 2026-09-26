'use client';
/**
 * W15: replays a recorded pattern (a minted track) through the W4 audio engine at 100 BPM on
 * a local clock: no chain needed, the pattern already is chain state.
 *
 * Nothing touches WebAudio before the first play(): the engine and the clock are built inside
 * the click (browser autoplay rules). One engine per hook, so a page that lists many tracks
 * plays one at a time: playing another id swaps the pattern and restarts at step 0.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Pattern } from '@blockbeat/shared';
import { createLocalClock, type LocalClock } from '@/lib/track/localClock';
import { volumeToDb } from '@/lib/track/volume';
import type { AudioEngine } from '@/lib/types';

/**
 * Tone creates its AudioContext when the module loads, so the engine is imported inside the
 * first click: before it, the page has no AudioContext at all (and no autoplay warning).
 */
async function loadAudioEngine(): Promise<AudioEngine> {
  const { createAudioEngine } = await import('@/lib/audio');
  return createAudioEngine();
}

export interface TrackPlayerOptions {
  /** Injectable for tests; defaults to the Tone.js engine, loaded on the first play(). */
  createEngine?: () => AudioEngine;
}

export interface TrackPlayer {
  /** Id of the track playing, or null. */
  playingId: string | null;
  /** Step under the playhead while playing, else null. */
  step: number | null;
  starting: boolean;
  /** Id of the track whose audio is starting, or null. */
  startingId: string | null;
  error: string | null;
  /** 0..1 */
  volume: number;
  setVolume(volume: number): void;
  /** Must run inside the click that unlocks audio. */
  play(id: string, pattern: Pattern): Promise<void>;
  stop(): void;
  toggle(id: string, pattern: Pattern): Promise<void>;
}

interface Rig {
  engine: AudioEngine;
  clock: LocalClock;
  detach: () => void;
  offStep: () => void;
}

export function useTrackPlayer({ createEngine }: TrackPlayerOptions = {}): TrackPlayer {
  const [factory] = useState(() => createEngine);
  const rigRef = useRef<Rig | null>(null);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [step, setStep] = useState<number | null>(null);
  const [startingId, setStartingId] = useState<string | null>(null);
  const starting = startingId !== null;
  const [error, setError] = useState<string | null>(null);
  const [volume, setVolumeState] = useState(0.8);
  const volumeRef = useRef(volume);
  const mountedRef = useRef(false);
  /** Bumped by every play() and stop(): an older play() that resumes after an await gives up. */
  const callRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const rig = rigRef.current;
      rigRef.current = null;
      if (!rig) return;
      rig.clock.stop();
      rig.offStep();
      rig.detach();
      rig.engine.dispose();
    };
  }, []);

  const rig = useCallback(async (): Promise<Rig | null> => {
    if (rigRef.current) return rigRef.current;
    const engine = factory ? factory() : await loadAudioEngine();
    // Unmounted while the engine module loaded: nothing to wire.
    if (!mountedRef.current) {
      engine.dispose();
      return null;
    }
    if (rigRef.current) {
      engine.dispose();
      return rigRef.current;
    }
    const clock = createLocalClock();
    engine.setMasterVolumeDb(volumeToDb(volumeRef.current));
    const detach = engine.attachClock(clock);
    const offStep = clock.onStep((s) => setStep(s));
    rigRef.current = { engine, clock, detach, offStep };
    return rigRef.current;
  }, [factory]);

  const stop = useCallback(() => {
    callRef.current += 1;
    setStartingId(null);
    rigRef.current?.clock.stop();
    setPlayingId(null);
    setStep(null);
  }, []);

  const play = useCallback(
    async (id: string, pattern: Pattern) => {
      const call = ++callRef.current;
      // A newer play()/stop() ran, or the hook unmounted, while this one awaited.
      const stale = (): boolean => call !== callRef.current || !mountedRef.current;
      setStartingId(id);
      setError(null);
      let current: Rig | null;
      try {
        current = await rig();
      } catch (err) {
        if (stale()) return;
        setStartingId(null);
        setError(err instanceof Error ? `the audio engine did not load (${err.message})` : 'the audio engine did not load');
        return;
      }
      if (!current || stale()) return;
      const { engine, clock } = current;
      clock.stop();
      try {
        await engine.start();
      } catch (err) {
        if (stale()) return;
        setStartingId(null);
        setError(err instanceof Error ? err.message : 'audio did not start; click again');
        setPlayingId(null);
        setStep(null);
        return;
      }
      if (stale() || rigRef.current?.engine !== engine) return;
      engine.setPattern(pattern);
      setPlayingId(id);
      clock.start();
      // Only now: the button never shows "Play" again between start() and the loop running.
      setStartingId(null);
    },
    [rig],
  );

  const toggle = useCallback(
    async (id: string, pattern: Pattern) => {
      if (playingId === id) stop();
      else await play(id, pattern);
    },
    [playingId, play, stop],
  );

  const setVolume = useCallback((next: number) => {
    const v = Number.isFinite(next) ? Math.min(1, Math.max(0, next)) : 0;
    volumeRef.current = v;
    setVolumeState(v);
    rigRef.current?.engine.setMasterVolumeDb(volumeToDb(v));
  }, []);

  return { playingId, step, starting, startingId, error, volume, setVolume, play, stop, toggle };
}
