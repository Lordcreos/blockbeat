import './testing/install-node-web-audio';
import { describe, expect, it } from 'vitest';
import { emptyPattern, toggle } from '@blockbeat/shared';
import * as Tone from 'tone';
import { ScriptedClock, createAudioEngine } from './index';
import { rms } from './testing/analysis';

const SR = 44100;

describe('createAudioEngine with the real Tone.js kit (offline)', () => {
  it('starts, schedules a step from a clock and plays an immediate hit', async () => {
    const buffer = await Tone.Offline(async () => {
      const engine = createAudioEngine();
      await engine.start();
      expect(engine.isStarted()).toBe(true);
      const pattern = emptyPattern();
      pattern[3] = toggle(0n, 0, 0);
      engine.setPattern(pattern);
      const clock = new ScriptedClock();
      engine.attachClock(clock);
      clock.fire(3, 0.5);
      engine.playImmediate(2, 0);
    }, 1, 1, SR);
    const ch = buffer.getChannelData(0);
    expect(rms(ch, SR, 0.5, 0.52)).toBeGreaterThan(0.05);
    expect(rms(ch, SR, 0.0, 0.06)).toBeGreaterThan(0.005);
    expect(rms(ch, SR, 0.3, 0.45)).toBeLessThan(0.005);
  });
});
