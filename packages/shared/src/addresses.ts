import type { Address } from 'viem';
import { ANVIL_ID, MONAD_MAINNET_ID, MONAD_TESTNET_ID } from './chain';

export const ZERO_ADDRESS: Address = '0x0000000000000000000000000000000000000000';

/**
 * Deployed Blockbeat addresses per chain id.
 * 10143 is the live Monad testnet deployment. A zero address on 10143 refuses to boot
 * (review C1); other chains fall back to mock mode while zero (see docs/SDD.md §4.4).
 */
export const BLOCKBEAT_ADDRESS: Record<number, Address> = {
  // W21a tip split (20 % host / 80 % human players), deployed 2026-09-26 with
  // contracts/script/Deploy.s.sol, tx 0x244f0c6d499d384b8c75fd43145b4a3b4b85d4b6edba501616ef3f3eca0849a9
  // (see docs/evidence/w21a-tip-split/README.md). The pre-split contract
  // 0x1111111111111111111111111111111111111111 (2026-09-25) stays on chain, unused.
  [MONAD_TESTNET_ID]: '0x1111111111111111111111111111111111111111',
  [MONAD_MAINNET_ID]: ZERO_ADDRESS,
  // Deterministic first-deploy address of the default anvil account 0 (nonce 0); W5/W2b/W6
  // deploy Blockbeat there with contracts/script/Deploy.s.sol and may override via env.
  [ANVIL_ID]: ZERO_ADDRESS,
};

/**
 * The resident DJ agent wallet per chain id (W21a). Blockbeat stores it as the immutable
 * `agent()` at deploy time: its hits shape the pattern and co-own the track NFT, but take no
 * tips. contracts/script/Deploy.s.sol defaults to the 10143 entry (a test guards the drift).
 */
export const RESIDENT_DJ_ADDRESS: Record<number, Address> = {
  [MONAD_TESTNET_ID]: '0x2222222222222222222222222222222222222222',
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
