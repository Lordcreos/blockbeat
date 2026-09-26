import type { Address } from 'viem';
import { ANVIL_ID, MONAD_MAINNET_ID, MONAD_TESTNET_ID } from './chain';

export const ZERO_ADDRESS: Address = '0x0000000000000000000000000000000000000000';

/**
 * Deployed Blockbeat addresses per chain id.
 * Addresses are supplied at runtime. A zero address on 10143 refuses to boot (review C1);
 * other chains fall back to mock mode while zero (see docs/SDD.md §4.4).
 */
export const BLOCKBEAT_ADDRESS: Record<number, Address> = {
  [MONAD_TESTNET_ID]: ZERO_ADDRESS,
  [MONAD_MAINNET_ID]: ZERO_ADDRESS,
  // Deterministic first-deploy address of the default anvil account 0 (nonce 0); W5/W2b/W6
  // deploy Blockbeat there with contracts/script/Deploy.s.sol and may override via env.
  [ANVIL_ID]: ZERO_ADDRESS,
};

/**
 * Optional resident DJ defaults per chain. Production addresses are supplied at runtime.
 */
export const RESIDENT_DJ_ADDRESS: Record<number, Address> = {
  [MONAD_TESTNET_ID]: ZERO_ADDRESS,
  [MONAD_MAINNET_ID]: ZERO_ADDRESS,
  [ANVIL_ID]: ZERO_ADDRESS,
};

export function residentDjAddress(chainId: number): Address {
  return RESIDENT_DJ_ADDRESS[chainId] ?? ZERO_ADDRESS;
}

export function blockbeatAddress(chainId: number): Address {
  return BLOCKBEAT_ADDRESS[chainId] ?? ZERO_ADDRESS;
}

export function isDeployed(chainId: number): boolean {
  return blockbeatAddress(chainId) !== ZERO_ADDRESS;
}
