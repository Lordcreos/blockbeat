import { describe, expect, it } from 'vitest';
import { parseEther, type Address, type Hash, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { TRACK_META, type TrackId } from '@blockbeat/shared';
import type { CrowdHit, SessionInfo } from '../../src/lib/crowd/engine';
import { createKeystore } from '../../src/lib/crowd/keystore';
import { MAX_VISIBLE_PHONES, runVisibleCrowd, tileWindows, type Phone, type Rect, type VisibleDeps, type VisibleOptions } from '../../src/lib/crowd/ui/visible';

const BAR_MS = 60;

class FakePhone implements Phone {
  readonly key: Hex = generatePrivateKey();
  readonly address: Address = privateKeyToAccount(this.key).address;
  readonly calls: string[] = [];
  closed = false;
  constructor(readonly url: string, readonly rect: Rect, private readonly outcome: 'ready' | 'room-full', private readonly onAim: (phone: FakePhone, pad: number, step: number) => void) {}
  waitReady(): Promise<'ready' | 'room-full'> {
    this.calls.push('waitReady');
    return Promise.resolve(this.outcome);
  }
  skipTour(): Promise<boolean> {
    this.calls.push('skipTour');
    return Promise.resolve(true);
  }
  pickInstrument(label: string): Promise<void> {
    this.calls.push(`tab ${label}`);
    return Promise.resolve();
  }
  setMode(mode: 'tap' | 'aim'): Promise<void> {
    this.calls.push(`mode ${mode}`);
    return Promise.resolve();
  }
  tap(pad: number): Promise<void> {
    this.calls.push(`tap ${pad}`);
    this.onAim(this, pad, 0);
    return Promise.resolve();
  }
  aim(pad: number, step: number): Promise<void> {
    this.calls.push(`aim ${pad}@${step}`);
    this.onAim(this, pad, step);
    return Promise.resolve();
  }
  burnerKey(): Promise<Hex | null> {
    return Promise.resolve(this.key);
  }
  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
  screenshot(path: string): Promise<void> {
    this.calls.push(`shot ${path}`);
    return Promise.resolve();
  }
}

function memoryKeystore() {
  const files = new Map<string, string>();
  const store = createKeystore('/k', {
    mkdir: () => undefined,
    writeFile: (p, t) => void files.set(p, t),
    readFile: (p) => {
      const t = files.get(p);
      if (t === undefined) throw new Error(`ENOENT ${p}`);
      return t;
    },
    list: (dir) => [...files.keys()].filter((k) => k.startsWith(`${dir}/`)).map((k) => k.slice(dir.length + 1)),
    rename: (a, b) => {
      const t = files.get(a);
      if (t === undefined) throw new Error('ENOENT');
      files.delete(a);
      files.set(b, t);
    },
  });
  return { store, files };
}

function setup(over: { session?: SessionInfo; roomFull?: number[]; opts?: Partial<VisibleOptions> } = {}) {
  const phones: FakePhone[] = [];
  const hitCbs = new Set<(h: CrowdHit) => void>();
  const finalCbs = new Set<() => void>();
  let session: SessionInfo = over.session ?? { startBlock: 100n, finalized: false };
  let block = 1000n;
  let seq = 0;
  let sweeps = 0;
  const ks = memoryKeystore();
  const lines: string[] = [];
  const deps: VisibleDeps = {
    openPhone: (url, rect, index) => {
      const phone = new FakePhone(url, rect, over.roomFull?.includes(index) ? 'room-full' : 'ready', (p, _pad, step) => {
        // The phone lands the note on its aimed step a moment later.
        setTimeout(() => {
          block += 1n;
          seq += 1;
          const hit: CrowdHit = { txHash: `0x${seq.toString(16).padStart(64, '0')}` as Hash, blockNumber: block, logIndex: 0, step, track: 0 as TrackId, note: 0, player: p.address, on: true };
          for (const cb of hitCbs) cb(hit);
        }, 5);
      });
      phones.push(phone);
      return Promise.resolve(phone);
    },
    chain: {
      getSession: () => Promise.resolve(session),
      watchHits: (_id, cb) => {
        hitCbs.add(cb);
        return () => hitCbs.delete(cb);
      },
      watchFinalized: (_id, cb) => {
        finalCbs.add(cb);
        return () => finalCbs.delete(cb);
      },
    },
    sweep: () => {
      sweeps += 1;
      return Promise.resolve({ sweptWei: parseEther('0.5'), failed: [], skippedRuns: 0 });
    },
  };
  const opts: VisibleOptions = {
    chainId: 10143,
    contract: '0x1111111111111111111111111111111111111111',
    sessionId: 9n,
    players: 3,
    minutes: (BAR_MS * 8) / 60_000,
    baseUrl: 'https://abc.trycloudflare.com',
    seed: 4,
    maxWei: parseEther('1.5'),
    barMs: BAR_MS,
    joinWindowMs: BAR_MS * 2,
    funder: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
    keystore: ks.store,
    log: (l) => lines.push(l),
    ...over.opts,
  };
  return {
    phones,
    deps,
    opts,
    ks,
    lines,
    get sweeps() {
      return sweeps;
    },
    finalize: () => {
      session = { ...session, finalized: true };
      for (const cb of finalCbs) cb();
    },
  };
}

describe('tileWindows (W19 visible mode)', () => {
  it('tiles up to 6 phone windows on the screen without overlap, and refuses more', () => {
    const screen = { width: 1512, height: 982 };
    for (let n = 1; n <= MAX_VISIBLE_PHONES; n++) {
      const rects = tileWindows(n, screen);
      expect(rects).toHaveLength(n);
      for (const r of rects) {
        expect(r.x).toBeGreaterThanOrEqual(0);
        expect(r.y).toBeGreaterThanOrEqual(0);
        expect(r.x + r.width).toBeLessThanOrEqual(screen.width);
        expect(r.y + r.height).toBeLessThanOrEqual(screen.height);
      }
      for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
        const a = rects[i];
        const b = rects[j];
        if (!a || !b) continue;
        const overlap = a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
        expect(overlap, `${n}: ${i} and ${j}`).toBe(false);
      }
    }
    expect(() => tileWindows(7, screen)).toThrow(RangeError);
  });
});

