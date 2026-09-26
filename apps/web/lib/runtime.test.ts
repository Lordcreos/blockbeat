import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HIT_GAS_LIMIT, HIT_GAS_LIMIT_FIRST } from '@blockbeat/shared';
import { createHitGasPolicy } from './hitGas';
import { FUNDS_SETTLE_MS, createRuntime } from './runtime';
import { createSimulator } from './mock/simulator';
import type { EventSource } from './eventFeed';
import { loadOrCreateBurner } from './burner';
import { revertErrorName } from './revert';

describe('createRuntime (mock mode)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('wires the simulator into the clock, the feed and the hit sender', async () => {
    const simulator = createSimulator({ startBlock: 100n });
    const burner = loadOrCreateBurner({ storage: null });
    const rt = createRuntime({ mode: 'mock', simulator, burner });
    expect(rt.mode).toBe('mock');
    expect(rt.clock.getState().source).toBe('mock');
    expect(rt.burner().address).toBe(burner.address);

    rt.clock.start();
    const { feed, release } = rt.acquireFeed(1n);
    await feed.start();
    const held = rt.acquireHitSender(1n);
    const p = held.sender.send(1n, 0, 0);
    await vi.advanceTimersByTimeAsync(300);
    const receipt = await p;
    expect(receipt.blockNumber).toBe(101n);
    expect(receipt.on).toBe(true);
    expect(feed.getState().hitCount).toBe(1);
    expect(feed.getState().uniquePlayers).toBe(1);
    expect(rt.clock.getState().currentBlock).toBe(101n);
    release();
    held.release();
    rt.clock.stop();
  });

  it('memoises feeds per session and stops them on the last release', async () => {
    const rt = createRuntime({ mode: 'mock', simulator: createSimulator(), burner: loadOrCreateBurner({ storage: null }) });
    const a = rt.acquireFeed(5n);
    const b = rt.acquireFeed(5n);
    expect(a.feed).toBe(b.feed);
    expect(rt.acquireFeed(6n).feed).not.toBe(a.feed);
    await a.feed.start();
    a.release();
    expect(a.feed.getState().connected).toBe(true);
    b.release();
    expect(a.feed.getState().connected).toBe(false);
    // A fresh acquire after full release yields a new feed.
    expect(rt.acquireFeed(5n).feed).not.toBe(a.feed);
  });

  it("W13: a phone (hit sender) feed reads its own live window; a 'full' feed reads everyone's", async () => {
    const simulator = createSimulator({ startBlock: 100n });
    const burner = loadOrCreateBurner({ storage: null });
    const rt = createRuntime({ mode: 'mock', simulator, burner });
    const readHits = vi.spyOn(simulator.eventSource as Required<EventSource>, 'readHits');
    const phone = rt.acquireHitSender(1n);
    const phoneFeed = rt.acquireFeed(1n);
    await phoneFeed.feed.start();
    await vi.advanceTimersByTimeAsync(1_600);
    expect(readHits).toHaveBeenCalled();
    expect(readHits.mock.calls.every(([q]) => q.player === burner.address)).toBe(true);
    phone.release();
    phoneFeed.release();

    readHits.mockClear();
    const stage = rt.acquireFeed(2n, { history: 'full' });
    await stage.feed.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(readHits.mock.calls.every(([q]) => q.player === undefined)).toBe(true);
    expect(stage.feed.getState().historyReady).toBe(true);
    stage.release();
  });

  it('memoises the hit sender per session and releases its feed with the last holder', async () => {
    const rt = createRuntime({ mode: 'mock', simulator: createSimulator(), burner: loadOrCreateBurner({ storage: null }) });
    const a = rt.acquireHitSender(1n);
    const b = rt.acquireHitSender(1n);
    expect(a.sender).toBe(b.sender);
    expect(rt.acquireHitSender(2n).sender).not.toBe(a.sender);
    const feed = rt.acquireFeed(1n);
    await feed.feed.start();
    feed.release(); // the senders still hold it
    expect(feed.feed.getState().connected).toBe(true);
    a.release();
    a.release(); // double release is harmless
    expect(feed.feed.getState().connected).toBe(true);
    b.release();
    expect(feed.feed.getState().connected).toBe(false);
    expect(rt.acquireHitSender(1n).sender).not.toBe(a.sender);
  });
});

