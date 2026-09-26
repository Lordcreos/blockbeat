/**
 * Chain-backed TipWriter: `writeContract` for the payable `tip` with the fixed TIP_GAS_LIMIT
 * from shared. Passing `gas` explicitly means viem skips eth_estimateGas entirely; passing the
 * fixed fees and `chainId` (W16) means it also skips eth_fillTransaction, eth_getBlock and
 * eth_maxPriorityFeePerGas: a tip is one nonce read plus one raw send, like a hit.
 */
import type { Account, Address, Chain, Transport, WalletClient } from 'viem';
import { HIT_MAX_FEE_PER_GAS, HIT_MAX_PRIORITY_FEE_PER_GAS, TIP_GAS_LIMIT, blockbeatAbi } from '@blockbeat/shared';
import type { TipWriter } from '../tipSender';
import { withChainId } from './hitWriter';

export interface ChainTipWriterOptions {
  wallet: WalletClient<Transport, Chain, Account>;
  address: Address;
}

export function createChainTipWriter({ wallet, address }: ChainTipWriterOptions): TipWriter {
  // A refused tip resets the burner's shared local nonce inside viem's sendTransaction (W16).
  return ({ sessionId, valueWei }) =>
    wallet.writeContract({
      address,
      abi: blockbeatAbi,
      functionName: 'tip',
      args: [sessionId],
      value: valueWei,
      gas: TIP_GAS_LIMIT,
      maxFeePerGas: HIT_MAX_FEE_PER_GAS,
      maxPriorityFeePerGas: HIT_MAX_PRIORITY_FEE_PER_GAS,
      ...withChainId(wallet),
    });
}
