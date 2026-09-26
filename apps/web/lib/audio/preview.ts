/**
 * W16: the phone's preview voice. A few native WebAudio nodes per note (no Tone.js, so the
 * phone bundle and CPU stay small), shaped from the same NoteVariant the stage kit renders,
 * at a low master volume. It is a sketch of the stage sound, not the sound itself: the stage
 * engine (engine.ts, kit.ts) is untouched.
 *
 * The AudioContext is created on the first play(), which the phone only calls from a tap, so
 * the browser's autoplay rule is met. play() never throws: a missing or broken WebAudio is
 * warned about once and the tap goes on to send.
 */
import type { TrackId } from '@blockbeat/shared';
import { PAD_CHORDS, assertTrackNote, noteVariant, type NoteVariant } from './kitSpec';

/** Master gain of the preview: quiet enough to sit under the room's PA. */
export const PREVIEW_VOLUME = 0.18;

interface ParamLike {
  value: number;
  setValueAtTime(value: number, time: number): unknown;
  linearRampToValueAtTime(value: number, time: number): unknown;
  exponentialRampToValueAtTime(value: number, time: number): unknown;
}
interface NodeLike {
  connect(destination: never): unknown;
  disconnect(): void;
}
interface OscLike extends NodeLike {
  type: OscillatorType;
  frequency: ParamLike;
  start(when: number): void;
  stop(when: number): void;
}
interface GainLike extends NodeLike {
  gain: ParamLike;
}
interface FilterLike extends NodeLike {
  type: BiquadFilterType;
  frequency: ParamLike;
  Q: ParamLike;
}
interface BufferLike {
  getChannelData(channel: number): Float32Array;
}
interface BufferSourceLike extends NodeLike {
  buffer: BufferLike | null;
  start(when: number): void;
  stop(when: number): void;
}

/** The WebAudio subset used here; a real AudioContext satisfies it. */
export interface PreviewContext {
  readonly currentTime: number;
  readonly sampleRate: number;
  readonly state: AudioContextState;
  readonly destination: NodeLike;
  resume(): Promise<void>;
  close(): Promise<void>;
  createOscillator(): OscLike;
  createGain(): GainLike;
  createBiquadFilter(): FilterLike;
  createBuffer(channels: number, length: number, sampleRate: number): BufferLike;
  createBufferSource(): BufferSourceLike;
}

export interface PreviewVoice {
  /** Plays one note now. False when it could not (no WebAudio, bad note, disposed). */
  play(track: TrackId, note: number): boolean;
  dispose(): void;
}

export interface PreviewVoiceOptions {
  createContext?: () => PreviewContext;
  warn?: (message: string) => void;
}

function defaultContext(): PreviewContext {
  const Ctor = globalThis.AudioContext;
  if (typeof Ctor !== 'function') throw new Error('WebAudio is not available');
  return new Ctor({ latencyHint: 'interactive' });
}

/**
 * NodeLike.connect takes `never` so both the real AudioNode.connect overloads and the test
 * fakes satisfy it; this one cast is where a node is actually wired to another.
 */
const connect = (from: NodeLike, to: NodeLike): void => {
  (from.connect as (d: NodeLike) => unknown)(to);
};

