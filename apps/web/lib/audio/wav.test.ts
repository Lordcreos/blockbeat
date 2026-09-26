import { describe, expect, it } from 'vitest';
import { encodeWav16 } from './wav';

function u32(bytes: Uint8Array, at: number): number {
  return (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8) | ((bytes[at + 2] ?? 0) << 16) | (((bytes[at + 3] ?? 0) << 24) >>> 0);
}
function u16(bytes: Uint8Array, at: number): number {
  return (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8);
}
function ascii(bytes: Uint8Array, at: number, len: number): string {
  return String.fromCharCode(...bytes.slice(at, at + len));
}

describe('encodeWav16', () => {
  it('writes a canonical 44-byte PCM header for stereo 44.1 kHz', () => {
    const left = new Float32Array([0, 0.5, -0.5, 1]);
    const right = new Float32Array([0, -0.5, 0.5, -1]);
    const wav = encodeWav16([left, right], 44100);
    expect(wav.byteLength).toBe(44 + 4 * 2 * 2);
    expect(ascii(wav, 0, 4)).toBe('RIFF');
    expect(u32(wav, 4)).toBe(wav.byteLength - 8);
    expect(ascii(wav, 8, 4)).toBe('WAVE');
    expect(ascii(wav, 12, 4)).toBe('fmt ');
    expect(u16(wav, 20)).toBe(1); // PCM
    expect(u16(wav, 22)).toBe(2); // channels
    expect(u32(wav, 24)).toBe(44100);
    expect(u32(wav, 28)).toBe(44100 * 2 * 2); // byte rate
    expect(u16(wav, 32)).toBe(4); // block align
    expect(u16(wav, 34)).toBe(16); // bits
    expect(ascii(wav, 36, 4)).toBe('data');
    expect(u32(wav, 40)).toBe(16);
  });

  it('interleaves channels and clamps samples to 16-bit range', () => {
    const wav = encodeWav16([new Float32Array([1.5, -2]), new Float32Array([0.5, 0])], 8000);
    const view = new DataView(wav.buffer, wav.byteOffset);
    expect(view.getInt16(44, true)).toBe(32767);
    expect(view.getInt16(46, true)).toBe(Math.round(0.5 * 32767));
    expect(view.getInt16(48, true)).toBe(-32768);
    expect(view.getInt16(50, true)).toBe(0);
  });

  it('rejects mismatched channel lengths and empty input', () => {
    expect(() => encodeWav16([new Float32Array(2), new Float32Array(3)], 8000)).toThrow(RangeError);
    expect(() => encodeWav16([], 8000)).toThrow(RangeError);
  });
});
