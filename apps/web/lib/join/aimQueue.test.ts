import { describe, expect, it, vi } from 'vitest';
import { stepForBlock, type TrackId } from '@blockbeat/shared';
import { MAX_AIMED, createAimQueue, type AimClock, type AimLanding } from './aimQueue';

const START = 1000n;

/** A block clock the test advances by hand. */
function fakeClock(head: bigint | null = 1000n): AimClock & { tick(to?: bigint): void; jump(to: bigint): void } {
  let current = head;
  const listeners = new Set<(b: bigint) => void>();
  return {
    head: () => current,
    onBlock(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    tick(to) {
      current = to ?? (current ?? 0n) + 1n;
      for (const cb of [...listeners]) cb(current);
    },
    jump(to) {
      current = to;
      for (const cb of [...listeners]) cb(current);
    },
  };
}

interface Sent {
  track: TrackId;
  note: number;
  atBlock: bigint | null;
  resolve(landing: AimLanding): void;
  reject(error: unknown): void;
}

/** A sender that records what went out and on which head; the test decides where it lands. */
function fakeSender(clock: AimClock) {
  const sent: Sent[] = [];
  const send = vi.fn(
    (track: TrackId, note: number) =>
      new Promise<AimLanding>((resolve, reject) => {
        sent.push({ track, note, atBlock: clock.head(), resolve, reject });
      }),
  );
  /** Land the i-th send `delay` blocks after its send head. */
  const land = async (i: number, delay = 1): Promise<void> => {
    const s = sent[i]!;
    const blockNumber = (s.atBlock ?? 0n) + BigInt(delay);
    s.resolve({ blockNumber, step: stepForBlock(START, blockNumber) });
    await Promise.resolve();
    await Promise.resolve();
  };
  return { sent, send, land };
}

describe('createAimQueue', () => {
  it('sends lead blocks before the target and reports an exact landing', async () => {
    const clock = fakeClock(1000n); // step 0
    const { sent, send, land } = fakeSender(clock);
    const q = createAimQueue({ clock, send, startBlock: () => START });
    const item = q.aim({ track: 0, note: 3, step: 7 });
    expect(item.ok).toBe(true);
    if (!item.ok) return;
    expect(item.item.targetBlock).toBe(1007n);
    expect(item.item.sendBlock).toBe(1006n);
    for (let b = 1001n; b < 1006n; b++) clock.tick(b);
    expect(sent).toHaveLength(0);
    clock.tick(1006n);
    expect(sent).toHaveLength(1);
    expect(q.getState().items[0]?.status).toBe('sending');
    await land(0, 1);
    const state = q.getState();
    expect(state.items).toHaveLength(0);
    expect(state.results[0]).toMatchObject({ ok: true, aimedStep: 7, landedStep: 7, delta: 0, text: 'aimed step 7 · landed step 7', latencyMs: null });
  });

  it('sends at once when the aimed step is exactly lead blocks away', () => {
    const clock = fakeClock(1000n);
    const { sent, send } = fakeSender(clock);
    const q = createAimQueue({ clock, send, startBlock: () => START });
    q.aim({ track: 1, note: 0, step: 1 });
    expect(sent).toHaveLength(1);
  });

  it('learns a slower phone: after a 2-block landing it sends 2 blocks early', async () => {
    const clock = fakeClock(1000n);
    const { sent, send, land } = fakeSender(clock);
    const q = createAimQueue({ clock, send, startBlock: () => START });
    q.aim({ track: 0, note: 0, step: 3 });
    clock.tick(1001n);
    clock.tick(1002n); // send on 1002
    await land(0, 2); // lands 1004 = step 4, one late
    expect(q.getState().results[0]).toMatchObject({ text: 'aimed step 3 · landed step 4 (one late)' });
    expect(q.getState().lead).toBe(2);
    const r = q.aim({ track: 0, note: 0, step: 9 });
    expect(r.ok && r.item.sendBlock).toBe(1007n); // target 1009 − 2
    for (let b = 1003n; b <= 1007n; b++) clock.tick(b);
    expect(sent).toHaveLength(2);
    expect(sent[1]?.atBlock).toBe(1007n);
    await land(1, 2);
    expect(q.getState().results[0]).toMatchObject({ landedStep: 9, delta: 0 });
  });

  it('retimes waiting notes when the lead changes', async () => {
    const clock = fakeClock(1000n);
    const { sent, send, land } = fakeSender(clock);
    const q = createAimQueue({ clock, send, startBlock: () => START });
    q.aim({ track: 0, note: 0, step: 2 }); // send 1001
    const far = q.aim({ track: 0, note: 1, step: 12 }); // send 1011
    clock.tick(1001n);
    await land(0, 3); // lead → 3
    expect(q.getState().lead).toBe(3);
    const waiting = q.getState().items.find((i) => far.ok && i.id === far.item.id);
    expect(waiting?.sendBlock).toBe(1009n);
    expect(sent).toHaveLength(1);
  });

  it('a lead change that puts a send block in the past re-aims into the next loop', async () => {
    const clock = fakeClock(1000n);
    const { sent, send, land } = fakeSender(clock);
    const q = createAimQueue({ clock, send, startBlock: () => START });
    q.aim({ track: 0, note: 0, step: 1 }); // sent at once on 1000
    q.aim({ track: 0, note: 1, step: 4 }); // send 1003
    clock.tick(1001n);
    clock.tick(1002n);
    await land(0, 4); // lead → 4: step 4 now needs a send on 1000, gone
    expect(q.getState().items.find((i) => i.step === 4)).toMatchObject({ targetBlock: 1020n, sendBlock: 1016n, status: 'waiting' });
    expect(sent).toHaveLength(1);
  });

  it('re-aims into the next loop when the clock jumps past a send block', () => {
    const clock = fakeClock(1000n);
    const { sent, send } = fakeSender(clock);
    const q = createAimQueue({ clock, send, startBlock: () => START });
    q.aim({ track: 0, note: 0, step: 5 }); // send 1004, target 1005
    clock.jump(1006n); // a background tab or a hard re-lock
    expect(sent).toHaveLength(0);
    expect(q.getState().items[0]).toMatchObject({ targetBlock: 1021n, sendBlock: 1020n, status: 'waiting' });
  });

  it('queues at most 4 notes and refuses duplicates of the same pad on the same step', () => {
    const clock = fakeClock(1000n);
    const { send } = fakeSender(clock);
    const q = createAimQueue({ clock, send, startBlock: () => START });
    expect(MAX_AIMED).toBe(4);
    for (const step of [4, 8, 12]) expect(q.aim({ track: 0, note: 0, step }).ok).toBe(true);
    expect(q.aim({ track: 0, note: 0, step: 8 })).toEqual({ ok: false, reason: 'duplicate' });
    expect(q.aim({ track: 1, note: 0, step: 8 }).ok).toBe(true); // another track on the same step is fine
    expect(q.aim({ track: 0, note: 0, step: 14 })).toEqual({ ok: false, reason: 'full' });
  });

  it('four kicks on 0, 4, 8, 12 each land on their step, sent in step order', async () => {
    const clock = fakeClock(1000n);
    const { sent, send, land } = fakeSender(clock);
    const q = createAimQueue({ clock, send, startBlock: () => START });
    for (const step of [0, 4, 8, 12]) q.aim({ track: 0, note: 24, step });
    for (let b = 1001n; b <= 1015n; b++) clock.tick(b);
    expect(sent.map((s) => s.atBlock)).toEqual([1003n, 1007n, 1011n, 1015n]);
    for (let i = 0; i < 4; i++) await land(i, 1);
    expect(q.getState().items).toHaveLength(0);
    expect(q.getState().results.map((r) => (r.ok ? r.landedStep : -1))).toEqual([0, 12, 8, 4]);
    expect(q.getState().results.every((r) => r.ok && r.delta === 0)).toBe(true);
  });

  it('respects the balance: no more aimed notes than notes left', () => {
    const clock = fakeClock(1000n);
    const { send } = fakeSender(clock);
    let notesLeft: number | null = 2;
    const q = createAimQueue({ clock, send, startBlock: () => START, budget: () => notesLeft });
    expect(q.aim({ track: 0, note: 0, step: 4 }).ok).toBe(true);
    expect(q.aim({ track: 0, note: 0, step: 8 }).ok).toBe(true);
    expect(q.aim({ track: 0, note: 0, step: 12 })).toEqual({ ok: false, reason: 'no-funds' });
    notesLeft = null; // unknown balance: do not block
    expect(q.aim({ track: 0, note: 0, step: 12 }).ok).toBe(true);
  });

  it('refuses to aim before the clock and the session are known', () => {
    const clock = fakeClock(null);
    const { send } = fakeSender(clock);
    expect(createAimQueue({ clock, send, startBlock: () => START }).aim({ track: 0, note: 0, step: 1 })).toEqual({ ok: false, reason: 'no-clock' });
    const clock2 = fakeClock(1000n);
    expect(createAimQueue({ clock: clock2, send, startBlock: () => null }).aim({ track: 0, note: 0, step: 1 })).toEqual({ ok: false, reason: 'no-clock' });
  });

  it('a failed send becomes a failed result, keeps the error, and frees the slot', async () => {
    const clock = fakeClock(1000n);
    const { sent, send } = fakeSender(clock);
    const q = createAimQueue({ clock, send, startBlock: () => START });
    q.aim({ track: 0, note: 0, step: 1 });
    const boom = new Error('Out of MON');
    sent[0]!.reject(boom);
    await Promise.resolve();
    await Promise.resolve();
    const r = q.getState().results[0];
    expect(r).toMatchObject({ ok: false, aimedStep: 1 });
    expect(r && !r.ok && r.error).toBe(boom);
    expect(q.getState().items).toHaveLength(0);
  });

  it('cancel removes a waiting note; a note already sent cannot be cancelled', () => {
    const clock = fakeClock(1000n);
    const { send } = fakeSender(clock);
    const q = createAimQueue({ clock, send, startBlock: () => START });
    const now = q.aim({ track: 0, note: 0, step: 1 }); // sent at once
    const later = q.aim({ track: 0, note: 0, step: 9 });
    expect(now.ok && q.cancel(now.item.id)).toBe(false);
    expect(later.ok && q.cancel(later.item.id)).toBe(true);
    expect(q.getState().items).toHaveLength(1);
  });

  it('notifies subscribers on every change and stops listening to the clock on dispose', () => {
    const clock = fakeClock(1000n);
    const { send, sent } = fakeSender(clock);
    const q = createAimQueue({ clock, send, startBlock: () => START });
    const seen = vi.fn();
    const off = q.subscribe(seen);
    q.aim({ track: 0, note: 0, step: 9 });
    expect(seen).toHaveBeenCalledTimes(1);
    off();
    q.dispose();
    for (let b = 1001n; b <= 1010n; b++) clock.tick(b);
    expect(sent).toHaveLength(0);
    expect(q.aim({ track: 0, note: 0, step: 3 })).toEqual({ ok: false, reason: 'disposed' });
  });

  it('getState is referentially stable between changes (useSyncExternalStore)', () => {
    const clock = fakeClock(1000n);
    const { send } = fakeSender(clock);
    const q = createAimQueue({ clock, send, startBlock: () => START });
    const a = q.getState();
    clock.tick(1001n);
    expect(q.getState()).toBe(a);
    q.aim({ track: 0, note: 0, step: 9 });
    expect(q.getState()).not.toBe(a);
  });

  it('learns from Tap now landings too (recordInclusion)', () => {
    const clock = fakeClock(1000n);
    const { send } = fakeSender(clock);
    const q = createAimQueue({ clock, send, startBlock: () => START });
    q.recordInclusion(1000n, 1003n);
    q.recordInclusion(1010n, 1013n);
    expect(q.getState().lead).toBe(3);
  });

  it('retime() re-plans waiting notes from their fixed target and tells subscribers (nonce reset)', () => {
    const clock = fakeClock(1000n);
    const { send } = fakeSender(clock);
    const q = createAimQueue({ clock, send, startBlock: () => START });
    const r = q.aim({ track: 0, note: 0, step: 9 });
    const seen = vi.fn();
    q.subscribe(seen);
    q.retime();
    expect(seen).toHaveBeenCalledTimes(1);
    expect(q.getState().items[0]).toMatchObject({ targetBlock: r.ok ? r.item.targetBlock : -1n, sendBlock: 1008n, status: 'waiting' });
  });

  it('keeps only the most recent results, newest first', async () => {
    const clock = fakeClock(1000n);
    const { send, land } = fakeSender(clock);
    const q = createAimQueue({ clock, send, startBlock: () => START, keepResults: 2 });
    for (const step of [1, 2, 3]) {
      q.aim({ track: 0, note: 0, step });
      clock.tick();
    }
    for (let i = 0; i < 3; i++) await land(i, 1);
    expect(q.getState().results.map((r) => r.aimedStep)).toEqual([3, 2]);
  });
});

describe('createAimQueue with sub-block timing (a clock with position())', () => {
  /** A clock whose fractional position the test sets; ticks fire on whole blocks. */
  function positionClock(start = 1000) {
    let pos = start;
    const listeners = new Set<(b: bigint) => void>();
    const clock: AimClock = {
      head: () => BigInt(Math.floor(pos)),
      position: () => pos,
      blockMs: () => 300,
      onBlock(cb) {
        listeners.add(cb);
        return () => listeners.delete(cb);
      },
    };
    return {
      clock,
      /** Move to `to` (fractional); fire a tick for every whole block crossed. */
      moveTo(to: number) {
        const from = Math.floor(pos);
        pos = to;
        for (let b = from + 1; b <= Math.floor(to); b++) for (const cb of [...listeners]) cb(BigInt(b));
      },
    };
  }

  function sender() {
    const sent: Array<{ at: number; resolve(l: AimLanding): void }> = [];
    let clockRef: AimClock | null = null;
    const send = vi.fn(
      () =>
        new Promise<AimLanding>((resolve) => {
          sent.push({ at: clockRef?.position?.() ?? -1, resolve });
        }),
    );
    return { sent, send, bind: (c: AimClock) => (clockRef = c) };
  }

  const settle = async () => {
    await Promise.resolve();
    await Promise.resolve();
  };

  it('fires at target − mean delay, inside the block, and learns the fractional delay', async () => {
    vi.useFakeTimers();
    try {
      const c = positionClock(1000);
      const s = sender();
      s.bind(c.clock);
      const q = createAimQueue({ clock: c.clock, send: s.send, startBlock: () => START });
      // Teach it a 6.75-block delay (two Tap now landings sent at x.0 and x.5).
      q.recordInclusion(990, 996n + 0n);
      q.recordInclusion(990.5, 997n + 1n);
      expect(q.getState().leadBlocks).toBeCloseTo(6.75, 5);
      const r = q.aim({ track: 0, note: 0, step: 10 });
      // earliest landing ceil(1000 + 6.75) = 1007 → step 10 is block 1010; send at 1003.25
      expect(r.ok && r.item.targetBlock).toBe(1010n);
      expect(r.ok && r.item.sendBlock).toBe(1003n);
      c.moveTo(1003);
      vi.advanceTimersByTime(74);
      expect(s.sent).toHaveLength(0);
      c.moveTo(1003.25);
      vi.advanceTimersByTime(1);
      expect(s.sent).toHaveLength(1);
      expect(s.sent[0]?.at).toBeCloseTo(1003.25, 5);
      s.sent[0]!.resolve({ blockNumber: 1010n, step: stepForBlock(START, 1010n) });
      await settle();
      expect(q.getState().results[0]).toMatchObject({ ok: true, delta: 0 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-aims a note whose sub-block send time was already behind the clock', () => {
    vi.useFakeTimers();
    try {
      const c = positionClock(1000);
      const s = sender();
      s.bind(c.clock);
      const q = createAimQueue({ clock: c.clock, send: s.send, startBlock: () => START });
      q.aim({ track: 0, note: 0, step: 5 }); // mean 1: send at 1004.0
      c.moveTo(1006.2); // the tab slept past it
      vi.advanceTimersByTime(0);
      expect(s.sent).toHaveLength(0);
      expect(q.getState().items[0]).toMatchObject({ targetBlock: 1021n, status: 'waiting' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancel clears a pending sub-block timer', () => {
    vi.useFakeTimers();
    try {
      const c = positionClock(1000);
      const s = sender();
      s.bind(c.clock);
      const q = createAimQueue({ clock: c.clock, send: s.send, startBlock: () => START });
      q.recordInclusion(990, 992n); // mean 2
      const r = q.aim({ track: 0, note: 0, step: 9 }); // earliest 1002 → 1009, send on 1007.0 (a 0 ms timer)
      c.moveTo(1007);
      expect(r.ok && q.cancel(r.item.id)).toBe(true);
      vi.advanceTimersByTime(1000);
      expect(s.sent).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
