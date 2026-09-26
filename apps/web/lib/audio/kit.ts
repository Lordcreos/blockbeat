/**
 * The synthesized Blockbeat kit: eight Tone.js voices in TRACK_META order. No samples.
 * Each voice reads a NoteVariant (see kitSpec.ts) so the note byte picks pitch, decay or timbre.
 */
import type { TrackId } from '@blockbeat/shared';
import * as Tone from 'tone';
import { KIT_KEYS, PAD_CHORDS, assertTrackNote, midiToHz, noteVariant, type KitKey, type NoteVariant } from './kitSpec';

export interface Kit {
  /** Always eight. */
  readonly size: number;
  readonly keys: readonly KitKey[];
  /** Resolves once every voice can sound (the reverbs render their impulse asynchronously). */
  readonly ready: Promise<void>;
  /** Schedule one note on one track at an absolute audio-context time. */
  trigger(track: TrackId, note: number, atAudioTime: number): void;
  /** Connect the kit bus to a destination (normally the master chain input). */
  connect(target: Tone.InputNode): void;
  dispose(): void;
}

interface Voice {
  readonly key: KitKey;
  readonly output: Tone.ToneAudioNode;
  readonly ready?: Promise<void>;
  /** Every node the voice created, disposed with the kit. */
  readonly nodes: readonly Tone.ToneAudioNode[];
  trigger(variant: NoteVariant, time: number): void;
}

/** Per-voice trim in dB, tuned so a full 8-track step sits under the limiter with headroom. */
export const VOICE_TRIM_DB: Readonly<Record<KitKey, number>> = {
  kick: 8,
  snare: -9,
  hat: -21,
  clap: 2,
  bass: 4,
  lead: -10,
  pad: -17,
  fx: -8,
};

const VOICE_BUILDERS: Readonly<Record<KitKey, () => Voice>> = {
  kick: buildKick,
  snare: buildSnare,
  hat: buildHat,
  clap: buildClap,
  bass: buildBass,
  lead: buildLead,
  pad: buildPad,
  fx: buildFx,
};

/**
 * Tone's monophonic sources refuse a start at or before their previous start time. Two notes on
 * one track in the same step, or an immediate hit arriving behind a step already scheduled ahead,
 * are therefore spread by this much (a flam, inaudible as a delay at 300 ms per step).
 */
export const MIN_RETRIGGER_SEC = 0.01;
/** At most this many flams per track; further hits piling onto the same instant are dropped. */
export const MAX_RETRIGGER_SPREAD_SEC = MIN_RETRIGGER_SEC * 5;

export function createKit(): Kit {
  const bus = new Tone.Gain(1);
  const voices: Voice[] = [];
  const trims: Tone.Volume[] = [];
  const lastTriggerAt: number[] = KIT_KEYS.map(() => Number.NEGATIVE_INFINITY);
  const warned: boolean[] = KIT_KEYS.map(() => false);
  for (const key of KIT_KEYS) {
    const voice = VOICE_BUILDERS[key]();
    const trim = new Tone.Volume(VOICE_TRIM_DB[key]);
    voice.output.connect(trim);
    trim.connect(bus);
    voices.push(voice);
    trims.push(trim);
  }
  return {
    size: voices.length,
    keys: voices.map((v) => v.key),
    ready: Promise.all(voices.map((v) => v.ready ?? Promise.resolve())).then(() => undefined),
    trigger(track, note, atAudioTime) {
      assertTrackNote(track, note);
      const voice = voices[track];
      if (!voice || !Number.isFinite(atAudioTime)) return;
      const at = Math.max(atAudioTime, (lastTriggerAt[track] ?? Number.NEGATIVE_INFINITY) + MIN_RETRIGGER_SEC);
      if (at - atAudioTime > MAX_RETRIGGER_SPREAD_SEC) return;
      lastTriggerAt[track] = at;
      try {
        voice.trigger(noteVariant(track, note), at);
      } catch (err) {
        // A single bad hit must never take the whole step (or the clock callback) down.
        if (!warned[track]) {
          warned[track] = true;
          console.warn(`[blockbeat/audio] dropped hit on ${voice.key}:`, err);
        }
      }
    },
    connect(target) {
      bus.connect(target);
    },
    dispose() {
      for (const voice of voices) for (const node of voice.nodes) node.dispose();
      for (const trim of trims) trim.dispose();
      bus.dispose();
    },
  };
}

