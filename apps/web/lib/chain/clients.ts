/**
 * viem clients bound to the selected chain. Chain definitions, RPC URLs and the contract
 * address table all come from @blockbeat/shared; env vars pick the chain
 * (`NEXT_PUBLIC_CHAIN_ID`, default Monad testnet), override the address for that chain
 * (`NEXT_PUBLIC_BLOCKBEAT_ADDRESS`, needed on anvil where shared holds the zero address)
 * and override the RPC endpoints.
 */
import {
  createPublicClient,
  createWalletClient,
  http,
  isAddress,
  webSocket,
  type Account,
  type Address,
  type Chain,
  type PublicClient,
  type Transport,
  type WalletClient,
} from 'viem';
import { BLOCK_MS, MONAD_TESTNET_ID, SUPPORTED_CHAINS, ZERO_ADDRESS, blockbeatAddress, chainById } from '@blockbeat/shared';

export interface RpcUrls {
  http: string;
  ws: string;
}

function envOr(value: string | undefined, fallback: string): string {
  const v = value?.trim();
  return v ? v : fallback;
}

/** Chain id the app runs on: `NEXT_PUBLIC_CHAIN_ID` (an integer) or Monad testnet. */
export function runtimeChainId(): number {
  const raw = process.env.NEXT_PUBLIC_CHAIN_ID?.trim();
  if (!raw) return MONAD_TESTNET_ID;
  if (!/^\d+$/.test(raw)) throw new Error(`NEXT_PUBLIC_CHAIN_ID must be an integer chain id, got "${raw}"`);
  return Number(raw);
}

/** The viem chain for `runtimeChainId()`; an id shared does not know throws (review M6) instead of quietly meaning testnet. */
export function runtimeChain(): Chain {
  const id = runtimeChainId();
  if (!(id in SUPPORTED_CHAINS)) {
    throw new Error(`NEXT_PUBLIC_CHAIN_ID ${id} is not a supported chain (known: ${Object.keys(SUPPORTED_CHAINS).join(', ')}, default 10143)`);
  }
  return chainById(id);
}

export function getRpcUrls(): RpcUrls {
  const chain = runtimeChain();
  const defaults = chain.rpcUrls.default;
  return {
    http: envOr(process.env.NEXT_PUBLIC_MONAD_RPC_URL, defaults.http[0] ?? ''),
    ws: envOr(process.env.NEXT_PUBLIC_MONAD_WS_URL, defaults.webSocket?.[0] ?? ''),
  };
}

/**
 * The Blockbeat address for the selected chain: `NEXT_PUBLIC_BLOCKBEAT_ADDRESS` when set
 * (validated), else the shared table (zero until W1 deploys to testnet).
 */
export function runtimeAddress(): Address {
  const raw = process.env.NEXT_PUBLIC_BLOCKBEAT_ADDRESS?.trim();
  if (raw) {
    if (!isAddress(raw)) throw new Error('NEXT_PUBLIC_BLOCKBEAT_ADDRESS is set but is not a valid 20-byte hex address');
    return raw;
  }
  return blockbeatAddress(runtimeChainId());
}

export type RuntimeMode = 'mock' | 'chain';

function mockForced(): boolean {
  return process.env.NEXT_PUBLIC_BLOCKBEAT_MOCK?.trim() === '1';
}

/**
 * Boot guard (review C1): on Monad testnet a zero address means the deploy address never
 * reached the shared table or the env, and the app would otherwise run the in-memory
 * simulator with nothing on Monadscan. Refuse loudly unless mock mode was asked for.
 */
export function assertRuntimeConfigured(): void {
  if (mockForced()) return;
  const chainId = runtimeChainId();
  if (chainId !== MONAD_TESTNET_ID || runtimeAddress() !== ZERO_ADDRESS) return;
  const message =
    `Blockbeat has no contract address for chain ${chainId} (Monad testnet): set NEXT_PUBLIC_BLOCKBEAT_ADDRESS ` +
    'to the deployed address (or fill packages/shared addresses.ts), or set NEXT_PUBLIC_BLOCKBEAT_MOCK=1 to ' +
    'run the in-memory simulator on purpose. Restart `next dev` after changing NEXT_PUBLIC_* values.';
  if (process.env.NEXT_PHASE === 'phase-production-build') {
    // `next build` prerenders /host and the landing page with whatever env the build has; there is
    // no user to protect yet, so warn here and let the same check throw on every real request.
    console.warn(`blockbeat: building without a contract address. ${message}`);
    return;
  }
  throw new Error(message);
}

/**
 * Mock mode: the in-memory simulator replaces the chain. `NEXT_PUBLIC_BLOCKBEAT_MOCK=1`
 * forces it on; a zero address on anvil selects it automatically; a zero address on Monad
 * testnet throws (see assertRuntimeConfigured).
 */
export function isMockMode(): boolean {
  if (mockForced()) return true;
  assertRuntimeConfigured();
  return runtimeAddress() === ZERO_ADDRESS;
}

/** 'mock' or 'chain' for the current env; the UI shows a banner when it is 'mock'. */
export function runtimeMode(): RuntimeMode {
  return isMockMode() ? 'mock' : 'chain';
}

export type MonadPublicClient = PublicClient<Transport, Chain>;
export type MonadWalletClient = WalletClient<Transport, Chain, Account>;

/** viem polls receipts and (fallback) heads at 4 s by default; Monad blocks arrive every 300 ms. */
export function createHttpClient(url: string = getRpcUrls().http, chain: Chain = runtimeChain()): MonadPublicClient {
  return createPublicClient({ chain, transport: http(url, { batch: false }), pollingInterval: BLOCK_MS });
}

export function createWsClient(url: string = getRpcUrls().ws, chain: Chain = runtimeChain()): MonadPublicClient {
  return createPublicClient({
    chain,
    transport: webSocket(url, { reconnect: { attempts: 5, delay: 1_000 } }),
  });
}

/** Wallet client for a burner (or any local account) over HTTP. */
export function createBurnerWalletClient(
  account: Account,
  url: string = getRpcUrls().http,
  chain: Chain = runtimeChain(),
): MonadWalletClient {
  return createWalletClient({ account, chain, transport: http(url, { batch: false }) });
}

export type { Chain };
