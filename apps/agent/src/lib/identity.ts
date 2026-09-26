/**
 * ERC-8004 identity registration (https://docs.monad.xyz/guides/erc-8004.md,
 * https://eips.ethereum.org/EIPS/eip-8004). Registers once per (chain, wallet), persists
 * the agent id, and never blocks the loop: any problem yields status 'unregistered' with
 * the reason logged.
 */
import type { Address, Hash } from 'viem';
import { MONAD_MAINNET_ID, MONAD_TESTNET_ID } from '@blockbeat/shared';
import type { Logger } from './log';

/**
 * Identity Registry address as documented on docs.monad.xyz (2026-09-25). The page lists a
 * single Monad address; on 2026-09-25 it had no bytecode on testnet (checked with
 * `cast code`), so the agent verifies code before registering and reports 'unregistered'
 * otherwise. Override with ERC8004_IDENTITY_REGISTRY.
 */
export const ERC8004_IDENTITY_REGISTRY: Readonly<Record<number, Address>> = {
  [MONAD_TESTNET_ID]: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
  [MONAD_MAINNET_ID]: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
};

/** Minimal ERC-8004 Identity Registry ABI (register(string) + Registered). */
export const erc8004IdentityAbi = [
  {
    type: 'function',
    name: 'register',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'agentURI', type: 'string' }],
    outputs: [{ name: 'agentId', type: 'uint256' }],
  },
  {
    type: 'event',
    name: 'Registered',
    inputs: [
      { name: 'agentId', type: 'uint256', indexed: true },
      { name: 'agentURI', type: 'string', indexed: false },
      { name: 'owner', type: 'address', indexed: true },
    ],
  },
] as const;

/** Fixed gas for register(): an ERC-721 mint plus a string; never eth_estimateGas. */
export const REGISTER_GAS_LIMIT = 400_000n;

export interface IdentityStatus {
  status: 'registered' | 'unregistered';
  agentId: string | null;
  registry: Address | null;
  reason?: string;
}

export interface IdentityRecord {
  chainId: number;
  address: Address;
  registry: Address;
  agentId: string;
  txHash: Hash | null;
  registeredAt: string;
}

/** Persistence for .agent.json; injectable for tests. */
export interface IdentityStore {
  read(): string | null;
  write(contents: string): void;
}

/** Chain access; injectable for tests. */
export interface IdentityChain {
  getCode(address: Address): Promise<string | undefined>;
  register(registry: Address, agentURI: string): Promise<Hash>;
  waitForRegistered(txHash: Hash): Promise<{ agentId: bigint; txHash: Hash }>;
}

export interface EnsureIdentityOptions {
  chainId: number;
  agentAddress: Address;
  agentURI: string;
  chain: IdentityChain;
  store: IdentityStore;
  log: Logger;
  registryOverride?: Address | undefined;
}

function readRecord(store: IdentityStore, log: Logger): IdentityRecord | null {
  const raw = store.read();
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object');
    const r = parsed as Partial<IdentityRecord>;
    if (typeof r.chainId !== 'number' || typeof r.address !== 'string' || typeof r.registry !== 'string' || typeof r.agentId !== 'string') {
      throw new Error('missing fields');
    }
    return r as IdentityRecord;
  } catch (error) {
    log.warn(`identity: ignoring unreadable .agent.json (${error instanceof Error ? error.message : String(error)})`);
    return null;
  }
}

export async function ensureIdentity(options: EnsureIdentityOptions): Promise<IdentityStatus> {
  const { chainId, agentAddress, agentURI, chain, store, log } = options;
  const registry = options.registryOverride ?? ERC8004_IDENTITY_REGISTRY[chainId];
  if (!registry) {
    const reason = `no ERC-8004 registry known for chain ${chainId}`;
    log.warn(`identity: unregistered (${reason})`);
    return { status: 'unregistered', agentId: null, registry: null, reason };
  }

  const existing = readRecord(store, log);
  if (
    existing &&
    existing.chainId === chainId &&
    existing.address.toLowerCase() === agentAddress.toLowerCase() &&
    existing.registry.toLowerCase() === registry.toLowerCase()
  ) {
    log.info(`identity: registered as ERC-8004 agent #${existing.agentId} on chain ${chainId} (from .agent.json)`);
    return { status: 'registered', agentId: existing.agentId, registry };
  }

  try {
    const code = await chain.getCode(registry);
    if (!code || code === '0x') {
      const reason = `registry ${registry} has no code on chain ${chainId}`;
      log.warn(`identity: unregistered (${reason})`);
      return { status: 'unregistered', agentId: null, registry, reason };
    }
    log.info(`identity: registering ${agentAddress} in ${registry} on chain ${chainId}`);
    const txHash = await chain.register(registry, agentURI);
    const { agentId } = await chain.waitForRegistered(txHash);
    const record: IdentityRecord = { chainId, address: agentAddress, registry, agentId: agentId.toString(), txHash, registeredAt: new Date().toISOString() };
    store.write(JSON.stringify(record, null, 2));
    log.info(`identity: registered as ERC-8004 agent #${record.agentId} (tx ${txHash})`);
    return { status: 'registered', agentId: record.agentId, registry };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    log.warn(`identity: unregistered (registration failed: ${reason})`);
    return { status: 'unregistered', agentId: null, registry, reason };
  }
}

export interface StartedIdentity {
  /** Status line label: 'erc8004 pending' until registration settles. */
  label(): string;
  done: Promise<IdentityStatus>;
}

export const IDENTITY_DEADLINE_MS = 5_000;

/**
 * Review H9: registration must never delay the first bar. It runs concurrently with the
 * loop; the label updates when it lands, and a registry that is still busy after the
 * deadline is reported (worst case getCode → register → receipt was 80 s).
 */
export function startIdentity(options: EnsureIdentityOptions, timing: { deadlineMs?: number } = {}): StartedIdentity {
  const deadlineMs = timing.deadlineMs ?? IDENTITY_DEADLINE_MS;
  let label = 'erc8004 pending';
  let settled = false;
  const timer = setTimeout(() => {
    if (!settled) options.log.warn(`identity: still registering after ${deadlineMs} ms; the loop runs without it and the label updates when it lands`);
  }, deadlineMs);
  const done = ensureIdentity(options).then((status) => {
    settled = true;
    clearTimeout(timer);
    label = status.status === 'registered' ? `erc8004 #${status.agentId}` : 'erc8004 unregistered';
    return status;
  });
  return { label: () => label, done };
}

/** Registration file per EIP-8004 (embedded as a data: URI so no hosting is needed). */
export function buildAgentURI(agentAddress: Address, chainId: number): string {
  const file = {
    type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
    name: 'Blockbeat Resident DJ',
    description: 'Claude-powered resident DJ for Blockbeat: listens to the onchain 16-step pattern and adds fills as real transactions.',
    image: '',
    services: [],
    active: true,
    supportedTrust: [],
    agentWallet: `eip155:${chainId}:${agentAddress}`,
  };
  return `data:application/json;base64,${Buffer.from(JSON.stringify(file), 'utf8').toString('base64')}`;
}
