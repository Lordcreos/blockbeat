import { describe, expect, it } from 'vitest';
import { BAR_MS, NOTE_LIFETIME_BARS, NOTES_PER_TRACK, inKeyNotesFor } from '@blockbeat/shared';
import { JOIN_WINDOW_MS, planCrowd, type CrowdPlan, type PlannedNote } from '../../src/lib/crowd/persona';

const base = { seed: 42, players: 10, bars: 38, notesPerPlayer: 14 };

function notesOf(plan: CrowdPlan, player: number): PlannedNote[] {
  return plan.notes.filter((n) => n.player === player);
}

describe('planCrowd: personas and their notes (W19)', () => {
  it('is deterministic given a seed, and a different seed gives a different room', () => {
    expect(planCrowd(base)).toEqual(planCrowd(base));
    expect(planCrowd({ ...base, seed: 43 })).not.toEqual(planCrowd(base));
  });

  it('spreads instruments over the 8 tracks with drums weighted', () => {
    const eight = planCrowd({ ...base, players: 8 });
    expect(new Set(eight.personas.map((p) => p.track)).size).toBe(8);
    const ten = planCrowd(base);
    expect(ten.personas.filter((p) => p.track <= 3).length).toBeGreaterThanOrEqual(6);
    const sixteen = planCrowd({ ...base, players: 16 });
    expect(sixteen.personas.filter((p) => p.track <= 3).length).toBeGreaterThan(8);
  });

  it('players join gradually over the first 20 s and some leave early', () => {
    const plan = planCrowd({ ...base, players: 20 });
    const joins = plan.personas.map((p) => p.joinAtMs);
    expect(Math.min(...joins)).toBe(0);
    expect(Math.max(...joins)).toBeLessThanOrEqual(JOIN_WINDOW_MS);
    expect(joins).toEqual([...joins].sort((a, b) => a - b));
    for (const p of plan.personas) expect(p.joinBar).toBe(Math.floor(p.joinAtMs / BAR_MS));
    const leavers = plan.personas.filter((p) => p.leaveBar !== null);
    expect(leavers.length).toBeGreaterThan(0);
    expect(leavers.length).toBeLessThan(plan.personas.length / 2);
    for (const p of plan.personas) {
      for (const n of notesOf(plan, p.id)) {
        expect(n.bar).toBeGreaterThanOrEqual(p.joinBar);
        expect(n.bar).toBeLessThan(p.leaveBar ?? plan.bars);
      }
    }
  });

  it('every style is present, and each plays in its own way', () => {
    const plan = planCrowd({ ...base, players: 24, notesPerPlayer: 200 });
    const styles = new Set(plan.personas.map((p) => p.style));
    expect(styles).toEqual(new Set(['steady', 'busy', 'sparse']));
    for (const p of plan.personas) {
      const notes = notesOf(plan, p.id);
      const perBar = new Map<number, number>();
      for (const n of notes) perBar.set(n.bar, (perBar.get(n.bar) ?? 0) + 1);
      if (p.style === 'busy') {
        for (const count of perBar.values()) expect(count).toBeLessThanOrEqual(4);
        expect(Math.max(...perBar.values())).toBeGreaterThanOrEqual(2);
      }
      if (p.style === 'sparse') {
        for (const count of perBar.values()) expect(count).toBe(1);
        const bars = [...perBar.keys()].sort((a, b) => a - b);
        for (let i = 1; i < bars.length; i++) expect((bars[i] ?? 0) - (bars[i - 1] ?? 0)).toBeLessThanOrEqual(2);
      }
      if (p.style === 'steady') {
        // A 1-bar pattern: every note is on a pattern step, most repeat its main note, re-laid as it fades.
        for (const n of notes) expect(p.pattern).toContain(n.step);
        const cells = new Map<string, number>();
        for (const n of notes) cells.set(`${n.step}:${n.note}`, (cells.get(`${n.step}:${n.note}`) ?? 0) + 1);
        const top = [...cells.values()].sort((a, b) => b - a).slice(0, p.pattern.length).reduce((a, b) => a + b, 0);
        expect(top / notes.length).toBeGreaterThanOrEqual(0.6);
      }
    }
  });

  it('melodic tracks play the chord of the step (A minor, Am-F-C-G); every note is in range', () => {
    const plan = planCrowd({ ...base, players: 24, notesPerPlayer: 200 });
    for (const n of plan.notes) {
      expect(n.note).toBeGreaterThanOrEqual(0);
      expect(n.note).toBeLessThan(NOTES_PER_TRACK);
      expect(n.step).toBeGreaterThanOrEqual(0);
      expect(n.step).toBeLessThan(16);
      const inKey = inKeyNotesFor(n.track, n.step);
      if (inKey !== null) expect(inKey).toContain(n.note);
    }
  });

  it('never plans a cell the same player still has alive (the live layer keeps it 8 bars)', () => {
    const plan = planCrowd({ ...base, players: 24, notesPerPlayer: 200 });
    const last = new Map<string, number>();
    for (const n of plan.notes) {
      const key = `${n.player}:${n.step}:${n.note}`;
      const prev = last.get(key);
      if (prev !== undefined) expect(n.bar - prev).toBeGreaterThanOrEqual(NOTE_LIFETIME_BARS);
      last.set(key, n.bar);
    }
  });

  it('keeps every player within its note allowance, spread over its stay', () => {
    const plan = planCrowd({ ...base, notesPerPlayer: 6 });
    for (const p of plan.personas) expect(notesOf(plan, p.id).length).toBeLessThanOrEqual(6);
    // Spread, not front-loaded: a steady or busy player still plays in the second half of its stay.
    const stayers = plan.personas.filter((p) => p.leaveBar === null && notesOf(plan, p.id).length >= 4);
    expect(stayers.length).toBeGreaterThan(0);
    for (const p of stayers) expect(notesOf(plan, p.id).some((n) => n.bar >= plan.bars / 2)).toBe(true);
  });

  it('sorts notes by bar then step and validates its input', () => {
    const plan = planCrowd(base);
    const order = plan.notes.map((n) => n.bar * 16 + n.step);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(() => planCrowd({ ...base, players: 0 })).toThrow(RangeError);
    expect(() => planCrowd({ ...base, bars: 0 })).toThrow(RangeError);
    expect(() => planCrowd({ ...base, notesPerPlayer: -1 })).toThrow(RangeError);
  });
});