// ------------------------------------------------------------------ drums

function buildKick(): Voice {
  const synth = new Tone.MembraneSynth({
    pitchDecay: 0.025,
    octaves: 5,
    oscillator: { type: 'sine' },
    envelope: { attack: 0.001, decay: 0.06, sustain: 0, release: 0.01 },
  });
  const drive = new Tone.Distortion(0.08);
  synth.connect(drive);
  return {
    key: 'kick',
    output: drive,
    nodes: [synth, drive],
    trigger(v, time) {
      synth.envelope.decay = v.decaySec;
      synth.pitchDecay = 0.02 + v.timbre * 0.008;
      synth.triggerAttackRelease(v.pitchHz, v.decaySec * 0.6, time);
    },
  };
}

function buildSnare(): Voice {
  const white = new Tone.NoiseSynth({ noise: { type: 'white' }, envelope: { attack: 0.001, decay: 0.12, sustain: 0, release: 0.02 } });
  const pink = new Tone.NoiseSynth({ noise: { type: 'pink' }, envelope: { attack: 0.001, decay: 0.12, sustain: 0, release: 0.02 } });
  const body = new Tone.MembraneSynth({
    pitchDecay: 0.015,
    octaves: 2,
    oscillator: { type: 'triangle' },
    envelope: { attack: 0.001, decay: 0.07, sustain: 0, release: 0.01 },
  });
  const noiseFilter = new Tone.Filter(1400, 'highpass');
  const out = new Tone.Gain(1);
  white.connect(noiseFilter);
  pink.connect(noiseFilter);
  noiseFilter.connect(out);
  body.connect(out);
  return {
    key: 'snare',
    output: out,
    nodes: [white, pink, body, noiseFilter, out],
    trigger(v, time) {
      const noise = v.timbre % 2 === 0 ? white : pink;
      noise.envelope.decay = v.decaySec;
      noise.triggerAttackRelease(v.decaySec * 0.7, time);
      body.triggerAttackRelease(v.pitchHz, 0.05, time);
    },
  };
}

function buildHat(): Voice {
  const synth = new Tone.MetalSynth({
    envelope: { attack: 0.001, decay: 0.05, release: 0.01 },
    harmonicity: 5.1,
    modulationIndex: 32,
    resonance: 4000,
    octaves: 1.5,
  });
  const filter = new Tone.Filter(6000, 'highpass');
  synth.connect(filter);
  return {
    key: 'hat',
    output: filter,
    nodes: [synth, filter],
    trigger(v, time) {
      synth.envelope.decay = v.decaySec;
      synth.triggerAttackRelease(v.pitchHz, v.decaySec * 0.8, time);
    },
  };
}

function buildClap(): Voice {
  const flam = new Tone.NoiseSynth({ noise: { type: 'white' }, envelope: { attack: 0.001, decay: 0.012, sustain: 0, release: 0.005 } });
  const tail = new Tone.NoiseSynth({ noise: { type: 'white' }, envelope: { attack: 0.001, decay: 0.1, sustain: 0, release: 0.02 } });
  const band = new Tone.Filter({ frequency: 1200, type: 'bandpass', Q: 1.2 });
  // Convolution reverb (not Freeverb/JCReverb: those need AudioWorklets, which Node lacks).
  const reverb = new Tone.Reverb({ decay: 0.5, preDelay: 0.005, wet: 1 });
  const send = new Tone.Gain(0.2);
  const out = new Tone.Gain(1);
  flam.connect(band);
  tail.connect(band);
  band.connect(out);
  band.connect(send);
  send.connect(reverb);
  reverb.connect(out);
  return {
    key: 'clap',
    output: out,
    nodes: [flam, tail, band, send, reverb, out],
    ready: reverb.ready,
    trigger(v, time) {
      band.frequency.setValueAtTime(v.pitchHz, time);
      send.gain.setValueAtTime(0.1 + v.timbre * 0.12, time);
      for (let i = 0; i < 3; i++) flam.triggerAttackRelease(0.008, time + i * 0.011);
      tail.envelope.decay = v.decaySec;
      tail.triggerAttackRelease(v.decaySec * 0.7, time + 0.03);
    },
  };
}

// ------------------------------------------------------------------ tonal

