/**
 * W17 evidence: render 16 bars of the rules DJ (empty room) to a WAV so a human can hear the
 * phrases, and write the arrangement table. The audio comes from the stage's own kit and master
 * chain: apps/web/lib/audio's offline helpers, imported read-only (apps/web is not edited).
 *
 *   pnpm --filter agent exec tsx scripts/render-phrases.ts [--bars 16] [--rate 32000] [--channels 1] [--out ../../docs/evidence/w17-dj-phrases]
 *
 * Mono 32 kHz by default so the 77 s evidence file stays near 5 MB in git (the hats stay intact up to 16 kHz).
 *
 * One step is one 300 ms block, so 16 bars are 76.8 s. Each step plays the notes the shared live
 * layer holds at that step's block, which is exactly what the stage schedules.
 */
import '../../web/lib/audio/testing/install-node-web-audio';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BLOCK_MS, STEPS } from '@blockbeat/shared';
import { renderTriggers, type Trigger } from '../../web/lib/audio/render';
import { peak, rms } from '../../web/lib/audio/testing/analysis';
import { encodeWav16 } from '../../web/lib/audio/wav';
import { arrangementTable, simulateSet } from './phrase-sim';

const STEP_SEC = BLOCK_MS / 1000;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const bars = Number(arg('--bars') ?? '16');
  const sampleRate = Number(arg('--rate') ?? '32000');
  const channelCount = Number(arg('--channels') ?? '1');
  const outDir = path.resolve(arg('--out') ?? path.join(import.meta.dirname, '../../../docs/evidence/w17-dj-phrases'));
  const sim = await simulateSet(bars);
  const triggers: Trigger[] = [];
  sim.forEach((b) => b.sounding.forEach((cells, step) => cells.forEach((c) => triggers.push({ track: c.track, note: c.note, at: (b.bar * STEPS + step) * STEP_SEC }))));
  const seconds = bars * STEPS * STEP_SEC + 1.5; // a short tail for the pad and the reverb
  const started = Date.now();
  const buffer = await renderTriggers(triggers, { seconds, sampleRate: sampleRate, channels: channelCount });
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));
  mkdirSync(outDir, { recursive: true });
  const wavPath = path.join(outDir, 'phrase-demo.wav');
  writeFileSync(wavPath, encodeWav16(channels, sampleRate));
  const left = channels[0] ?? new Float32Array();
  const barRms = sim.map((b) => Number(rms(left, sampleRate, b.bar * STEPS * STEP_SEC, (b.bar + 1) * STEPS * STEP_SEC).toFixed(4)));
  writeFileSync(path.join(outDir, 'arrangement.md'), `${arrangementTable(sim)}\n`);
  writeFileSync(path.join(outDir, 'arrangement.json'), `${JSON.stringify({ bars, triggers: triggers.length, barRms, sim }, null, 2)}\n`);
  process.stdout.write(`wrote ${wavPath} (${seconds.toFixed(1)} s, ${triggers.length} notes, render ${Date.now() - started} ms, peak ${peak(left).toFixed(3)})\n`);
  process.stdout.write(`rms per bar: ${barRms.join(' ')}\n`);
  process.stdout.write(`${arrangementTable(sim)}\n`);
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    process.stderr.write(`render-phrases: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exit(1);
  },
);
