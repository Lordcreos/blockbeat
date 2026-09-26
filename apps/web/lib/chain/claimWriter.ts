/**
 * W21b: chain-backed claim of a player's tip share (W21a `claim(sessionId)`, after finalize),
 * signed by the phone's burner like a hit: the fixed CLAIM_GAS_LIMIT, the fixed fees and the
 * chain id, so viem never calls eth_estimateGas, eth_getBlock or eth_maxPriorityFeePerGas.
 */
import type { Account, Address, Chain, Hash, Transport, WalletClient } from 'viem';
import { CLAIM_GAS_LIMIT, HIT_MAX_FEE_PER_GAS, HIT_MAX_PRIORITY_FEE_PER_GAS, blockbeatAbi } from '@blockbeat/shared';
import { withChainId } from './hitWriter';

export type ClaimWriter = (sessionId: bigint) => Promise<Hash>;

export interface ChainClaimWriterOptions {
  wallet: WalletClient<Transport, Chain, Account>;
  address: Address;
}

export function createChainClaimWriter({ wallet, address }: ChainClaimWriterOptions): ClaimWriter {
  return (sessionId) =>
    wallet.writeContract({
      address,
      abi: blockbeatAbi,
      functionName: 'claim',
      args: [sessionId],
      gas: CLAIM_GAS_LIMIT,
      maxFeePerGas: HIT_MAX_FEE_PER_GAS,
      maxPriorityFeePerGas: HIT_MAX_PRIORITY_FEE_PER_GAS,
      ...withChainId(wallet),
    });
}