export function createPreviewVoice(options: PreviewVoiceOptions = {}): PreviewVoice {
  const createContext = options.createContext ?? defaultContext;
  const warn = options.warn ?? ((m: string) => console.warn(m));
  let ctx: PreviewContext | null = null;
  let master: GainLike | null = null;
  let noise: BufferLike | null = null;
  let broken = false;
  let disposed = false;

  function ensure(): { ctx: PreviewContext; master: GainLike } | null {
    if (disposed || broken) return null;
    if (!ctx || !master) {
      try {
        ctx = createContext();
      } catch (error) {
        broken = true;
        warn(`preview sound off: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      }
      master = ctx.createGain();
      master.gain.value = PREVIEW_VOLUME;
      connect(master, ctx.destination);
    }
    if (ctx.state === 'suspended') {
      ctx.resume().catch((error: unknown) => warn(`preview sound: resume failed (${error instanceof Error ? error.message : String(error)})`));
    }
    return { ctx, master };
  }

  function noiseBuffer(c: PreviewContext): BufferLike {
    if (!noise) {
      noise = c.createBuffer(1, Math.floor(c.sampleRate * 0.5), c.sampleRate);
      const data = noise.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    }
    return noise;
  }

  /** A gain envelope: fast attack to `peak`, exponential decay over `decay` seconds. */
  function envelope(c: PreviewContext, out: NodeLike, at: number, peak: number, decay: number, attack = 0.003): GainLike {
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.linearRampToValueAtTime(peak, at + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, at + attack + decay);
    connect(g, out);
    return g;
  }

  function osc(c: PreviewContext, type: OscillatorType, hz: number, into: NodeLike, at: number, length: number): OscLike {
    const o = c.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(hz, at);
    connect(o, into);
    o.start(at);
    o.stop(at + length + 0.05);
    return o;
  }

  function noiseBurst(c: PreviewContext, into: NodeLike, at: number, length: number): void {
    const src = c.createBufferSource();
    src.buffer = noiseBuffer(c);
    connect(src, into);
    src.start(at);
    src.stop(at + Math.min(0.5, length + 0.05));
  }

  function filter(c: PreviewContext, type: BiquadFilterType, hz: number, into: NodeLike, q = 0.8): FilterLike {
    const f = c.createBiquadFilter();
    f.type = type;
    f.frequency.value = hz;
    f.Q.value = q;
    connect(f, into);
    return f;
  }

  function render(track: TrackId, v: NoteVariant, c: PreviewContext, out: NodeLike): void {
    const at = c.currentTime;
    switch (track) {
      case 0: {
        const o = osc(c, 'sine', v.pitchHz * 4, envelope(c, out, at, 1, v.decaySec * 2), at, v.decaySec * 2);
        o.frequency.exponentialRampToValueAtTime(v.pitchHz, at + 0.04 + v.timbre * 0.01);
        return;
      }
      case 1: {
        noiseBurst(c, filter(c, 'highpass', v.timbre % 2 === 0 ? 1800 : 900, envelope(c, out, at, 0.7, v.decaySec)), at, v.decaySec);
        osc(c, 'triangle', v.pitchHz * 2, envelope(c, out, at, 0.5, 0.05), at, 0.06);
        return;
      }
      case 2:
        noiseBurst(c, filter(c, 'highpass', 6000 + v.pitchHz * 4, envelope(c, out, at, 0.6, v.decaySec)), at, v.decaySec);
        return;
      case 3:
        noiseBurst(c, filter(c, 'bandpass', v.pitchHz, envelope(c, out, at, 0.9, v.decaySec), 1.2), at, v.decaySec);
        return;
      case 4:
        osc(c, 'sawtooth', v.pitchHz, filter(c, 'lowpass', v.timbre === 0 ? 400 : 1400, envelope(c, out, at, 0.8, v.decaySec * 1.5), 4), at, v.decaySec * 1.5);
        return;
      case 5:
        osc(c, v.timbre === 0 ? 'square' : 'sawtooth', v.pitchHz, filter(c, 'lowpass', 3000, envelope(c, out, at, 0.35, v.decaySec * 2)), at, v.decaySec * 2);
        return;
      case 6: {
        const chord = PAD_CHORDS[v.timbre] ?? PAD_CHORDS[0] ?? [0];
        const env = envelope(c, out, at, 0.3, 0.8, 0.04);
        for (const semi of chord) osc(c, 'triangle', v.pitchHz * 2 ** (semi / 12), env, at, 0.85);
        return;
      }
      case 7: {
        const length = Math.min(0.8, v.decaySec);
        const o = osc(c, 'sine', v.timbre === 0 ? v.pitchHz : v.pitchHz * 6, envelope(c, out, at, 0.5, length), at, length);
        o.frequency.exponentialRampToValueAtTime(v.timbre === 0 ? v.pitchHz * 8 : v.pitchHz, at + length);
        return;
      }
    }
  }

  return {
    play(track, note) {
      let variant: NoteVariant;
      try {
        assertTrackNote(track, note);
        variant = noteVariant(track, note);
      } catch (error) {
        warn(`preview sound: ${error instanceof Error ? error.message : String(error)}`);
        return false;
      }
      const audio = ensure();
      if (!audio) return false;
      try {
        render(track, variant, audio.ctx, audio.master);
        return true;
      } catch (error) {
        warn(`preview sound: ${error instanceof Error ? error.message : String(error)}`);
        return false;
      }
    },
    dispose() {
      disposed = true;
      const c = ctx;
      ctx = null;
      master = null;
      c?.close().catch((error: unknown) => warn(`preview sound: close failed (${error instanceof Error ? error.message : String(error)})`));
    },
  };
}