describe('runVisibleCrowd (W19): headed phones that play through the real join UI', () => {
  it('refuses a finalized or unknown session before opening a window', async () => {
    const s = setup({ session: { startBlock: 100n, finalized: true } });
    await expect(runVisibleCrowd(s.opts, s.deps)).rejects.toThrow(/finalized/);
    const t = setup({ session: { startBlock: 0n, finalized: false } });
    await expect(runVisibleCrowd(t.opts, t.deps)).rejects.toThrow(/not found/);
    expect(s.phones).toHaveLength(0);
    expect(t.phones).toHaveLength(0);
  });

  it('refuses a plan whose notes would cost more than --max-mon', async () => {
    const s = setup({ opts: { maxWei: parseEther('0.001') } });
    await expect(runVisibleCrowd(s.opts, s.deps)).rejects.toThrow(/--max-mon/);
    expect(s.phones).toHaveLength(0);
  });

  it('Tap now by default (the user\'s ask): picks Tap now, then taps its pads at its step times; no aiming', async () => {
    const s = setup();
    const result = await runVisibleCrowd(s.opts, s.deps);
    for (const phone of s.phones) {
      expect(phone.calls).toContain('mode tap');
      expect(phone.calls.some((c) => c.startsWith('aim'))).toBe(false);
    }
    expect(result.playMode).toBe('tap');
    expect(result.aimed).toBeGreaterThan(0);
    expect(result.landed).toBe(result.aimed);
    expect(s.phones.flatMap((p) => p.calls).filter((c) => c.startsWith('tap')).length).toBe(result.aimed);
  }, 10_000);

  it('--play aim: opens one window per player on the join URL, waits for the drip, skips the tour, picks its instrument and aims pads on steps', async () => {
    const s = setup({ opts: { playMode: 'aim' } });
    const result = await runVisibleCrowd(s.opts, s.deps);
    expect(s.phones).toHaveLength(3);
    for (const [i, phone] of s.phones.entries()) {
      expect(phone.url).toBe('https://abc.trycloudflare.com/join/9');
      const persona = result.personas[i];
      if (!persona) throw new Error('persona');
      expect(phone.calls.slice(0, 4)).toEqual(['waitReady', 'skipTour', `tab ${TRACK_META[persona.track]?.label}`, 'mode aim']);
      expect(phone.closed).toBe(true);
    }
    expect(result.aimed).toBeGreaterThan(0);
    expect(result.landed).toBe(result.aimed);
    expect(result.onStep).toBe(result.landed);
    // Every phone's key is saved as soon as it is funded, then swept at the end.
    const file = [...s.ks.files.keys()][0] ?? '';
    const run = JSON.parse(s.ks.files.get(file) ?? '{}') as { players: Array<{ address: string }> };
    expect(run.players.map((p) => p.address)).toEqual(s.phones.map((p) => p.address));
    expect(s.sweeps).toBe(1);
    expect(s.lines.filter((l) => l.startsWith('crowd | bar ')).length).toBeGreaterThanOrEqual(4);
  }, 10_000);

  it('takes one snapshot of every ready phone at the chosen bar (evidence without screen recording)', async () => {
    const s = setup({ opts: { snapshotAtBar: 3, snapshotDir: '/tmp/shots' } });
    await runVisibleCrowd(s.opts, s.deps);
    for (const [i, phone] of s.phones.entries()) expect(phone.calls.filter((c) => c.startsWith('shot'))).toEqual([`shot /tmp/shots/phone-${i + 1}.png`]);
  }, 10_000);

  it('saves each burner key BEFORE waiting for the drip, so a phone that never shows ready is still swept (regression: 0.6 MON lost on testnet)', async () => {
    const s = setup();
    const savedAtWait: number[] = [];
    const open = s.deps.openPhone;
    s.deps.openPhone = async (url, rect, index) => {
      const phone = (await open(url, rect, index)) as FakePhone;
      const wait = phone.waitReady.bind(phone);
      phone.waitReady = () => {
        const file = [...s.ks.files.keys()][0] ?? '';
        const run = JSON.parse(s.ks.files.get(file) ?? '{"players":[]}') as { players: Array<{ address: string }> };
        savedAtWait.push(run.players.filter((p) => p.address === phone.address).length);
        return index === 0 ? Promise.reject(new Error('not funded within 90000 ms')) : wait();
      };
      return phone;
    };
    const result = await runVisibleCrowd(s.opts, s.deps);
    expect(savedAtWait).toEqual([1, 1, 1]);
    expect(result.ready).toBe(2);
    // The phone that never showed ready is in the keystore and so gets swept.
    const file = [...s.ks.files.keys()][0] ?? '';
    const run = JSON.parse(s.ks.files.get(file) ?? '{}') as { players: Array<{ address: string }> };
    expect(run.players.map((p) => p.address)).toContain(s.phones[0]?.address);
    expect(s.phones[0]?.closed).toBe(true);
  }, 10_000);

  it('a phone turned away by a full room is closed and sits out', async () => {
    const s = setup({ roomFull: [1] });
    const result = await runVisibleCrowd(s.opts, s.deps);
    expect(result.roomFull).toBe(1);
    expect(s.phones[1]?.calls).toEqual(['waitReady']);
    expect(s.phones[1]?.closed).toBe(true);
  }, 10_000);

  it('ends by itself when every phone was turned away (the play clock never starts)', async () => {
    const s = setup({ roomFull: [0, 1, 2] });
    const result = await runVisibleCrowd(s.opts, s.deps);
    expect(result.ready).toBe(0);
    expect(result.roomFull).toBe(3);
    expect(result.stopReason).toBe('done');
  }, 10_000);

  it('stops aiming once the session is finalized, closes every window and sweeps', async () => {
    const s = setup({ opts: { minutes: (BAR_MS * 40) / 60_000 } });
    const run = runVisibleCrowd(s.opts, s.deps);
    setTimeout(() => s.finalize(), BAR_MS * 4);
    const result = await run;
    expect(result.stopReason).toBe('finalized');
    const tapsAtStop = s.phones.map((p) => p.calls.filter((c) => c.startsWith('tap')).length);
    await new Promise((r) => setTimeout(r, BAR_MS * 3));
    expect(s.phones.map((p) => p.calls.filter((c) => c.startsWith('tap')).length)).toEqual(tapsAtStop);
    expect(s.phones.every((p) => p.closed)).toBe(true);
    expect(s.sweeps).toBe(1);
  }, 10_000);

  it('stops on the abort signal (SIGINT)', async () => {
    const ac = new AbortController();
    const s = setup({ opts: { minutes: 1, signal: ac.signal } });
    setTimeout(() => ac.abort(), BAR_MS * 3);
    const result = await runVisibleCrowd(s.opts, s.deps);
    expect(result.stopReason).toBe('stopped');
    expect(s.phones.every((p) => p.closed)).toBe(true);
  }, 10_000);
});
