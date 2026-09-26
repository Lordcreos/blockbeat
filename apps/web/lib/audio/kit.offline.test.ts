/**
 * Renders the real Tone.js kit through an OfflineAudioContext. Node has no WebAudio, so the
 * test-only polyfill below installs node-web-audio-api before Tone is imported.
 */
import './testing/install-node-web-audio';
import { describe, expect, it } from 'vitest';
import { NOTES_PER_TRACK, TRACKS, emptyPattern, toggle, type TrackId } from '@blockbeat/shared';
import * as Tone from 'tone';
import { createKit } from './kit';
import { createMasterChain } from './master';
import { renderPattern, renderTriggers } from './render';
import { rms } from './testing/analysis';

const SR = 44100;

describe('synth kit (offline render)', () => {
  it('has exactly eight instruments in TRACK_META order', async () => {
    await Tone.Offline(() => {
      const kit = createKit();
      expect(kit.size).toBe(8);
      expect(kit.keys).toEqual(['kick', 'snare', 'hat', 'clap', 'bass', 'lead', 'pad', 'fx']);
      kit.dispose();
    }, 0.01, 1, SR);
  });

  it('a pattern with a kick on step 0 is loud at t=0 and silent around t=150 ms', async () => {
    const pattern = emptyPattern();
    pattern[0] = toggle(0n, 0, 0);
    const buffer = await renderPattern(pattern, { seconds: 0.3, stepSec: 0.3, sampleRate: SR });
    const ch = buffer.getChannelData(0);
    // The engine never schedules closer than DEFAULT_MIN_LEAD_SEC (20 ms) to "now", an offline
    // context starts at 0, and the master compressors add ~10 ms of lookahead latency, so the
    // onset lands inside the first 50 ms.
    expect(rms(ch, SR, 0, 0.05)).toBeGreaterThan(0.05);
    expect(rms(ch, SR, 0.14, 0.16)).toBeLessThan(0.005);
    expect(rms(ch, SR, 0.2, 0.3)).toBeLessThan(0.001);
  });

  it('two notes on the same track in one step both sound and nothing throws', async () => {
    const pattern = emptyPattern();
    pattern[0] = toggle(toggle(0n, 4, 0), 4, 7);
    const buffer = await renderPattern(pattern, { seconds: 0.3, stepSec: 0.3, sampleRate: SR });
    expect(rms(buffer.getChannelData(0), SR, 0.02, 0.1)).toBeGreaterThan(0.02);
  });

  it('a non-finite trigger time is dropped and does not poison later hits on that track', async () => {
    const buffer = await Tone.Offline(async () => {
      const kit = createKit();
      kit.connect(Tone.getDestination());
      await kit.ready;
      kit.trigger(0, 0, Number.NaN);
      kit.trigger(0, 0, 0.1);
    }, 0.3, 1, SR);
    expect(rms(buffer.getChannelData(0), SR, 0.1, 0.15)).toBeGreaterThan(0.05);
  });

  it('an immediate hit arriving behind an already scheduled step does not throw', async () => {
    await Tone.Offline(async () => {
      const kit = createKit();
      kit.connect(Tone.getDestination());
      await kit.ready;
      kit.trigger(2, 0, 0.2);
      expect(() => kit.trigger(2, 0, 0.05)).not.toThrow();
      expect(() => kit.trigger(2, 3, 0.2)).not.toThrow();
    }, 0.3, 1, SR);
  });

  it('every track produces audible output for its first and last note variant', async () => {
    const triggers: Array<{ track: TrackId; note: number; at: number }> = [];
    for (let t = 0; t < TRACKS; t++) {
      triggers.push({ track: t as TrackId, note: 0, at: t * 2 });
      triggers.push({ track: t as TrackId, note: NOTES_PER_TRACK - 1, at: t * 2 + 1 });
    }
    const buffer = await renderTriggers(triggers, { seconds: TRACKS * 2, sampleRate: SR });
    const ch = buffer.getChannelData(0);
    for (const trig of triggers) {
      expect(rms(ch, SR, trig.at, trig.at + 0.05), `track ${trig.track} note ${trig.note}`).toBeGreaterThan(0.01);
    }
  });

  it('the master chain keeps a full room of simultaneous hits under 0 dBFS', async () => {
    const buffer = await Tone.Offline(async () => {
      const master = createMasterChain();
      const kit = createKit();
      kit.connect(master.input);
      await kit.ready;
      for (let t = 0; t < TRACKS; t++) kit.trigger(t as TrackId, 0, 0.05);
      for (let t = 0; t < TRACKS; t++) kit.trigger(t as TrackId, 17, 0.05);
    }, 0.5, 1, SR);
    const ch = buffer.getChannelData(0);
    let peak = 0;
    for (let i = 0; i < ch.length; i++) peak = Math.max(peak, Math.abs(ch[i] ?? 0));
    expect(peak).toBeLessThanOrEqual(1);
    expect(peak).toBeGreaterThan(0.1);
  });
});