describe('createRuntime (chain mode)', () => {
  it('builds chain-backed sources without opening a connection', () => {
    const rt = createRuntime({
      mode: 'chain',
      address: '0x00000000000000000000000000000000000000aa',
      rpc: { http: 'https://rpc.invalid', ws: 'wss://ws.invalid' },
      burner: loadOrCreateBurner({ storage: null }),
    });
    expect(rt.mode).toBe('chain');
    expect(rt.simulator).toBeNull();
    expect(rt.clock.getState().source).toBe('ws');
  });

  it('keys the burner gas-tier flags by the runtime chain id (review M3)', () => {
    const burner = loadOrCreateBurner({ storage: null });
    const storage = new Map<string, string>();
    const storageLike = { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => void storage.set(k, v), removeItem: (k: string) => void storage.delete(k) };
    createHitGasPolicy({ address: burner.address, chainId: 31337, storage: storageLike }).markConfirmed(1n);
    const rt = createRuntime({
      mode: 'chain',
      address: '0x00000000000000000000000000000000000000aa',
      rpc: { http: 'https://rpc.invalid', ws: 'wss://ws.invalid' },
      burner,
      chainId: 10143,
      gasStorage: storageLike,
    });
    expect(rt.hitGasFor(1n)).toBe(HIT_GAS_LIMIT_FIRST);
  });

  it('waitForFunds polls the balance from the phone until the drip is spendable (review C3)', async () => {
    vi.useFakeTimers();
    try {
      const balances = [0n, 0n, 300_000_000_000_000_000n];
      const getBalance = vi.fn(async () => balances.shift() ?? 300_000_000_000_000_000n);
      const rt = createRuntime({
        mode: 'chain',
        address: '0x00000000000000000000000000000000000000aa',
        rpc: { http: 'https://rpc.invalid', ws: 'wss://ws.invalid' },
        burner: loadOrCreateBurner({ storage: null }),
        balances: { getBalance },
      });
      const p = rt.waitForFunds('0x1111111111111111111111111111111111111111', { timeoutMs: 5_000, intervalMs: 400 });
      await vi.advanceTimersByTimeAsync(0);
      expect(getBalance).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(800);
      expect(getBalance).toHaveBeenCalledTimes(3);
      // W11: Monad checks a sender's balance at consensus against state 3 blocks behind, so a
      // tap right after the drip lands is rejected ("Signer had insufficient balance").
      let done = false;
      void p.then(() => (done = true));
      await vi.advanceTimersByTimeAsync(FUNDS_SETTLE_MS - 100);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(100);
      expect(await p).toBe(true);
      expect(FUNDS_SETTLE_MS).toBeGreaterThanOrEqual(1_200);
      expect(getBalance).toHaveBeenCalledWith({ address: '0x1111111111111111111111111111111111111111' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('waitForFunds gives up after the timeout and reports a failed read instead of hanging', async () => {
    vi.useFakeTimers();
    try {
      const rt = createRuntime({
        mode: 'chain',
        address: '0x00000000000000000000000000000000000000aa',
        rpc: { http: 'https://rpc.invalid', ws: 'wss://ws.invalid' },
        burner: loadOrCreateBurner({ storage: null }),
        balances: { getBalance: vi.fn(async () => 0n) },
      });
      const slow = rt.waitForFunds('0x1111111111111111111111111111111111111111', { timeoutMs: 1_000, intervalMs: 400 });
      await vi.advanceTimersByTimeAsync(1_500);
      expect(await slow).toBe(false);
      const broken = createRuntime({
        mode: 'chain',
        address: '0x00000000000000000000000000000000000000aa',
        rpc: { http: 'https://rpc.invalid', ws: 'wss://ws.invalid' },
        burner: loadOrCreateBurner({ storage: null }),
        balances: { getBalance: vi.fn(async () => { throw new Error('429'); }) },
      });
      await expect(broken.waitForFunds('0x1111111111111111111111111111111111111111', { timeoutMs: 1_000, intervalMs: 400 })).rejects.toThrow(/429/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('waitForFunds with `above` waits for a top-up to raise the balance past the old one (W12)', async () => {
    vi.useFakeTimers();
    try {
      const balances = [4_000_000_000_000_000n, 4_000_000_000_000_000n, 304_000_000_000_000_000n];
      const getBalance = vi.fn(async () => balances.shift() ?? 304_000_000_000_000_000n);
      const rt = createRuntime({
        mode: 'chain',
        address: '0x00000000000000000000000000000000000000aa',
        rpc: { http: 'https://rpc.invalid', ws: 'wss://ws.invalid' },
        burner: loadOrCreateBurner({ storage: null }),
        balances: { getBalance },
      });
      const p = rt.waitForFunds('0x1111111111111111111111111111111111111111', { timeoutMs: 5_000, intervalMs: 400, above: 4_000_000_000_000_000n });
      await vi.advanceTimersByTimeAsync(800 + FUNDS_SETTLE_MS);
      expect(await p).toBe(true);
      expect(getBalance).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('readBalance reads the chain balance; creditDrip is a no-op on chain (W12)', async () => {
    const getBalance = vi.fn(async () => 123n);
    const rt = createRuntime({
      mode: 'chain',
      address: '0x00000000000000000000000000000000000000aa',
      rpc: { http: 'https://rpc.invalid', ws: 'wss://ws.invalid' },
      burner: loadOrCreateBurner({ storage: null }),
      balances: { getBalance },
    });
    expect(await rt.readBalance('0x1111111111111111111111111111111111111111')).toBe(123n);
    rt.creditDrip('0x1111111111111111111111111111111111111111', 5n);
    expect(getBalance).toHaveBeenCalledTimes(1);
  });

  it('hitGasFor in mock mode follows the simulator tier, like the chain policy does (W12)', async () => {
    vi.useFakeTimers();
    try {
      const simulator = createSimulator();
      const burner = loadOrCreateBurner({ storage: null });
      const rt = createRuntime({ mode: 'mock', simulator, burner });
      expect(rt.hitGasFor(1n)).toBe(HIT_GAS_LIMIT_FIRST);
      await simulator.hitWriterFor(burner.address)({ sessionId: 1n, track: 0, note: 0 });
      expect(rt.hitGasFor(1n)).toBe(HIT_GAS_LIMIT);
      expect(rt.hitGasFor(2n)).toBe(HIT_GAS_LIMIT_FIRST);
      simulator.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('readBalance in mock mode reports the simulator balance a drip credited (W12)', async () => {
    const simulator = createSimulator();
    const burner = loadOrCreateBurner({ storage: null });
    const rt = createRuntime({ mode: 'mock', simulator, burner });
    expect(await rt.readBalance(burner.address)).toBeNull();
    rt.creditDrip(burner.address, 300n);
    expect(await rt.readBalance(burner.address)).toBe(300n);
    expect(await rt.waitForFunds(burner.address, { above: 0n })).toBe(true);
  });

  it('waitForFunds resolves immediately in mock mode', async () => {
    const rt = createRuntime({ mode: 'mock', simulator: createSimulator(), burner: loadOrCreateBurner({ storage: null }) });
    expect(await rt.waitForFunds('0x1111111111111111111111111111111111111111')).toBe(true);
  });
});

describe('createRuntime tips (mock mode)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('memoises the tip sender per session and tips through the simulator', async () => {
    const sim = createSimulator({ startBlock: 100n });
    const player = loadOrCreateBurner({ storage: null });
    const tipper = loadOrCreateBurner({ storage: null });
    const rt = createRuntime({ mode: 'mock', simulator: sim, burner: player, tipper });
    const a = rt.acquireTipSender(1n);
    const b = rt.acquireTipSender(1n);
    expect(a.sender).toBe(b.sender);
    expect(rt.acquireTipSender(2n).sender).not.toBe(a.sender);
    const hit = rt.acquireHitSender(1n);
    const landed = hit.sender.send(1n, 0, 0);
    await vi.advanceTimersByTimeAsync(300);
    await landed;
    const p = a.sender.send(1n);
    await vi.advanceTimersByTimeAsync(300);
    const receipt = await p;
    expect(receipt.blockNumber).toBe(102n);
    expect(receipt.amountWei).toBe(5_000_000_000_000_000n);
    // W21b: tips come from the tip page's own burner, never the player's.
    expect(sim.summary(1n)?.tips.map((t) => t.from)).toEqual([tipper.address]);
    expect(rt.tipper().address).toBe(tipper.address);
    a.release();
    a.release();
    b.release();
    expect(rt.acquireTipSender(1n).sender).not.toBe(a.sender);
    hit.release();
  });
});

describe('createRuntime tipReadyAt (W12)', () => {
  it('is null in mock mode (the simulator has no reserve rule) and for a quiet burner on chain', () => {
    const mock = createRuntime({ mode: 'mock', simulator: createSimulator(), burner: loadOrCreateBurner({ storage: null }) });
    expect(mock.tipReadyAt()).toBeNull();
    const chain = createRuntime({
      mode: 'chain',
      address: '0x00000000000000000000000000000000000000aa',
      rpc: { http: 'https://rpc.invalid', ws: 'wss://ws.invalid' },
      burner: loadOrCreateBurner({ storage: null }),
      balances: { getBalance: async () => 0n },
    });
    expect(chain.tipReadyAt()).toBeNull();
  });
});


describe('createRuntime W21b: claims and the mock finalize', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a player claims its share after the mock finalize; the host share is pulled apart', async () => {
    const sim = createSimulator({ startBlock: 100n });
    const player = loadOrCreateBurner({ storage: null });
    const rt = createRuntime({ mode: 'mock', simulator: sim, burner: player, tipper: loadOrCreateBurner({ storage: null }) });
    const hit = rt.acquireHitSender(3n);
    const landed = hit.sender.send(3n, 0, 0);
    await vi.advanceTimersByTimeAsync(300);
    await landed;
    const tip = rt.acquireTipSender(3n);
    const tipped = tip.sender.send(3n, 10_000_000_000_000_000n);
    await vi.advanceTimersByTimeAsync(300);
    await tipped;
    expect(await rt.readClaimable(3n, player.address)).toBe(0n);
    expect(await rt.readHostClaimable(3n)).toBe(2_000_000_000_000_000n);
    expect(rt.mockClaimHost(3n)).toBe(2_000_000_000_000_000n);
    rt.mockFinalize(3n, 3n);
    expect(await rt.readClaimable(3n, player.address)).toBe(8_000_000_000_000_000n);
    expect(await rt.claimShare(3n)).toEqual({ txHash: null, amountWei: 8_000_000_000_000_000n });
    await expect(rt.claimShare(3n)).rejects.toSatisfy((e: unknown) => revertErrorName(e) === 'NothingToClaim');
    hit.release();
    tip.release();
  });

  it('mockFinalize and mockClaimHost do nothing on chain', () => {
    const chain = createRuntime({
      mode: 'chain',
      address: '0x00000000000000000000000000000000000000aa',
      rpc: { http: 'https://rpc.invalid', ws: 'wss://ws.invalid' },
      burner: loadOrCreateBurner({ storage: null }),
      balances: { getBalance: async () => 0n },
    });
    expect(() => chain.mockFinalize(1n, 1n)).not.toThrow();
    expect(chain.mockClaimHost(1n)).toBeNull();
  });
});
