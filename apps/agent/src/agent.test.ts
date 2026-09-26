import { describe, expect, it, vi } from 'vitest';
import { emptyPattern } from '@blockbeat/shared';
import { createAgentLoop } from './agent';
import type { Brain } from './lib/brain/types';
import type { FallbackBrain } from './lib/brain/fallback';
import type { BlockClock } from './lib/blockClock';
import { buildLiveGrid, type PatternReader } from './lib/pattern';
import { parseKey } from './lib/music/theory';
import type { Scheduler } from './lib/scheduler';

function fakeClock() {
  const listeners = new Set<(b: bigint) => void>();
  let current = 0n;
  const clock: BlockClock = {
    start: () => undefined,
    stop: () => undefined,
    locked: () => true,
    currentBlock: () => current,
    measuredBlockMs: () => 300,
    source: () => 'ws',
    predictBlockIn: () => current,
    msUntilBlock: () => 0,
    onHead(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    onError: () => () => undefined,
  };
  return {
    clock,
    /** Moves the head without firing onHead (a slow brain call while blocks go by). */
    setCurrent(b: bigint) {
      current = b;
    },
    async emit(b: bigint) {
      current = b;
      for (const cb of listeners) cb(b);
      // Let runBar's awaits (session read, pattern read, plan) settle before asserting.
      await new Promise((r) => setTimeout(r, 0));
    },
  };
}

function setup(bars: number | null = null, brainOverride?: Brain | FallbackBrain) {
  const { clock, emit, setCurrent } = fakeClock();
  const reads: bigint[] = [];
  let onRead: () => void = () => undefined;
  const liveAts: Array<bigint | undefined> = [];
  const reader: PatternReader = {
    ledger: { apply: () => undefined, ownerOf: () => 'human', hits: () => [] },
    read: async (b, liveAt) => {
      onRead();
      reads.push(b);
      liveAts.push(liveAt);
      return buildLiveGrid({
        hits: [],
        at: liveAt ?? b,
        decay: { lifetimeBars: 8, maxLivePerTrack: 6 },
        agentAddress: '0x2222222222222222222222222222222222222222',
        recorded: emptyPattern(),
        recordedOwner: () => 'human',
      });
    },
  };
  const plan = vi.fn<Brain['plan']>(async () => [{ step: 8, track: 2 as const, note: 0 }]);
  const brain: Brain | FallbackBrain = brainOverride ?? { mode: 'rules', plan };
  const scheduleBar = vi.fn(() => [{ step: 8, track: 2 as const, note: 0, targetBlock: 0n, sendBlock: 0n }]);
  const pending = vi.fn<Scheduler['pending']>(() => []);
  const results = vi.fn<Scheduler['results']>(() => []);
  const scheduler: Scheduler = {
    nextBarStart: () => 0n,
    leadBlocks: () => 2,
    pending,
    settle: async () => undefined,
    scheduleBar,
    results,
    stats: () => ({ planned: 0, sent: 1, confirmed: 1, matched: 1, failed: 0, skipped: 0, cancelled: 0, budgetLeft: 39, gasUsed: 0n, feeWei: 20_400_000_000_000_000n, matchRate: 1 }),
    drain: async () => undefined,
    stop: () => undefined,
  };
  const stop = vi.fn();
  scheduler.stop = stop;
  const lines: string[] = [];
  let finalized = false;
  const readSession = vi.fn(async () => ({ finalized }));
  const options = {
    clock,
    reader,
    brain,
    scheduler,
    startBlock: 100n,
    log: { info: (m: string) => lines.push(m), warn: (m: string) => lines.push(`WARN ${m}`) },
    bars,
    identityLabel: () => 'erc8004 unregistered',
    readSession,
  };
  const loop = createAgentLoop(options);
  return { options, clock, loop, emit, setCurrent, reads, liveAts, plan, scheduleBar, lines, pending, results, onRead: (f: () => void) => { onRead = f; }, stop, readSession, finalize: () => { finalized = true; } };
}

describe('agent loop', () => {
  it('W14: the status line names the brain that played the bar, with its model or the fallback reason', async () => {
    let label = 'gemini gemini-3.8-flash';
    const fb: FallbackBrain = {
      mode: 'gemini',
      model: 'gemini-3.8-flash',
      plan: async () => [],
      lastMode: () => (label.startsWith('rules') ? 'rules' : 'gemini'),
      lastLabel: () => label,
    };
    const { loop, emit, lines } = setup(null, fb);
    loop.start();
    await emit(100n);
    label = 'rules (gemini timeout)';
    await emit(116n);
    const bars = lines.filter((l) => l.startsWith('bar '));
    expect(bars[0]).toContain('| brain gemini gemini-3.8-flash |');
    expect(bars[1]).toContain('| brain rules (gemini timeout) |');
  });

  it('acts once per bar on the bar boundary and schedules for the next bar', async () => {
    const { loop, emit, reads, liveAts, plan, scheduleBar, lines } = setup();
    loop.start();
    await emit(99n); // before the session
    await emit(105n); // mid-bar: bar 0 started at 100, act now (we joined late)
    await emit(110n);
    await emit(116n); // bar 1
    await emit(117n);
    expect(reads).toEqual([100n, 116n]);
    // W13: the live layer is evaluated where the planned bar starts.
    expect(liveAts).toEqual([116n, 132n]);
    expect(plan).toHaveBeenCalledTimes(2);
    expect(plan.mock.calls[1]?.[1]).toMatchObject({ bar: 1, budgetLeft: 39, maxNotesPerBar: 8, lifetimeBars: 8 });
    expect(scheduleBar).toHaveBeenLastCalledWith([{ step: 8, track: 2, note: 0 }], 132n);
    expect(lines.filter((l) => l.startsWith('bar '))).toHaveLength(2);
    expect(lines[0]).toMatch(/^bar 0 \| block \d+ \| section intro · A minor · Am-F-C-G \| sent 1 \| on-step 1\/1 \(100%\) \| MON 0\.0204 \| budget 39 \| brain rules \| clock ws 300ms \| erc8004 unregistered \| live 0 \| next: t2@8n0→b\d+$/);
  });

  it('W13: a brain that answers after a send block has passed re-plans those notes for the following bar', async () => {
    const { loop, emit, setCurrent, plan, scheduleBar, lines } = setup();
    plan.mockImplementationOnce(async () => {
      setCurrent(122n); // bar 0 → planning for 116..131; now 122 with a lead of 2: step 8 is still on time, step 2 is late
      return [
        { step: 2, track: 0 as const, note: 0 },
        { step: 8, track: 2 as const, note: 0 },
      ];
    });
    loop.start();
    await emit(100n);
    expect(scheduleBar).toHaveBeenNthCalledWith(1, [{ step: 8, track: 2, note: 0 }], 116n);
    expect(scheduleBar).toHaveBeenNthCalledWith(2, [{ step: 2, track: 0, note: 0 }], 132n);
    expect(lines.some((l) => /late plan: 1 addition moved to the bar at block 132/.test(l))).toBe(true);
    await loop.stop();
  });

  it('reads the session every bar and stops planning once it is finalized (review H4)', async () => {
    const { loop, emit, plan, stop, lines, readSession, finalize } = setup(null);
    loop.start();
    await emit(100n);
    expect(plan).toHaveBeenCalledTimes(1);
    expect(readSession).toHaveBeenCalledTimes(1);
    finalize();
    await emit(116n);
    expect(readSession).toHaveBeenCalledTimes(2);
    expect(plan).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(lines.some((l) => /finalized/.test(l))).toBe(true);
    await loop.done;
    expect(loop.finalized()).toBe(true);
    await emit(132n);
    expect(readSession).toHaveBeenCalledTimes(2);
    expect(plan).toHaveBeenCalledTimes(1);
  });

  it('stops after the configured number of bars and resolves done', async () => {
    const { loop, emit, plan } = setup(2);
    loop.start();
    await emit(100n);
    await emit(116n);
    await emit(132n);
    await loop.done;
    expect(plan).toHaveBeenCalledTimes(2);
    expect(loop.barsHandled()).toBe(2);
  });

  it('logs a failed bar and keeps going', async () => {
    const { loop, emit, lines, plan } = setup();
    plan.mockRejectedValueOnce(new Error('rpc down'));
    loop.start();
    await emit(100n);
    await emit(116n);
    expect(lines.some((l) => /WARN bar at block 100 failed: rpc down/.test(l))).toBe(true);
    expect(plan).toHaveBeenCalledTimes(2);
  });

  it('stops listening after stop()', async () => {
    const { loop, emit, plan } = setup();
    loop.start();
    await emit(100n);
    await loop.stop();
    await emit(116n);
    expect(plan).toHaveBeenCalledTimes(1);
  });

  it('shows the brain the hits that are still pending so it does not plan them twice', async () => {
    const { loop, emit, plan, pending } = setup();
    pending.mockReturnValue([{ step: 13, track: 2, note: 0, targetBlock: 129n, sendBlock: 127n }]);
    loop.start();
    await emit(116n);
    const grid = plan.mock.calls[0]?.[0];
    expect(grid?.isOn(13, 2, 0)).toBe(true);
    expect(grid?.cells).toEqual([{ step: 13, track: 2, note: 0, owner: 'agent' }]);
  });

  it('W14b (testnet session 5): a hit that lands WHILE the pattern is read is still shown (pending and landings are one snapshot)', async () => {
    const { loop, emit, plan, pending, results, onRead } = setup();
    const inFlight = { step: 4, track: 3 as const, note: 0, targetBlock: 122n, sendBlock: 120n };
    pending.mockReturnValue([inFlight]);
    onRead(() => {
      // The receipt arrives during the read: the hit leaves pending() and shows up in results(), one step early.
      pending.mockReturnValue([]);
      results.mockReturnValue([{ step: 4, track: 3, note: 0, intendedStep: 4, actualStep: 3, matched: false, targetBlock: 122n, landedBlock: 121n, sentAtBlock: 120n, txHash: '0x01', gasUsed: 200_000n, on: true, latencyMs: 400 }]);
    });
    loop.start();
    await emit(116n);
    expect(plan.mock.calls[0]?.[0]?.isOn(3, 3, 0)).toBe(true);
  });

  it('W14b: shows the brain its recent landings at the step they ACTUALLY landed on (the reader may lag)', async () => {
    const { loop, emit, plan, results } = setup();
    const landed = (step: number, actualStep: number, landedBlock: bigint, on = true) => ({
      step, track: 0 as const, note: 0, intendedStep: step, actualStep, matched: step === actualStep, targetBlock: landedBlock, landedBlock,
      sentAtBlock: landedBlock - 2n, txHash: '0x01' as const, gasUsed: 100_000n, on, latencyMs: 300,
    });
    results.mockReturnValue([
      landed(0, 15, 115n), // off-step: intended 0, landed on 15
      landed(8, 8, 108n), // on-step, maybe not in the reader yet
      landed(4, 4, 110n, false), // W17: on=false still sounds in the live layer (ADR 0001), e.g. a DJ refresh
      landed(12, 12, 60n), // older than two bars: the reader has it
    ]);
    loop.start();
    await emit(116n);
    const grid = plan.mock.calls[0]?.[0];
    expect(grid?.isOn(15, 0, 0)).toBe(true);
    expect(grid?.isOn(8, 0, 0)).toBe(true);
    expect(grid?.isOn(0, 0, 0)).toBe(false);
    expect(grid?.isOn(4, 0, 0)).toBe(true);
    expect(grid?.isOn(12, 0, 0)).toBe(false);
  });

  it('W17: the arrangement starts at the DJ\'s first bar; section, key and progression go to the brain and the status line', async () => {
    const { loop, emit, plan, lines } = setup();
    loop.start();
    for (const b of [100n, 116n, 132n, 148n, 164n]) await emit(b);
    const sections = plan.mock.calls.map((c) => c[1].music?.section);
    expect(sections).toEqual(['intro', 'intro', 'intro', 'intro', 'build']);
    expect(plan.mock.calls[4]?.[1].music?.bar).toBe(4);
    expect(lines.filter((l) => l.startsWith('bar '))[4]).toContain('| section build · A minor · Am-F-C-G |');
  });

  it('W17: takes the key, progression, per-bar cap and set start bar from its options', async () => {
    const { clock, emit } = fakeClock();
    void clock;
    const base = setup();
    const plan = vi.fn<Brain['plan']>(async () => []);
    const loop = createAgentLoop({
      ...base.options,
      brain: { mode: 'rules', plan },
      clock: base.clock,
      music: { key: parseKey('C major') },
      maxNotesPerBar: 3,
      lifetimeBars: 8,
      startBar: 8,
    });
    loop.start();
    await base.emit(100n);
    void emit;
    expect(plan.mock.calls[0]?.[1]).toMatchObject({ maxNotesPerBar: 3 });
    expect(plan.mock.calls[0]?.[1].music?.chords.map((c) => c.name)).toEqual(['C', 'G', 'Am', 'F']);
    // AGENT_SET_START_BAR: the set can open at the peak (bar 8 of the arrangement).
    expect(plan.mock.calls[0]?.[1].music?.section).toBe('peak');
  });
});
