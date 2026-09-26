import { describe, expect, it } from 'vitest';
import { landingText } from './landing-line';

const receipt = { txHash: '0xabc' as const, blockNumber: 12345n, step: 7, on: true, latencyMs: 412.4 };

describe('landingText', () => {
  it('formats a landed hit with a grouped block number and rounded latency', () => {
    expect(landingText({ kind: 'landed', receipt })).toBe('landed · block 12,345 · step 7 · 412 ms');
  });
  it('W13: says landed for every hit, the on=false refresh included (every tap sounds)', () => {
    expect(landingText({ kind: 'landed', receipt: { ...receipt, on: false } })).toBe('landed · block 12,345 · step 7 · 412 ms');
  });
  it('tells the player what to do when a hit fails', () => {
    expect(landingText({ kind: 'failed', message: 'timeout' })).toBe('did not land · timeout · tap again');
  });
  it('W16: an aimed note says where it was aimed and where it landed, with the block and latency', () => {
    expect(landingText({ kind: 'aimed', text: 'aimed step 7 · landed step 8 (one late)', blockNumber: 12345n, latencyMs: 380.2 })).toBe(
      'aimed step 7 · landed step 8 (one late) · block 12,345 · 380 ms',
    );
  });
  it('W16: a notice is shown as it is', () => {
    expect(landingText({ kind: 'notice', message: '4 notes aimed · wait for one to land' })).toBe('4 notes aimed · wait for one to land');
  });
  it('W16: the idle hint depends on the mode', () => {
    expect(landingText({ kind: 'idle' }, 'aim')).toBe('Pick a sound, then tap a step. The chain confirms where it lands.');
    expect(landingText({ kind: 'idle' }, 'now')).toBe('Tap a pad. Your note lands on the next block.');
  });
  it('has a hint before the first tap and while sending', () => {
    expect(landingText({ kind: 'idle' })).toBe('Tap a pad. Your note lands on the next block.');
    expect(landingText({ kind: 'sending' })).toBe('sending…');
  });
});
