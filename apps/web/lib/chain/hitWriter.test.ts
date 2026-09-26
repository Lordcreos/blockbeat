import { describe, expect, it, vi } from 'vitest';
import { createWalletClient, custom } from 'viem';
import { nonceManager, privateKeyToAccount } from 'viem/accounts';
import { monadTestnet } from '@blockbeat/shared';
import type { Account, Address, Chain, Hash, Transport, WalletClient } from 'viem';
import { HIT_GAS_LIMIT, HIT_GAS_LIMIT_FIRST, HIT_MAX_FEE_PER_GAS, HIT_MAX_PRIORITY_FEE_PER_GAS, blockbeatAbi } from '@blockbeat/shared';
import { createHitGasPolicy } from '../hitGas';
import { DEFAULT_HIT_TIMEOUT_MS } from '../hitSender';
import { HIT_RECEIPT_TIMEOUT_MS, createChainHitWriter, type HitReceiptSource } from './hitWriter';

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** Receipts that resolve only when the test says so. */
function manualReceipts() {
  const pending: Array<{ hash: Hash; resolve: (r: { status: 'success' | 'reverted'; gasUsed: bigint }) => void; reject: (e: Error) => void }> = [];
  const source: HitReceiptSource = {
    waitForTransactionReceipt: ({ hash }) => new Promise((resolve, reject) => pending.push({ hash, resolve, reject })),
  };
  return { source, pending };
}

const ADDR = '0x00000000000000000000000000000000000000aa' as Address;
const PLAYER = '0x1111111111111111111111111111111111111111' as Address;
const TX = `0x${'ab'.repeat(32)}` as Hash;
const TX2 = `0x${'cd'.repeat(32)}` as Hash;

function receipts(outcomes: Array<{ status: 'success' | 'reverted'; gasUsed: bigint }>): HitReceiptSource & { calls: Hash[] } {
  const calls: Hash[] = [];
  return {
    calls,
    async waitForTransactionReceipt({ hash }) {
      calls.push(hash);
      const next = outcomes.shift();
      if (!next) throw new Error('no receipt scripted');
      return next;
    },
  };
}

/** W16: a real viem wallet on a transport that records every RPC method (no node). */
function recordingWallet() {
  const methods: string[] = [];
  const transport = custom({
    async request({ method }: { method: string }) {
      methods.push(method);
      switch (method) {
        case 'eth_chainId':
          return '0x279f';
        case 'eth_getTransactionCount':
          return '0x0';
        case 'eth_sendRawTransaction':
          return `0x${'ab'.repeat(32)}`;
        case 'eth_getBlockByNumber':
          return { baseFeePerGas: '0x174876e800', number: '0x1', hash: `0x${'ab'.repeat(32)}`, timestamp: '0x1', transactions: [] };
        case 'eth_maxPriorityFeePerGas':
          return '0x77359400';
        default:
          throw new Error(`${method} is not available`);
      }
    },
  });
  const wallet = createWalletClient({ account: privateKeyToAccount(`0x${'11'.repeat(32)}`, { nonceManager }), chain: monadTestnet, transport });
  return { methods, wallet };
}

