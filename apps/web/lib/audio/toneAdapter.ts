/** Default AudioContext adapter backed by Tone's current global context. */
import * as Tone from 'tone';
import type { AudioContextAdapter } from './engine';

export function createToneAdapter(): AudioContextAdapter {
  const ctx = Tone.getContext();
  return {
    resume: () => ctx.resume(),
    getState: () => ctx.state,
    now: () => ctx.currentTime,
    rawContext: () => ctx.rawContext,
    isOffline: () => ctx instanceof Tone.OfflineContext,
  };
}
