import { afterEach, describe, expect, it, vi } from 'vitest';
import { ANVIL_ID, MONAD_TESTNET_ID, MONAD_TESTNET_RPC_HTTP, MONAD_TESTNET_RPC_WS, ZERO_ADDRESS } from '@blockbeat/shared';
import {
  assertRuntimeConfigured,
  createBurnerWalletClient,
  createHttpClient,
  createWsClient,
  getRpcUrls,
  isMockMode,
  runtimeAddress,
  runtimeChain,
  runtimeChainId,
  runtimeMode,
} from './clients';
import { loadOrCreateBurner } from '../burner';

// Shared now holds the live testnet address; these tests simulate the pre-deploy state.
const sharedState = vi.hoisted(() => ({ zeroTestnet: false }));
vi.mock('@blockbeat/shared', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@blockbeat/shared')>();
  return {
    ...mod,
    blockbeatAddress: (chainId: number) =>
      sharedState.zeroTestnet && chainId === mod.MONAD_TESTNET_ID ? mod.ZERO_ADDRESS : mod.blockbeatAddress(chainId),
  };
});

const ANVIL_CONTRACT = '0x5FbDB2315678afecb367f032d93F642f64180aa3';

describe('clients', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    sharedState.zeroTestnet = false;
  });

  it('defaults RPC urls to the shared chain definition', () => {
    vi.stubEnv('NEXT_PUBLIC_MONAD_RPC_URL', '');
    vi.stubEnv('NEXT_PUBLIC_MONAD_WS_URL', '');
    vi.stubEnv('NEXT_PUBLIC_CHAIN_ID', '');
    expect(getRpcUrls()).toEqual({ http: MONAD_TESTNET_RPC_HTTP, ws: MONAD_TESTNET_RPC_WS });
  });

  it('honours env overrides', () => {
    vi.stubEnv('NEXT_PUBLIC_MONAD_RPC_URL', 'https://rpc.example');
    vi.stubEnv('NEXT_PUBLIC_MONAD_WS_URL', 'wss://ws.example');
    expect(getRpcUrls()).toEqual({ http: 'https://rpc.example', ws: 'wss://ws.example' });
  });

  it('defaults the RPC urls to the selected chain (anvil) when no override is set', () => {
    vi.stubEnv('NEXT_PUBLIC_CHAIN_ID', '31337');
    vi.stubEnv('NEXT_PUBLIC_MONAD_RPC_URL', '');
    vi.stubEnv('NEXT_PUBLIC_MONAD_WS_URL', '');
    expect(getRpcUrls()).toEqual({ http: 'http://127.0.0.1:8545', ws: 'ws://127.0.0.1:8545' });
  });

  it('selects Monad testnet by default and anvil via NEXT_PUBLIC_CHAIN_ID', () => {
    vi.stubEnv('NEXT_PUBLIC_CHAIN_ID', '');
    expect(runtimeChainId()).toBe(MONAD_TESTNET_ID);
    expect(runtimeChain().id).toBe(MONAD_TESTNET_ID);
    vi.stubEnv('NEXT_PUBLIC_CHAIN_ID', '31337');
    expect(runtimeChainId()).toBe(ANVIL_ID);
    expect(runtimeChain().id).toBe(ANVIL_ID);
  });

  it('refuses an unknown chain id instead of silently signing for Monad testnet (review M6)', () => {
    vi.stubEnv('NEXT_PUBLIC_CHAIN_ID', '999');
    expect(() => runtimeChain()).toThrow(/999/);
    expect(() => runtimeChain()).toThrow(/10143/);
    expect(() => getRpcUrls()).toThrow(/999/);
  });

  it('rejects a malformed NEXT_PUBLIC_CHAIN_ID loudly', () => {
    vi.stubEnv('NEXT_PUBLIC_CHAIN_ID', 'anvil');
    expect(() => runtimeChainId()).toThrow(/NEXT_PUBLIC_CHAIN_ID/);
  });

  it('falls back to mock mode on anvil while the resolved address is zero', () => {
    vi.stubEnv('NEXT_PUBLIC_BLOCKBEAT_MOCK', '');
    vi.stubEnv('NEXT_PUBLIC_BLOCKBEAT_ADDRESS', '');
    vi.stubEnv('NEXT_PUBLIC_CHAIN_ID', '31337');
    expect(runtimeAddress()).toBe(ZERO_ADDRESS);
    expect(isMockMode()).toBe(true);
  });

  it('refuses to boot silently in mock mode on Monad testnet with a zero address (review C1)', () => {
    sharedState.zeroTestnet = true;
    vi.stubEnv('NEXT_PUBLIC_BLOCKBEAT_MOCK', '');
    vi.stubEnv('NEXT_PUBLIC_BLOCKBEAT_ADDRESS', '');
    vi.stubEnv('NEXT_PUBLIC_CHAIN_ID', '');
    expect(runtimeAddress()).toBe(ZERO_ADDRESS);
    expect(() => isMockMode()).toThrow(/NEXT_PUBLIC_BLOCKBEAT_ADDRESS/);
    expect(() => isMockMode()).toThrow(/NEXT_PUBLIC_BLOCKBEAT_MOCK=1/);
    expect(() => assertRuntimeConfigured()).toThrow(/10143/);
    // Mock mode is still available when asked for explicitly.
    vi.stubEnv('NEXT_PUBLIC_BLOCKBEAT_MOCK', '1');
    expect(isMockMode()).toBe(true);
    expect(() => assertRuntimeConfigured()).not.toThrow();
  });

  it('warns instead of throwing while `next build` prerenders pages without env, so a bare build stays green (review C1)', () => {
    sharedState.zeroTestnet = true;
    vi.stubEnv('NEXT_PUBLIC_BLOCKBEAT_MOCK', '');
    vi.stubEnv('NEXT_PUBLIC_BLOCKBEAT_ADDRESS', '');
    vi.stubEnv('NEXT_PUBLIC_CHAIN_ID', '');
    vi.stubEnv('NEXT_PHASE', 'phase-production-build');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(() => assertRuntimeConfigured()).not.toThrow();
    expect(isMockMode()).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('NEXT_PUBLIC_BLOCKBEAT_ADDRESS'));
    warn.mockRestore();
    vi.stubEnv('NEXT_PHASE', 'phase-development-server');
    expect(() => isMockMode()).toThrow(/NEXT_PUBLIC_BLOCKBEAT_ADDRESS/);
  });

  it('reports the runtime mode so the UI can show a banner (review C1)', () => {
    vi.stubEnv('NEXT_PUBLIC_BLOCKBEAT_MOCK', '1');
    vi.stubEnv('NEXT_PUBLIC_CHAIN_ID', '');
    expect(runtimeMode()).toBe('mock');
    vi.stubEnv('NEXT_PUBLIC_BLOCKBEAT_MOCK', '');
    vi.stubEnv('NEXT_PUBLIC_BLOCKBEAT_ADDRESS', ANVIL_CONTRACT);
    expect(runtimeMode()).toBe('chain');
  });

  it('uses NEXT_PUBLIC_BLOCKBEAT_ADDRESS over the shared table and leaves mock mode', () => {
    vi.stubEnv('NEXT_PUBLIC_BLOCKBEAT_MOCK', '');
    vi.stubEnv('NEXT_PUBLIC_CHAIN_ID', '31337');
    vi.stubEnv('NEXT_PUBLIC_BLOCKBEAT_ADDRESS', ANVIL_CONTRACT);
    expect(runtimeAddress()).toBe(ANVIL_CONTRACT);
    expect(isMockMode()).toBe(false);
  });

  it('rejects a malformed NEXT_PUBLIC_BLOCKBEAT_ADDRESS loudly', () => {
    vi.stubEnv('NEXT_PUBLIC_BLOCKBEAT_ADDRESS', '0x1234');
    expect(() => runtimeAddress()).toThrow(/NEXT_PUBLIC_BLOCKBEAT_ADDRESS/);
  });

  it('can be forced into mock mode by env even with an address', () => {
    vi.stubEnv('NEXT_PUBLIC_BLOCKBEAT_MOCK', '1');
    vi.stubEnv('NEXT_PUBLIC_BLOCKBEAT_ADDRESS', ANVIL_CONTRACT);
    expect(isMockMode()).toBe(true);
  });

  it('builds viem clients bound to the selected chain', () => {
    vi.stubEnv('NEXT_PUBLIC_CHAIN_ID', '');
    const http = createHttpClient('https://rpc.example');
    expect(http.chain.id).toBe(MONAD_TESTNET_ID);
    const ws = createWsClient('wss://ws.example');
    expect(ws.chain.id).toBe(MONAD_TESTNET_ID);
    expect(ws.transport.type).toBe('webSocket');
    vi.stubEnv('NEXT_PUBLIC_CHAIN_ID', '31337');
    expect(createHttpClient('http://127.0.0.1:8545').chain.id).toBe(ANVIL_ID);
  });

  it('builds a wallet client for a burner account', () => {
    vi.stubEnv('NEXT_PUBLIC_CHAIN_ID', '');
    const burner = loadOrCreateBurner({ storage: null });
    const wallet = createBurnerWalletClient(burner.account, 'https://rpc.example');
    expect(wallet.account.address).toBe(burner.address);
    expect(wallet.chain.id).toBe(MONAD_TESTNET_ID);
  });
});
