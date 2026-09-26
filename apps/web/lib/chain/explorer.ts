/** Explorer links exist only for Monad testnet; anvil has none, so callers get null. */
import type { Address, Hash } from 'viem';
import { MONAD_TESTNET_ID, explorerTokenUrl, explorerTxUrl } from '@blockbeat/shared';
import { runtimeChainId } from './clients';

export function explorerTxLink(hash: Hash): string | null {
  return runtimeChainId() === MONAD_TESTNET_ID ? explorerTxUrl(hash) : null;
}

export function explorerTokenLink(contract: Address, tokenId: bigint): string | null {
  return runtimeChainId() === MONAD_TESTNET_ID ? explorerTokenUrl(contract, tokenId) : null;
}
