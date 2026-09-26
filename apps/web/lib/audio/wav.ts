/** Minimal 16-bit PCM WAV encoder, used by the demo render script and evidence tooling. */
export function encodeWav16(channels: readonly Float32Array[], sampleRate: number): Uint8Array {
  const first = channels[0];
  if (!first) throw new RangeError('encodeWav16 needs at least one channel');
  const frames = first.length;
  if (channels.some((c) => c.length !== frames)) throw new RangeError('all channels must have the same length');
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) throw new RangeError(`invalid sample rate ${sampleRate}`);

  const numChannels = channels.length;
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const dataBytes = frames * blockAlign;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);

  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataBytes, true);

  let offset = 44;
  for (let i = 0; i < frames; i++) {
    for (const channel of channels) {
      const s = Math.max(-1, Math.min(1, channel[i] ?? 0));
      view.setInt16(offset, s < 0 ? Math.round(s * 32768) : Math.round(s * 32767), true);
      offset += 2;
    }
  }
  return new Uint8Array(buffer);
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}
