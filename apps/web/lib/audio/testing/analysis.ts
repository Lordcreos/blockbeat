/** Test/evidence helpers for inspecting rendered audio. Not used at runtime. */
export function rms(channel: Float32Array, sampleRate: number, fromSec: number, toSec: number): number {
  const from = Math.max(0, Math.floor(fromSec * sampleRate));
  const to = Math.min(channel.length, Math.floor(toSec * sampleRate));
  if (to <= from) return 0;
  let sum = 0;
  for (let i = from; i < to; i++) {
    const s = channel[i] ?? 0;
    sum += s * s;
  }
  return Math.sqrt(sum / (to - from));
}

export function peak(channel: Float32Array): number {
  let p = 0;
  for (let i = 0; i < channel.length; i++) p = Math.max(p, Math.abs(channel[i] ?? 0));
  return p;
}
