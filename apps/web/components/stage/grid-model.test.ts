import { describe, expect, it } from 'vitest';
import { emptyPattern, toggle, type LiveCell } from '@blockbeat/shared';
import { agentLiveCells, cellFades, cellKey, isAgentHit, noteKey, trackCellCounts } from './grid-model';

const AGENT = '0x90F79bf6EB2c4f870365E785982E1f101E93b906';

describe('isAgentHit', () => {
  it('matches the configured agent address case-insensitively', () => {
    expect(isAgentHit(AGENT, AGENT)).toBe(true);
    expect(isAgentHit(AGENT.toLowerCase(), AGENT)).toBe(true);
    expect(isAgentHit(AGENT, AGENT.toLowerCase())).toBe(true);
  });

  it('is false for other players and when no agent address is configured', () => {
    expect(isAgentHit('0x70997970C51812dc3A010C7d01b50e0d17dc79C8', AGENT)).toBe(false);
    expect(isAgentHit(AGENT, undefined)).toBe(false);
    expect(isAgentHit(AGENT, '')).toBe(false);
  });
});

describe('trackCellCounts', () => {
  it('counts notes per step and track from the pattern words', () => {
    const p = emptyPattern();
    p[3] = toggle(toggle(p[3] ?? 0n, 2, 0), 2, 5);
    p[3] = toggle(p[3] ?? 0n, 7, 31);
    const cells = trackCellCounts(p);
    expect(cells).toHaveLength(16);
    expect(cells[3]?.[2]).toBe(2);
    expect(cells[3]?.[7]).toBe(1);
    expect(cells[3]?.[0]).toBe(0);
    expect(cells[4]?.[2]).toBe(0);
  });
});

describe('keys', () => {
  it('are stable strings', () => {
    expect(cellKey(3, 2)).toBe('3:2');
    expect(noteKey(3, 2, 5)).toBe('3:2:5');
  });
});

describe('cellFades (W13)', () => {
  const base = { lastBlock: 0n, ageBlocks: 0, player: AGENT as `0x${string}`, hits: 1 } as const;

  it('gives each step × track the brightness of its longest-living note', () => {
    const { fade } = cellFades(
      {
        decay: true,
        cells: [
          { ...base, step: 2, track: 1, note: 0, remainingBlocks: 8 },
          { ...base, step: 2, track: 1, note: 4, remainingBlocks: 16 },
          { ...base, step: 5, track: 0, note: 0, remainingBlocks: 100 },
        ],
        evicted: [],
      },
      8,
      false,
    );
    expect(fade[2]?.[1]).toBe(0.5);
    expect(fade[5]?.[0]).toBe(1);
    expect(fade[0]?.[0]).toBe(0);
  });

  it('steps per bar with reduced motion', () => {
    const { fade } = cellFades({ decay: true, cells: [{ ...base, step: 0, track: 0, note: 0, remainingBlocks: 20 }], evicted: [] }, 8, true);
    expect(fade[0]?.[0]).toBe(1);
  });

  it('is 1 everywhere a note is on when decay is off', () => {
    const { fade } = cellFades({ decay: false, cells: [{ ...base, step: 1, track: 1, note: 0, remainingBlocks: Number.POSITIVE_INFINITY }], evicted: [] }, 0, false);
    expect(fade[1]?.[1]).toBe(1);
  });

  it('draws an evicted note as a fading ghost only where nothing live remains', () => {
    const { ghost } = cellFades(
      {
        decay: true,
        cells: [{ ...base, step: 3, track: 2, note: 1, remainingBlocks: 60 }],
        evicted: [
          { step: 3, track: 2, note: 0, evictedAt: 0n, sinceBlocks: 0, player: AGENT as `0x${string}` },
          { step: 4, track: 2, note: 0, evictedAt: 0n, sinceBlocks: 16, player: AGENT as `0x${string}` },
        ],
      },
      8,
      false,
    );
    expect(ghost[3]?.[2]).toBe(0);
    expect(ghost[4]?.[2]).toBe(0.25);
  });
});

describe('agentLiveCells (W13)', () => {
  it('marks the step × track cells whose live note the agent hit last', () => {
    const cells: LiveCell[] = [
      { step: 1, track: 2, note: 0, lastBlock: 0n, ageBlocks: 0, remainingBlocks: 9, player: AGENT as `0x${string}`, hits: 1 },
      { step: 4, track: 3, note: 0, lastBlock: 0n, ageBlocks: 0, remainingBlocks: 9, player: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as `0x${string}`, hits: 1 },
    ];
    expect([...agentLiveCells(cells, AGENT.toLowerCase())]).toEqual(['1:2']);
    expect(agentLiveCells(cells, undefined).size).toBe(0);
  });
});
