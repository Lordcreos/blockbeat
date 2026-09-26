import { describe, expect, it, vi } from 'vitest';
import { TRACK_META } from '@blockbeat/shared';
import { PREVIEW_VOLUME, createPreviewVoice, type PreviewContext } from './preview';

/** A recording fake of the WebAudio subset the preview voice uses. */
function fakeContext(state: AudioContextState = 'running') {
  const started: Array<{ kind: string; at: number }> = [];
  const param = (initial = 0) => {
    const p = {
      value: initial,
      setValueAtTime: vi.fn(() => p),
      linearRampToValueAtTime: vi.fn(() => p),
      exponentialRampToValueAtTime: vi.fn(() => p),
    };
    return p;
  };
  const node = () => ({ connect: vi.fn(), disconnect: vi.fn() });
  const ctx = {
    currentTime: 1.5,
    sampleRate: 8000,
    state,
    destination: node(),
    resume: vi.fn(async () => {
      ctx.state = 'running';
    }),
    close: vi.fn(async () => undefined),
    createOscillator: vi.fn(() => ({ ...node(), type: 'sine' as OscillatorType, frequency: param(440), start: vi.fn((at: number) => started.push({ kind: 'osc', at })), stop: vi.fn() })),
    createGain: vi.fn(() => ({ ...node(), gain: param(1) })),
    createBiquadFilter: vi.fn(() => ({ ...node(), type: 'lowpass' as BiquadFilterType, frequency: param(350), Q: param(1) })),
    createBuffer: vi.fn((_ch: number, length: number) => {
      const data = new Float32Array(length);
      return { getChannelData: () => data };
    }),
    createBufferSource: vi.fn(() => ({ ...node(), buffer: null, start: vi.fn((at: number) => started.push({ kind: 'noise', at })), stop: vi.fn() })),
  };
  return { ctx: ctx as typeof ctx & PreviewContext, started };
}

describe('createPreviewVoice', () => {
  it('creates no audio context until the first play (a user gesture)', () => {
    const create = vi.fn(() => fakeContext().ctx);
    createPreviewVoice({ createContext: create });
    expect(create).not.toHaveBeenCalled();
  });

  it.each(TRACK_META.map((m) => m.id))('track %i starts a sound now through envelopes no louder than 1', (track) => {
    const { ctx, started } = fakeContext();
    const voice = createPreviewVoice({ createContext: () => ctx });
    expect(voice.play(track, 0)).toBe(true);
    expect(started.length).toBeGreaterThan(0);
    for (const s of started) expect(s.at).toBeGreaterThanOrEqual(ctx.currentTime);
    const levels = ctx.createGain.mock.results.slice(1).flatMap((r) => [
      ...r.value.gain.setValueAtTime.mock.calls,
      ...r.value.gain.linearRampToValueAtTime.mock.calls,
      ...r.value.gain.exponentialRampToValueAtTime.mock.calls,
    ]);
    expect(levels.length).toBeGreaterThan(0);
    expect(levels.every((c) => Number(c[0]) <= 1)).toBe(true);
  });

  it('keeps the master gain low', () => {
    const { ctx } = fakeContext();
    const voice = createPreviewVoice({ createContext: () => ctx });
    voice.play(0, 0);
    const master = ctx.createGain.mock.results[0]!.value;
    expect(master.gain.value).toBe(PREVIEW_VOLUME);
    expect(PREVIEW_VOLUME).toBeLessThanOrEqual(0.25);
  });

  it('reuses one context and resumes a suspended one', () => {
    const { ctx } = fakeContext('suspended');
    const create = vi.fn(() => ctx);
    const voice = createPreviewVoice({ createContext: create });
    voice.play(5, 3);
    voice.play(5, 5);
    expect(create).toHaveBeenCalledTimes(1);
    expect(ctx.resume).toHaveBeenCalled();
  });

  it('never throws: no WebAudio returns false and warns once', () => {
    const warn = vi.fn();
    const voice = createPreviewVoice({
      createContext: () => {
        throw new Error('no AudioContext');
      },
      warn,
    });
    expect(voice.play(0, 0)).toBe(false);
    expect(voice.play(1, 0)).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('rejects an invalid note without throwing', () => {
    const warn = vi.fn();
    const voice = createPreviewVoice({ createContext: () => fakeContext().ctx, warn });
    expect(voice.play(0, 99)).toBe(false);
    expect(warn).toHaveBeenCalled();
  });

  it('dispose closes the context and later plays are refused', () => {
    const { ctx } = fakeContext();
    const voice = createPreviewVoice({ createContext: () => ctx });
    voice.play(0, 0);
    voice.dispose();
    expect(ctx.close).toHaveBeenCalled();
    expect(voice.play(0, 0)).toBe(false);
  });
});
