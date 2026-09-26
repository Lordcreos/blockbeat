import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Hash } from 'viem';
import { createScheduler, type ClockView, type HitLanding, type HitSender } from './scheduler';

const BLOCK_MS = 300;

function fakeClock(initial: bigint) {
  let current = initial;
  const listeners = new Set<(b: bigint) => void>();
  const clock: ClockView = {
    currentBlock: () => current,
    measuredBlockMs: () => BLOCK_MS,
    msUntilBlock: (b) => Math.max(0, Number(b - current) * BLOCK_MS),
    onHead(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
  /** Advance the head: sets the current block and notifies listeners, like a real head. */
  function set(b: bigint): void {
    current = b;
    for (const cb of listeners) cb(b);
  }
  return { clock, set };
}

interface SentRecord {
  track: number;
  note: number;
  atBlock: bigint;
}

function fakeSender(land: (sent: SentRecord, i: number) => HitLanding) {
  const sent: SentRecord[] = [];
  const clockRef = { current: 0n };
  const sender: HitSender = {
    async send(track, note) {
      sent.push({ track, note, atBlock: clockRef.current });
      return `0x${(sent.length).toString(16).padStart(64, '0')}` as Hash;
    },
    async confirm(hash) {
      const i = Number.parseInt(hash.slice(2), 16) - 1;
      const s = sent[i];
      if (!s) throw new Error('unknown hash');
      return land(s, i);
    },
  };
  return { sender, sent, clockRef };
}

describe('scheduler', () => {
  const START = 1000n;
  let logs: string[];
  const log = { info: (m: string) => logs.push(m), warn: (m: string) => logs.push(`WARN ${m}`) };

  beforeEach(() => {
    vi.useFakeTimers();
    logs = [];
  });
  afterEach(() => vi.useRealTimers());

  it('computes the start block of the next bar from the session start', () => {
    const { clock } = fakeClock(START + 20n);
    const s = createScheduler({ clock, sender: fakeSender(() => ({ blockNumber: 0n, step: 0, on: true, gasUsed: 0n })).sender, startBlock: START, maxHits: 40, enabled: () => true, log });
    expect(s.nextBarStart()).toBe(START + 32n);
  });

  it('sends each addition at targetBlock minus the lead and records intended vs actual step', async () => {
    const { clock, set } = fakeClock(START + 16n);
    const fs = fakeSender((rec) => {
      // Lands exactly two blocks after it was sent, i.e. on the intended step.
      const landed = rec.atBlock + 2n;
      return { blockNumber: landed, step: Number((landed - START) % 16n), on: true, gasUsed: 61_538n };
    });
    const s = createScheduler({ clock, sender: fs.sender, startBlock: START, maxHits: 40, enabled: () => true, log, leadBlocks: 2 });
    const barStart = START + 32n;
    const planned = s.scheduleBar([{ step: 4, track: 2, note: 0 }, { step: 0, track: 4, note: 7 }], barStart);
    expect(planned.map((p) => p.sendBlock)).toEqual([barStart + 2n, barStart - 2n]);

    // step 0 fires when block barStart-2 = START+30 becomes the head
    fs.clockRef.current = START + 29n;
    set(START + 29n);
    await vi.advanceTimersByTimeAsync(1);
    expect(fs.sent).toHaveLength(0);
    fs.clockRef.current = START + 30n;
    set(START + 30n);
    await vi.advanceTimersByTimeAsync(1);
    expect(fs.sent).toHaveLength(1);
    expect(fs.sent[0]).toMatchObject({ track: 4, note: 7 });

    fs.clockRef.current = barStart + 2n;
    set(barStart + 2n);
    await vi.advanceTimersByTimeAsync(1);
    expect(fs.sent).toHaveLength(2);

    await s.drain();
    const results = s.results();
    expect(results).toHaveLength(2);
    for (const r of results) expect(r.actualStep).toBe(r.intendedStep);
    expect(s.stats()).toMatchObject({ sent: 2, confirmed: 2, matched: 2, failed: 0, budgetLeft: 38, gasUsed: 123_076n });
    expect(s.stats().matchRate).toBe(1);
  });

  it('counts a late landing as a mismatch and warns when a hit toggled a note off', async () => {
    const { clock, set } = fakeClock(START);
    const fs = fakeSender((rec) => {
      const landed = rec.atBlock + 3n;
      return { blockNumber: landed, step: Number((landed - START) % 16n), on: false, gasUsed: 61_538n };
    });
    const s = createScheduler({ clock, sender: fs.sender, startBlock: START, maxHits: 40, enabled: () => true, log });
    s.scheduleBar([{ step: 3, track: 1, note: 0 }], START + 16n);
    fs.clockRef.current = START + 17n; // the send block for step 3 with a lead of 2
    set(START + 17n);
    await vi.advanceTimersByTimeAsync(1);
    await s.drain();
    const [r] = s.results();
    expect(r?.intendedStep).toBe(3);
    expect(r?.actualStep).toBe(4);
    expect(r?.matched).toBe(false);
    expect(s.stats().matchRate).toBe(0);
    expect(logs.some((l) => l.startsWith('WARN') && /toggled off/.test(l))).toBe(true);
  });

  it('W17: sums the MON charged from the landings (Monad charges the gas limit)', async () => {
    const { clock, set } = fakeClock(START);
    const fs = fakeSender((rec, i) => {
      const landed = rec.atBlock + 2n;
      return { blockNumber: landed, step: Number((landed - START) % 16n), on: true, gasUsed: 61_538n, ...(i === 0 ? { feeWei: 20_400_000_000_000_000n } : { feeWei: 10_200_000_000_000_000n }) };
    });
    const s = createScheduler({ clock, sender: fs.sender, startBlock: START, maxHits: 40, enabled: () => true, log, leadBlocks: 2 });
    s.scheduleBar([
      { step: 2, track: 0, note: 10 },
      { step: 2, track: 4, note: 0 },
    ], START + 16n);
    fs.clockRef.current = START + 16n;
    set(START + 16n);
    await vi.advanceTimersByTimeAsync(1);
    await s.drain();
    expect(s.stats().feeWei).toBe(30_600_000_000_000_000n);
  });

  it('W17: a refresh of the DJ\'s own expiring note is expected to clear its recorded bit: logged as a refresh, not a warning', async () => {
    const { clock, set } = fakeClock(START);
    const fs = fakeSender((rec) => ({ blockNumber: rec.atBlock + 2n, step: Number((rec.atBlock + 2n - START) % 16n), on: false, gasUsed: 61_538n }));
    const s = createScheduler({ clock, sender: fs.sender, startBlock: START, maxHits: 40, enabled: () => true, log, leadBlocks: 2 });
    s.scheduleBar([{ step: 3, track: 0, note: 10, refresh: true }], START + 16n);
    fs.clockRef.current = START + 17n;
    set(START + 17n);
    await vi.advanceTimersByTimeAsync(1);
    await s.drain();
    expect(logs.some((l) => l.startsWith('WARN') && /toggled off/.test(l))).toBe(false);
    expect(logs.some((l) => /refreshed its own note/.test(l))).toBe(true);
  });

  it('skips additions whose send block has already passed', () => {
    const { clock } = fakeClock(START + 40n);
    const fs = fakeSender(() => ({ blockNumber: 0n, step: 0, on: true, gasUsed: 0n }));
    const s = createScheduler({ clock, sender: fs.sender, startBlock: START, maxHits: 40, enabled: () => true, log });
    const planned = s.scheduleBar([{ step: 0, track: 0, note: 0 }, { step: 12, track: 2, note: 0 }], START + 32n);
    expect(planned).toHaveLength(1);
    expect(planned[0]?.step).toBe(12);
    expect(s.stats().skipped).toBe(1);
  });

  it('enforces the per-session cap across bars', async () => {
    const { clock, set } = fakeClock(START);
    const fs = fakeSender((rec) => ({ blockNumber: rec.atBlock + 2n, step: 0, on: true, gasUsed: 1n }));
    const s = createScheduler({ clock, sender: fs.sender, startBlock: START, maxHits: 3, enabled: () => true, log });
    s.scheduleBar(
      [
        { step: 4, track: 0, note: 0 },
        { step: 5, track: 1, note: 0 },
        { step: 6, track: 2, note: 0 },
        { step: 7, track: 3, note: 0 },
      ],
      START + 16n,
    );
    for (let b = START + 1n; b <= START + 24n; b++) set(b);
    await s.drain();
    expect(fs.sent).toHaveLength(3);
    expect(s.stats().budgetLeft).toBe(0);
    expect(s.stats().skipped).toBe(1);
    expect(s.scheduleBar([{ step: 4, track: 0, note: 0 }], START + 32n)).toEqual([]);
  });

  it('honours the kill switch at send time', async () => {
    const { clock, set } = fakeClock(START);
    let enabled = true;
    const fs = fakeSender((rec) => ({ blockNumber: rec.atBlock + 2n, step: 0, on: true, gasUsed: 1n }));
    const s = createScheduler({ clock, sender: fs.sender, startBlock: START, maxHits: 40, enabled: () => enabled, log });
    s.scheduleBar([{ step: 8, track: 0, note: 0 }], START + 16n);
    enabled = false;
    for (let b = START + 1n; b <= START + 24n; b++) set(b);
    await s.drain();
    expect(fs.sent).toHaveLength(0);
    expect(s.stats().skipped).toBe(1);
    expect(logs.some((l) => /kill switch/i.test(l))).toBe(true);
  });

  it('records send failures without throwing and keeps the budget honest', async () => {
    const { clock, set } = fakeClock(START);
    const sender: HitSender = {
      send: async () => {
        throw new Error('nonce too low');
      },
      confirm: async () => ({ blockNumber: 0n, step: 0, on: true, gasUsed: 0n }),
    };
    const s = createScheduler({ clock, sender, startBlock: START, maxHits: 40, enabled: () => true, log });
    s.scheduleBar([{ step: 8, track: 0, note: 0 }], START + 16n);
    for (let b = START + 1n; b <= START + 24n; b++) set(b);
    await s.drain();
    expect(s.stats()).toMatchObject({ sent: 0, failed: 1, budgetLeft: 40 });
    expect(logs.some((l) => /nonce too low/.test(l))).toBe(true);
  });

  it('cancels pending timers on stop', async () => {
    const { clock, set } = fakeClock(START);
    const fs = fakeSender(() => ({ blockNumber: 0n, step: 0, on: true, gasUsed: 0n }));
    const s = createScheduler({ clock, sender: fs.sender, startBlock: START, maxHits: 40, enabled: () => true, log });
    s.scheduleBar([{ step: 8, track: 0, note: 0 }], START + 16n);
    s.stop();
    for (let b = START + 1n; b <= START + 24n; b++) set(b);
    await vi.advanceTimersByTimeAsync(40 * BLOCK_MS);
    expect(fs.sent).toHaveLength(0);
    expect(s.stats().cancelled).toBe(1);
    expect(logs.some((l) => /WARN stop: cancelling 1 pending hit/.test(l))).toBe(true);
  });

  it('falls back to the predicted time when heads stall, one block of grace after the send block', async () => {
    const { clock } = fakeClock(START);
    const fs = fakeSender((rec) => ({ blockNumber: rec.atBlock + 2n, step: 0, on: true, gasUsed: 1n }));
    const s = createScheduler({ clock, sender: fs.sender, startBlock: START, maxHits: 40, enabled: () => true, log });
    s.scheduleBar([{ step: 4, track: 0, note: 0 }], START + 16n); // send block START+18: 18 blocks away
    await vi.advanceTimersByTimeAsync(18 * BLOCK_MS);
    expect(fs.sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(BLOCK_MS);
    expect(fs.sent).toHaveLength(1);
    expect(logs.some((l) => /WARN .*no head/.test(l))).toBe(true);
  });

  it('adapts the lead from the measured landing delta so consistently early hits send later', async () => {
    const { clock, set } = fakeClock(START);
    // The chain includes a transaction in the very next block: with a lead of 2 it lands one early.
    const fs = fakeSender((rec) => {
      const landed = rec.atBlock + 1n;
      return { blockNumber: landed, step: Number((landed - START) % 16n), on: true, gasUsed: 1n };
    });
    const s = createScheduler({ clock, sender: fs.sender, startBlock: START, maxHits: 40, enabled: () => true, log, leadBlocks: 2 });
    const first = s.scheduleBar([{ step: 8, track: 0, note: 0 }, { step: 12, track: 1, note: 0 }], START + 16n);
    expect(first.map((h) => h.sendBlock)).toEqual([START + 22n, START + 26n]);
    for (let b = START + 1n; b <= START + 28n; b++) {
      fs.clockRef.current = b;
      set(b);
      await vi.advanceTimersByTimeAsync(1);
    }
    await s.drain();
    // The first hit lands early; the second, still pending, is re-timed and lands on target.
    expect(s.results().map((r) => r.matched)).toEqual([false, true]);
    expect(s.leadBlocks()).toBe(1);
    const second = s.scheduleBar([{ step: 8, track: 0, note: 0 }], START + 32n);
    expect(second[0]?.sendBlock).toBe(START + 39n);
    for (let b = START + 29n; b <= START + 42n; b++) {
      fs.clockRef.current = b;
      set(b);
      await vi.advanceTimersByTimeAsync(1);
    }
    await s.drain();
    expect(s.results()[2]?.matched).toBe(true);
  });

  it('keeps a fixed lead when adaptation is off', async () => {
    const { clock, set } = fakeClock(START);
    const fs = fakeSender((rec) => ({ blockNumber: rec.atBlock + 1n, step: Number((rec.atBlock + 1n - START) % 16n), on: true, gasUsed: 1n }));
    const s = createScheduler({ clock, sender: fs.sender, startBlock: START, maxHits: 40, enabled: () => true, log, leadBlocks: 2, adaptiveLead: false });
    s.scheduleBar([{ step: 8, track: 0, note: 0 }], START + 16n);
    for (let b = START + 1n; b <= START + 26n; b++) {
      fs.clockRef.current = b;
      set(b);
      await vi.advanceTimersByTimeAsync(1);
    }
    await s.drain();
    expect(s.leadBlocks()).toBe(2);
  });

  it('re-times hits that are still pending when the lead changes', async () => {
    const { clock, set } = fakeClock(START);
    const fs = fakeSender((rec) => {
      const landed = rec.atBlock + 1n;
      return { blockNumber: landed, step: Number((landed - START) % 16n), on: true, gasUsed: 1n };
    });
    const s = createScheduler({ clock, sender: fs.sender, startBlock: START, maxHits: 40, enabled: () => true, log, leadBlocks: 2 });
    // Two bars planned up front, as the seed script does.
    s.scheduleBar([{ step: 4, track: 0, note: 0 }], START + 16n); // send START+18, lands START+19 (early)
    s.scheduleBar([{ step: 4, track: 0, note: 0 }], START + 32n); // send START+34 → re-timed to START+35 after the first landing
    for (let b = START + 1n; b <= START + 40n; b++) {
      fs.clockRef.current = b;
      set(b);
      await vi.advanceTimersByTimeAsync(1);
    }
    await s.drain();
    expect(s.results().map((r) => [r.sentAtBlock, r.matched])).toEqual([
      [START + 18n, false],
      [START + 35n, true],
    ]);
  });

  it('lists hits that have not landed yet and settles once they all have', async () => {
    const { clock, set } = fakeClock(START);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const sender: HitSender = {
      send: async () => '0x01',
      confirm: async () => {
        await gate;
        return { blockNumber: START + 20n, step: 4, on: true, gasUsed: 1n };
      },
    };
    const s = createScheduler({ clock, sender, startBlock: START, maxHits: 40, enabled: () => true, log });
    s.scheduleBar([{ step: 4, track: 0, note: 0 }, { step: 9, track: 2, note: 1 }], START + 16n);
    expect(s.pending().map((h) => [h.step, h.track, h.note])).toEqual([
      [4, 0, 0],
      [9, 2, 1],
    ]);
    set(START + 18n); // step 4 sent, awaiting confirmation: still pending
    await vi.advanceTimersByTimeAsync(1);
    expect(s.pending().map((h) => h.step)).toEqual([4, 9]);
    let settled = false;
    const settling = s.settle().then(() => {
      settled = true;
    });
    release();
    await vi.advanceTimersByTimeAsync(100);
    expect(settled).toBe(false);
    expect(s.pending().map((h) => h.step)).toEqual([9]);
    set(START + 23n);
    await vi.advanceTimersByTimeAsync(100);
    await settling;
    expect(s.pending()).toEqual([]);
  });
});
