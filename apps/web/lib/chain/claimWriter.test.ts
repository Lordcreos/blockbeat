import { describe, expect, it, vi } from 'vitest';
import type { Account, Address, Chain, Hash, Transport, WalletClient } from 'viem';
import { CLAIM_GAS_LIMIT, HIT_MAX_FEE_PER_GAS, blockbeatAbi, monadTestnet } from '@blockbeat/shared';
import { createChainClaimWriter } from './claimWriter';

const ADDR = '0x00000000000000000000000000000000000000aa' as Address;
const TX = `0x${'ab'.repeat(32)}` as Hash;

describe('createChainClaimWriter (W21b)', () => {
  it('sends claim(sessionId) with the fixed gas limit, fees and chain id, never estimating', async () => {
    const writeContract = vi.fn(async () => TX);
    const estimateContractGas = vi.fn();
    const wallet = { writeContract, estimateContractGas, chain: monadTestnet } as unknown as WalletClient<Transport, Chain, Account>;
    expect(await createChainClaimWriter({ wallet, address: ADDR })(4n)).toBe(TX);
    const call = (writeContract.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(call).toMatchObject({ address: ADDR, functionName: 'claim', args: [4n], gas: CLAIM_GAS_LIMIT, maxFeePerGas: HIT_MAX_FEE_PER_GAS, chainId: monadTestnet.id });
    expect(call.abi).toBe(blockbeatAbi);
    expect(call.value).toBeUndefined();
    expect(estimateContractGas).not.toHaveBeenCalled();
  });

  it('propagates send errors', async () => {
    const wallet = { writeContract: vi.fn(async () => Promise.reject(new Error('nonce too low'))), chain: monadTestnet } as unknown as WalletClient<Transport, Chain, Account>;
    await expect(createChainClaimWriter({ wallet, address: ADDR })(4n)).rejects.toThrow('nonce too low');
  });
});
