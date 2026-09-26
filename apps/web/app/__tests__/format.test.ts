import { describe, expect, it } from 'vitest';
import { formatInt, formatLatency, measuredBpm, shortUrl, padValue } from '@/components/format';
import { trackCellCounts, isAgentHit } from '@/components/stage/grid-model';
import { emptyPattern, toggle } from '@blockbeat/shared';

describe('measuredBpm', () => {
  it('reads 100 BPM at the nominal 300 ms cadence (beat = 2 blocks)', () => {
    expect(measuredBpm(300)).toBe(100);
  });
  it('rounds and tolerates jitter', () => {
    expect(measuredBpm(310)).toBe(97);
    expect(measuredBpm(290)).toBe(103);
  });
  it('returns 0 for a non-positive interval', () => {
    expect(measuredBpm(0)).toBe(0);
    expect(measuredBpm(-5)).toBe(0);
  });
});

describe('formatInt', () => {
  it('groups thousands with a comma for numbers and bigints', () => {
    expect(formatInt(12345)).toBe('12,345');
    expect(formatInt(1234567n)).toBe('1,234,567');
    expect(formatInt(0)).toBe('0');
  });
});

describe('formatLatency', () => {
  it('shows a dash while unknown', () => {
    expect(formatLatency(null)).toBe('—');
  });
  it('rounds to whole milliseconds', () => {
    expect(formatLatency(411.6)).toBe('412 ms');
  });
});

describe('padValue', () => {
  it('pads to a fixed width so HUD numbers never shift', () => {
    expect(padValue('12', 5)).toBe('   12');
    expect(padValue('123456', 5)).toBe('123456');
  });
});

describe('shortUrl', () => {
  it('strips the protocol and trailing slash', () => {
    expect(shortUrl('https://beat.example/join/7/')).toBe('beat.example/join/7');
    expect(shortUrl('http://localhost:3000/join/1')).toBe('localhost:3000/join/1');
  });
});

describe('trackCellCounts', () => {
  it('maps a pattern to per-step, per-track note counts', () => {
    const p = emptyPattern();
    p[3] = toggle(toggle(p[3]!, 0, 0), 0, 5); // kick, two notes on step 3
    p[7] = toggle(p[7]!, 4, 1); // bass on step 7
    const cells = trackCellCounts(p);
    expect(cells).toHaveLength(16);
    expect(cells[3]).toEqual([2, 0, 0, 0, 0, 0, 0, 0]);
    expect(cells[7]).toEqual([0, 0, 0, 0, 1, 0, 0, 0]);
    expect(cells[0]).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });
});

describe('isAgentHit', () => {
  it('is case-insensitive and false without an agent address', () => {
    expect(isAgentHit('0xABCDEF0000000000000000000000000000000001', '0xabcdef0000000000000000000000000000000001')).toBe(true);
    expect(isAgentHit('0xabcdef0000000000000000000000000000000001', '0xabcdef0000000000000000000000000000000002')).toBe(false);
    expect(isAgentHit('0xabcdef0000000000000000000000000000000001', undefined)).toBe(false);
    expect(isAgentHit('0xabcdef0000000000000000000000000000000001', '')).toBe(false);
  });
});
