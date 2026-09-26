import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { monadTestnet } from '@blockbeat/shared';
import { parseEther, type Account, type Chain, type Hash, type Transport, type WalletClient } from 'viem';
import { BLOCK_MS, MONAD_RESERVE_BALANCE_WEI, RESERVE_WINDOW_BLOCKS } from '@blockbeat/shared';
import { DRIP_GAS_LIMIT, createChainDripSender } from './sender';

/**
 * A chain that mines a block every BLOCK_MS and applies Monad's reserve-balance rule: a
 * value transfer that leaves the sender below 10 MON reverts unless the sender had no other
 * transaction in the past RESERVE_WINDOW_BLOCKS blocks (W11 saw 4 of 5 back-to-back reverts).
 */
function reserveChain(startBalance: bigint) {
  let head = 1_000n;
  let balance = startBalance;
  const included: Array<{ block: bigint; reverted: boolean }> = [];
  const pendingTx: Array<{ value: bigint }> = [];
  const timer = setInterval(() => {
    head += 1n;
    for (const tx of pendingTx.splice(0)) {
      const last = included.at(-1);
      const recent = last !== undefined && head - last.block <= BigInt(RESERVE_WINDOW_BLOCKS);
      const reverted = balance - tx.value < MONAD_RESERVE_BALANCE_WEI && recent;
      balance -= DRIP_GAS_LIMIT * 100_000_000_000n + (reverted ? 0n : tx.value);
      included.push({ block: head, reverted });
    }
  }, BLOCK_MS);
  const sendTransaction = vi.fn(async (args: { value: bigint }): Promise<Hash> => {
    pendingTx.push({ value: args.value });
    return `0x${(included.length + pendingTx.length).toString(16).padStart(64, '0')}` as Hash;
  });
  const wallet = { sendTransaction, chain: monadTestnet } as unknown as WalletClient<Transport, Chain, Account>;
  const pacing = {
    getBalance: vi.fn(async () => balance),
    getBlockNumber: vi.fn(async () => head),
  };
  return { wallet, pacing, included, stop: () => clearInterval(timer) };
}

const addr = (i: number): `0x${string}` => `0x${(i + 1).toString(16).padStart(40, '0')}`;

describe('drip sender below the Monad reserve balance (W11)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('spaces 20 concurrent drips from a 4 MON wallet so none reverts, and reports the backlog', async () => {
    const chain = reserveChain(parseEther('4'));
    const sender = createChainDripSender({ wallet: chain.wallet, pacing: chain.pacing });
    const hashes = Array.from({ length: 20 }, (_, i) => sender.send(addr(i)));
    expect(sender.backlog?.().ahead).toBe(20);
    await vi.advanceTimersByTimeAsync(60_000);
    await Promise.all(hashes);
    chain.stop();
    expect(chain.included).toHaveLength(20);
    expect(chain.included.filter((t) => t.reverted)).toHaveLength(0);
    for (let i = 1; i < chain.included.length; i++) {
      const gap = (chain.included[i]?.block ?? 0n) - (chain.included[i - 1]?.block ?? 0n);
      expect(gap).toBeGreaterThan(BigInt(RESERVE_WINDOW_BLOCKS));
    }
    expect(sender.backlog?.().ahead).toBe(0);
  });

  it('the unpaced sender reproduces the testnet failure', async () => {
    const chain = reserveChain(parseEther('4'));
    const sender = createChainDripSender({ wallet: chain.wallet });
    await Promise.all(Array.from({ length: 5 }, (_, i) => sender.send(addr(i))));
    await vi.advanceTimersByTimeAsync(3_000);
    chain.stop();
    expect(chain.included.filter((t) => t.reverted)).toHaveLength(4);
  });

  it('sends back-to-back while the balance stays above reserve + amount', async () => {
    const chain = reserveChain(parseEther('30'));
    const sender = createChainDripSender({ wallet: chain.wallet, pacing: chain.pacing });
    const all = Promise.all(Array.from({ length: 5 }, (_, i) => sender.send(addr(i))));
    await vi.advanceTimersByTimeAsync(50);
    await all;
    expect(chain.wallet.sendTransaction).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(BLOCK_MS * 2);
    chain.stop();
    expect(chain.included.filter((t) => t.reverted)).toHaveLength(0);
    expect(sender.backlog?.().etaMs).toBe(0);
  });

  it('says so in the log when a stalled head makes it give up on pacing (review of W11)', async () => {
    const chain = reserveChain(parseEther('4'));
    chain.pacing.getBlockNumber.mockResolvedValue(5n); // the head never moves
    const log = vi.fn();
    const sender = createChainDripSender({ wallet: chain.wallet, pacing: chain.pacing, log });
    const all = Promise.all([sender.send(addr(0)), sender.send(addr(1))]);
    await vi.advanceTimersByTimeAsync(20_000);
    await all;
    chain.stop();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toMatch(/pacing gave up/);
  });

  it('falls back to a timer when heads cannot be read', async () => {
    const chain = reserveChain(parseEther('4'));
    chain.pacing.getBlockNumber.mockRejectedValue(new Error('rpc down'));
    const sender = createChainDripSender({ wallet: chain.wallet, pacing: chain.pacing });
    const all = Promise.all(Array.from({ length: 4 }, (_, i) => sender.send(addr(i))));
    await vi.advanceTimersByTimeAsync(20_000);
    await all;
    chain.stop();
    expect(chain.included.filter((t) => t.reverted)).toHaveLength(0);
  });
});
