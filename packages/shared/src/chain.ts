import { defineChain } from 'viem';

/** Verified against https://docs.monad.xyz/developer-essentials/testnet on 2026-09-24. */
export const MONAD_TESTNET_ID = 10143 as const;
export const MONAD_MAINNET_ID = 143 as const;

export const MONAD_TESTNET_RPC_HTTP = 'https://testnet-rpc.monad.xyz';
export const MONAD_TESTNET_RPC_WS = 'wss://testnet-rpc.monad.xyz';
export const MONAD_TESTNET_EXPLORER = 'https://testnet.monadscan.com';
export const MONAD_TESTNET_FAUCET = 'https://faucet.monad.xyz';

/**
 * Public RPC limits (docs, 2026-09-24): 50 rps overall, 25 rps for eth_call and
 * eth_estimateGas. Hot paths must never call eth_estimateGas; use fixed gas limits.
 */
export const PUBLIC_RPC_RPS = 50;
export const PUBLIC_RPC_CALL_RPS = 25;

export const monadTestnet = defineChain({
  id: MONAD_TESTNET_ID,
  name: 'Monad Testnet',
  nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
  rpcUrls: {
    default: { http: [MONAD_TESTNET_RPC_HTTP], webSocket: [MONAD_TESTNET_RPC_WS] },
  },
  blockExplorers: {
    default: { name: 'Monadscan', url: MONAD_TESTNET_EXPLORER },
  },
  testnet: true,
});

/** Local Foundry anvil chain for integration work before the testnet deploy. */
export const ANVIL_ID = 31337 as const;
export const anvilLocal = defineChain({
  id: ANVIL_ID,
  name: 'Anvil (local)',
  nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: ['http://127.0.0.1:8545'], webSocket: ['ws://127.0.0.1:8545'] } },
  testnet: true,
});

export const SUPPORTED_CHAINS = { [MONAD_TESTNET_ID]: monadTestnet, [ANVIL_ID]: anvilLocal } as const;

/** Pick a chain by id; unknown ids fall back to Monad testnet. */
export function chainById(chainId: number) {
  return (SUPPORTED_CHAINS as Record<number, typeof monadTestnet | typeof anvilLocal>)[chainId] ?? monadTestnet;
}

export function explorerTxUrl(hash: `0x${string}`): string {
  return `${MONAD_TESTNET_EXPLORER}/tx/${hash}`;
}

export function explorerAddressUrl(address: `0x${string}`): string {
  return `${MONAD_TESTNET_EXPLORER}/address/${address}`;
}

export function explorerTokenUrl(contract: `0x${string}`, tokenId: bigint): string {
  return `${MONAD_TESTNET_EXPLORER}/nft/${contract}/${tokenId.toString()}`;
}