function buildBass(): Voice {
  const synth = new Tone.MonoSynth({
    oscillator: { type: 'sawtooth' },
    envelope: { attack: 0.004, decay: 0.12, sustain: 0.25, release: 0.05 },
    filterEnvelope: { attack: 0.003, decay: 0.1, sustain: 0.15, release: 0.05, baseFrequency: 110, octaves: 2.6 },
    filter: { type: 'lowpass', Q: 5, rolloff: -24 },
  });
  const drive = new Tone.Distortion(0.2);
  synth.connect(drive);
  return {
    key: 'bass',
    output: drive,
    nodes: [synth, drive],
    trigger(v, time) {
      synth.filterEnvelope.octaves = v.timbre === 0 ? 2.6 : 4.2;
      synth.triggerAttackRelease(v.pitchHz, v.decaySec, time);
    },
  };
}

function buildLead(): Voice {
  const square = new Tone.Synth({ oscillator: { type: 'square' }, envelope: { attack: 0.002, decay: 0.1, sustain: 0.15, release: 0.08 } });
  const saw = new Tone.Synth({ oscillator: { type: 'sawtooth' }, envelope: { attack: 0.002, decay: 0.1, sustain: 0.15, release: 0.08 } });
  const tone = new Tone.Filter(3800, 'lowpass');
  const echo = new Tone.FeedbackDelay({ delayTime: 0.15, feedback: 0.28, wet: 0.25 });
  square.connect(tone);
  saw.connect(tone);
  tone.connect(echo);
  return {
    key: 'lead',
    output: echo,
    nodes: [square, saw, tone, echo],
    trigger(v, time) {
      (v.timbre === 0 ? square : saw).triggerAttackRelease(v.pitchHz, v.decaySec, time);
    },
  };
}

function buildPad(): Voice {
  const poly = new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: 'triangle' },
    envelope: { attack: 0.06, decay: 0.3, sustain: 0.6, release: 0.35 },
  });
  poly.maxPolyphony = 16;
  const tone = new Tone.Filter(1800, 'lowpass');
  const space = new Tone.Reverb({ decay: 1.2, preDelay: 0.01, wet: 0.3 });
  poly.connect(tone);
  tone.connect(space);
  return {
    key: 'pad',
    output: space,
    nodes: [poly, tone, space],
    ready: space.ready,
    trigger(v, time) {
      const rootMidi = 69 + 12 * Math.log2(v.pitchHz / 440);
      const intervals = PAD_CHORDS[v.timbre] ?? PAD_CHORDS[0] ?? [0];
      poly.triggerAttackRelease(
        intervals.map((i) => midiToHz(rootMidi + i)),
        v.decaySec,
        time,
      );
    },
  };
}

function buildFx(): Voice {
  const noise = new Tone.NoiseSynth({ noise: { type: 'pink' }, envelope: { attack: 0.2, decay: 0.08, sustain: 0, release: 0.05 } });
  const sweep = new Tone.Filter({ frequency: 400, type: 'bandpass', Q: 1.5 });
  // The narrow band throws away most of the noise energy; make it up here.
  const noiseGain = new Tone.Gain(4);
  const zap = new Tone.Synth({ oscillator: { type: 'sine' }, envelope: { attack: 0.002, decay: 0.15, sustain: 0.1, release: 0.05 } });
  const out = new Tone.Gain(1);
  noise.connect(sweep);
  sweep.connect(noiseGain);
  noiseGain.connect(out);
  zap.connect(out);
  return {
    key: 'fx',
    output: out,
    nodes: [noise, sweep, noiseGain, zap, out],
    trigger(v, time) {
      const end = time + v.decaySec;
      if (v.timbre === 0) {
        // riser: swelling noise with the band sweeping up
        noise.envelope.attack = v.decaySec * 0.85;
        noise.triggerAttackRelease(v.decaySec * 0.9, time);
        sweep.frequency.setValueAtTime(v.pitchHz, time);
        sweep.frequency.exponentialRampToValueAtTime(v.pitchHz * 12, end);
      } else {
        // drop: a zap falling to the pitch, plus a short noise sweep down
        zap.triggerAttackRelease(v.pitchHz * 6, v.decaySec, time);
        zap.frequency.exponentialRampToValueAtTime(v.pitchHz, end);
        noise.envelope.attack = 0.005;
        noise.triggerAttackRelease(v.decaySec * 0.5, time);
        sweep.frequency.setValueAtTime(v.pitchHz * 12, time);
        sweep.frequency.exponentialRampToValueAtTime(v.pitchHz, end);
      }
    },
  };
}
