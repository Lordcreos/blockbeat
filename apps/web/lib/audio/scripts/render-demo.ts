/**
 * Renders an 8-second techno demo of the kit with Tone.Offline and writes a 16-bit WAV.
 * TEST/SCRIPT ONLY: pulls in the Node WebAudio polyfill. Run from apps/web with:
 *
 *   node ../../node_modules/.pnpm/node_modules/vite-node/vite-node.mjs lib/audio/scripts/render-demo.ts [out.wav]
 */
import '../testing/install-node-web-audio';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { emptyPattern, toggle, type TrackId } from '@blockbeat/shared';
import { renderPattern } from '../render';
import { peak, rms } from '../testing/analysis';
import { encodeWav16 } from '../wav';

const SECONDS = 8;
const SAMPLE_RATE = 44100;

/** [step, track, note]. One step is one 300 ms Monad block, so a bar is 4.8 s. */
const DEMO_HITS: ReadonlyArray<readonly [number, TrackId, number]> = [
  // kick: four on the floor, note 10 = A1 with a slightly longer decay
  [0, 0, 10], [2, 0, 10], [4, 0, 10], [6, 0, 10], [8, 0, 10], [10, 0, 10], [12, 0, 10], [14, 0, 10],
  // hats: closed on the off-steps, an open one before the turnaround
  [1, 2, 1], [3, 2, 1], [5, 2, 1], [7, 2, 9], [9, 2, 1], [11, 2, 1], [13, 2, 1], [15, 2, 25],
  // clap on 2 and 4, snare ghosts
  [4, 3, 11], [12, 3, 11], [11, 1, 2], [15, 1, 18],
  // acid bass line: 16 semitones from A1, +16 opens the filter
  [0, 4, 0], [1, 4, 12], [3, 4, 3], [5, 4, 0], [7, 4, 31], [9, 4, 0], [11, 4, 7], [13, 4, 16], [15, 4, 10],
  // lead stabs
  [3, 5, 7], [7, 5, 12], [11, 5, 23], [15, 5, 19],
  // pad: A minor 7 on the one, C major 7 on the nine
  [0, 6, 0], [8, 6, 11],
  // fx: riser into the turnaround, drop on the one
  [12, 7, 8], [0, 7, 4],
];

function demoPattern(): bigint[] {
  const pattern = emptyPattern();
  for (const [step, track, note] of DEMO_HITS) pattern[step] = toggle(pattern[step] ?? 0n, track, note);
  return pattern;
}

async function main(): Promise<void> {
  const outArg = process.argv[2];
  const out = outArg
    ? path.resolve(outArg)
    : fileURLToPath(new URL('../../../../../docs/evidence/w4-audio/demo.wav', import.meta.url));
  const started = Date.now();
  const buffer = await renderPattern(demoPattern(), { seconds: SECONDS, sampleRate: SAMPLE_RATE, channels: 2 });
  const renderMs = Date.now() - started;
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));
  const wav = encodeWav16(channels, SAMPLE_RATE);
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, wav);
  const left = channels[0] ?? new Float32Array();
  console.log(`wrote ${out}`);
  console.log(`bytes=${wav.byteLength} seconds=${SECONDS} sampleRate=${SAMPLE_RATE} renderMs=${renderMs}`);
  console.log(`peak=${peak(left).toFixed(3)} rms(all)=${rms(left, SAMPLE_RATE, 0, SECONDS).toFixed(3)}`);
  for (let step = 0; step < 16; step++) {
    const t = step * 0.3;
    console.log(`step ${String(step).padStart(2)} t=${t.toFixed(1)}s rms=${rms(left, SAMPLE_RATE, t, t + 0.3).toFixed(3)}`);
  }
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    console.error(err);
    process.exit(1);
  },
);
