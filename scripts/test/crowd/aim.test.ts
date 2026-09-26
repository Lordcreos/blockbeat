import { describe, expect, it } from 'vitest';
import { STEPS, stepForBlock } from '@blockbeat/shared';
import { createLead, LEAD_WINDOW, MAX_LEAD_BLOCKS, noteTargetBlock, playStartBlock } from '../../src/lib/crowd/aim';

describe('crowd aim (W19): target block for a planned (bar, step), and the adaptive lead', () => {
  it('bar 0 starts on the first loop boundary after the head; a note targets its step in its bar', () => {
    const start = 1000n;
    expect(playStartBlock(start, 1000n)).toBe(1016n);
    expect(playStartBlock(start, 1015n)).toBe(1016n);
    expect(playStartBlock(start, 1016n)).toBe(1032n);
    const play = playStartBlock(start, 1003n);
    for (let bar = 0; bar < 3; bar++) {
      for (let step = 0; step < STEPS; step++) {
        const t = noteTargetBlock(play, bar, step);
        expect(stepForBlock(start, t)).toBe(step);
        expect(t).toBe(play + BigInt(bar * STEPS + step));
      }
    }
  });

  it('the lead is the mean inclusion delay of the last landings, clamped', () => {
    const lead = createLead(1.5);
    expect(lead.mean()).toBe(1.5);
    lead.record(1);
    lead.record(2);
    expect(lead.mean()).toBe(1.5);
    for (let i = 0; i < LEAD_WINDOW; i++) lead.record(0.5);
    expect(lead.mean()).toBe(0.5);
    lead.record(Number.NaN);
    expect(lead.mean()).toBe(0.5);
    for (let i = 0; i < LEAD_WINDOW; i++) lead.record(100);
    expect(lead.mean()).toBe(MAX_LEAD_BLOCKS);
  });
});
