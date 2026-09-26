/**
 * Process-wide host service for the session routes. Built lazily from env; in mock mode no
 * key is needed. `HOST_PRIVATE_KEY` is read once and never logged.
 */
import { privateKeyToAccount, nonceManager } from 'viem/accounts';
import { createBurnerWalletClient, createHttpClient, getRpcUrls, isMockMode, runtimeAddress } from '../chain/clients';
import { createChainHostService, createMockHostService, type HostService } from './service';

const PK_RE = /^0x[0-9a-fA-F]{64}$/;

let service: HostService | null = null;

export class HostNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HostNotConfiguredError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Throws HostNotConfiguredError (no key material in the message) when chain mode lacks a key. */
export function getHostService(): HostService {
  if (service) return service;
  if (isMockMode()) {
    service = createMockHostService();
    return service;
  }
  const raw = process.env.HOST_PRIVATE_KEY?.trim();
  if (!raw) throw new HostNotConfiguredError('HOST_PRIVATE_KEY is not configured');
  if (!PK_RE.test(raw)) throw new HostNotConfiguredError('HOST_PRIVATE_KEY is set but is not a 0x-prefixed 32-byte hex key');
  const account = privateKeyToAccount(raw as `0x${string}`, { nonceManager });
  const rpcHttp = process.env.MONAD_RPC_URL?.trim() || getRpcUrls().http;
  service = createChainHostService({
    wallet: createBurnerWalletClient(account, rpcHttp),
    publicClient: createHttpClient(rpcHttp),
    address: runtimeAddress(),
  });
  return service;
}
