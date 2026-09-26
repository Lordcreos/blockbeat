import { describe, expect, it, vi } from 'vitest';
import { createWalletClient, custom } from 'viem';
import { nonceManager, privateKeyToAccount } from 'viem/accounts';
import { monadTestnet } from '@blockbeat/shared';
import type { Account, Address, Chain, Hash, Transport, WalletClient } from 'viem';
import { TIP_GAS_LIMIT, blockbeatAbi } from '@blockbeat/shared';
import { createChainTipWriter } from './tipWriter';

const ADDR = '0x00000000000000000000000000000000000000aa' as Address;
const TX = `0x${'ab'.repeat(32)}` as Hash;

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

describe('createChainTipWriter', () => {
  it('calls writeContract for tip with the value and the fixed gas limit, never estimating gas', async () => {
    const writeContract = vi.fn(async () => TX);
    const estimateGas = vi.fn();
    const estimateContractGas = vi.fn();
    const wallet = { writeContract, estimateGas, estimateContractGas, chain: monadTestnet } as unknown as WalletClient<Transport, Chain, Account>;
    const write = createChainTipWriter({ wallet, address: ADDR });
    const hash = await write({ sessionId: 1n, valueWei: 5_000_000_000_000_000n });
    expect(hash).toBe(TX);
    expect(writeContract).toHaveBeenCalledTimes(1);
    const call = writeContract.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(call[0]).toMatchObject({ address: ADDR, functionName: 'tip', args: [1n], value: 5_000_000_000_000_000n, gas: TIP_GAS_LIMIT });
    expect(call[0]?.abi).toBe(blockbeatAbi);
    expect(estimateGas).not.toHaveBeenCalled();
    expect(estimateContractGas).not.toHaveBeenCalled();
  });

  it('propagates send errors', async () => {
    const wallet = {
      writeContract: vi.fn(async () => {
        throw new Error('nonce too low');
      }),
      chain: monadTestnet,
    } as unknown as WalletClient<Transport, Chain, Account>;
    const write = createChainTipWriter({ wallet, address: ADDR });
    await expect(write({ sessionId: 1n, valueWei: 1n })).rejects.toThrow('nonce too low');
  });
});

describe('createChainTipWriter RPC budget (W16)', () => {
  it('a tip is one nonce read and one raw send: chainId and the fixed fees are passed', async () => {
    const { methods, wallet } = recordingWallet();
    await createChainTipWriter({ wallet, address: ADDR })({ sessionId: 1n, valueWei: 1n });
    expect(methods).toEqual(['eth_getTransactionCount', 'eth_sendRawTransaction']);
  });
});