describe('createChainHitWriter', () => {
  it('calls writeContract with the fixed gas limit and fixed fees; never estimates gas or reads fee data (review H7)', async () => {
    const writeContract = vi.fn(async () => TX);
    const estimateGas = vi.fn();
    const estimateContractGas = vi.fn();
    const estimateFeesPerGas = vi.fn();
    const wallet = { writeContract, estimateGas, estimateContractGas, estimateFeesPerGas, chain: monadTestnet } as unknown as WalletClient<Transport, Chain, Account>;
    const write = createChainHitWriter({ wallet, address: ADDR });
    const hash = await write({ sessionId: 1n, track: 2, note: 3 });
    expect(hash).toBe(TX);
    expect(writeContract).toHaveBeenCalledTimes(1);
    const call = writeContract.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(call[0]).toMatchObject({
      address: ADDR,
      functionName: 'hit',
      args: [1n, 2, 3],
      gas: HIT_GAS_LIMIT_FIRST,
      maxFeePerGas: HIT_MAX_FEE_PER_GAS,
      maxPriorityFeePerGas: HIT_MAX_PRIORITY_FEE_PER_GAS,
    });
    expect(call[0]?.abi).toBe(blockbeatAbi);
    expect(HIT_MAX_FEE_PER_GAS).toBe(150_000_000_000n);
    expect(HIT_MAX_PRIORITY_FEE_PER_GAS).toBe(2_000_000_000n);
    expect(estimateGas).not.toHaveBeenCalled();
    expect(estimateContractGas).not.toHaveBeenCalled();
    expect(estimateFeesPerGas).not.toHaveBeenCalled();
  });

  it('returns the hash before the receipt and marks the session confirmed in the background (review H7)', async () => {
    const writeContract = vi.fn(async () => TX);
    const wallet = { writeContract, chain: monadTestnet } as unknown as WalletClient<Transport, Chain, Account>;
    const policy = createHitGasPolicy({ address: PLAYER, chainId: 1, storage: null });
    const r = manualReceipts();
    const write = createChainHitWriter({ wallet, address: ADDR, gasPolicy: policy, receipts: r.source });
    const hash = await write({ sessionId: 1n, track: 0, note: 0 });
    expect(hash).toBe(TX);
    expect(r.pending).toHaveLength(1);
    expect(policy.gasFor(1n)).toBe(HIT_GAS_LIMIT_FIRST);
    r.pending[0]?.resolve({ status: 'success', gasUsed: 140_000n });
    await tick();
    expect(policy.gasFor(1n)).toBe(HIT_GAS_LIMIT);
  });

  it('reports a revert through onReverted without retrying when it is not out of gas', async () => {
    const writeContract = vi.fn(async () => TX);
    const wallet = { writeContract, chain: monadTestnet } as unknown as WalletClient<Transport, Chain, Account>;
    const policy = createHitGasPolicy({ address: PLAYER, chainId: 1, storage: null });
    const r = manualReceipts();
    const onReverted = vi.fn();
    const write = createChainHitWriter({ wallet, address: ADDR, gasPolicy: policy, receipts: r.source });
    await write({ sessionId: 1n, track: 0, note: 0 }, { onReverted });
    r.pending[0]?.resolve({ status: 'reverted', gasUsed: 30_000n });
    await tick();
    expect(onReverted).toHaveBeenCalledWith(TX, expect.stringMatching(/reverted/));
    expect(writeContract).toHaveBeenCalledTimes(1);
    expect(policy.gasFor(1n)).toBe(HIT_GAS_LIMIT_FIRST);
  });

  it('warns (never swallows) when the background receipt never arrives', async () => {
    const wallet = { writeContract: vi.fn(async () => TX), chain: monadTestnet } as unknown as WalletClient<Transport, Chain, Account>;
    const r = manualReceipts();
    const warn = vi.fn();
    const write = createChainHitWriter({ wallet, address: ADDR, receipts: r.source, warn });
    await write({ sessionId: 1n, track: 0, note: 0 });
    r.pending[0]?.reject(new Error('timed out'));
    await tick();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('timed out'));
  });

  it('bounds the receipt wait so the sender deadline covers a send, a receipt, a retry and its receipt (review M3)', () => {
    expect(DEFAULT_HIT_TIMEOUT_MS).toBeGreaterThanOrEqual(2 * HIT_RECEIPT_TIMEOUT_MS + 3_000);
  });

  it('propagates send errors', async () => {
    const wallet = {
      writeContract: vi.fn(async () => {
        throw new Error('nonce too low');
      }),
      chain: monadTestnet,
    } as unknown as WalletClient<Transport, Chain, Account>;
    const write = createChainHitWriter({ wallet, address: ADDR });
    await expect(write({ sessionId: 1n, track: 0, note: 0 })).rejects.toThrow('nonce too low');
  });

  it('tiers the gas: first-hit limit until the policy sees a confirmed hit, then the lower limit', async () => {
    const writeContract = vi.fn(async () => TX);
    const wallet = { writeContract, chain: monadTestnet } as unknown as WalletClient<Transport, Chain, Account>;
    const policy = createHitGasPolicy({ address: PLAYER, chainId: 1, storage: null });
    const r = receipts([
      { status: 'success', gasUsed: 140_000n },
      { status: 'success', gasUsed: 61_000n },
    ]);
    const write = createChainHitWriter({ wallet, address: ADDR, gasPolicy: policy, receipts: r });
    await write({ sessionId: 1n, track: 0, note: 0 });
    await tick(); // the first receipt is processed off the send path
    await write({ sessionId: 1n, track: 0, note: 1 });
    const gases = writeContract.mock.calls.map((c) => (c as unknown as [{ gas: bigint }])[0].gas);
    expect(gases).toEqual([HIT_GAS_LIMIT_FIRST, HIT_GAS_LIMIT]);
    expect(policy.gasFor(1n)).toBe(HIT_GAS_LIMIT);
  });

  it('retries once with the first-hit limit when the low-limit send runs out of gas, reporting the new hash through onRetry', async () => {
    const writeContract = vi.fn<() => Promise<Hash>>().mockResolvedValueOnce(TX).mockResolvedValueOnce(TX2);
    const wallet = { writeContract, chain: monadTestnet } as unknown as WalletClient<Transport, Chain, Account>;
    const policy = createHitGasPolicy({ address: PLAYER, chainId: 1, storage: null });
    policy.markConfirmed(1n); // stale flag: the chain state says this is still a first hit
    const r = receipts([
      { status: 'reverted', gasUsed: HIT_GAS_LIMIT },
      { status: 'success', gasUsed: 140_000n },
    ]);
    const onRetry = vi.fn();
    const onReverted = vi.fn();
    const write = createChainHitWriter({ wallet, address: ADDR, gasPolicy: policy, receipts: r });
    const hash = await write({ sessionId: 1n, track: 0, note: 0 }, { onRetry, onReverted });
    expect(hash).toBe(TX);
    await tick();
    await tick();
    expect(onRetry).toHaveBeenCalledWith(TX2);
    expect(onReverted).not.toHaveBeenCalled();
    const gases = writeContract.mock.calls.map((c) => (c as unknown as [{ gas: bigint }])[0].gas);
    expect(gases).toEqual([HIT_GAS_LIMIT, HIT_GAS_LIMIT_FIRST]);
    expect(r.calls).toEqual([TX, TX2]);
    expect(policy.gasFor(1n)).toBe(HIT_GAS_LIMIT);
  });

  it('reports a retried hit that reverts again through onReverted', async () => {
    const writeContract = vi.fn<() => Promise<Hash>>().mockResolvedValueOnce(TX).mockResolvedValueOnce(TX2);
    const wallet = { writeContract, chain: monadTestnet } as unknown as WalletClient<Transport, Chain, Account>;
    const policy = createHitGasPolicy({ address: PLAYER, chainId: 1, storage: null });
    policy.markConfirmed(1n);
    const r = receipts([
      { status: 'reverted', gasUsed: HIT_GAS_LIMIT },
      { status: 'reverted', gasUsed: 20_000n },
    ]);
    const onReverted = vi.fn();
    const write = createChainHitWriter({ wallet, address: ADDR, gasPolicy: policy, receipts: r });
    await write({ sessionId: 1n, track: 0, note: 0 }, { onReverted });
    await tick();
    await tick();
    expect(onReverted).toHaveBeenCalledWith(TX2, expect.stringMatching(/twice/));
  });
});

describe('createChainHitWriter RPC budget (W16)', () => {
  it('a hit is one nonce read and one raw send: chainId is passed, so viem never calls eth_fillTransaction', async () => {
    const { methods, wallet } = recordingWallet();
    const write = createChainHitWriter({ wallet, address: ADDR });
    await write({ sessionId: 1n, track: 0, note: 0 });
    await write({ sessionId: 1n, track: 0, note: 1 });
    expect(methods).toEqual(['eth_getTransactionCount', 'eth_sendRawTransaction', 'eth_getTransactionCount', 'eth_sendRawTransaction']);
  });
});
