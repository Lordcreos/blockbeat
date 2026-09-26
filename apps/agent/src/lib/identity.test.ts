import { describe, expect, it, vi } from 'vitest';
import type { Address, Hash } from 'viem';
import { ANVIL_ID, MONAD_TESTNET_ID } from '@blockbeat/shared';
import { ERC8004_IDENTITY_REGISTRY, ensureIdentity, startIdentity, type IdentityChain, type IdentityStore } from './identity';

const REGISTRY = ERC8004_IDENTITY_REGISTRY[MONAD_TESTNET_ID] as Address;
const AGENT = '0x2222222222222222222222222222222222222222' as const;

function memStore(initial: string | null = null): IdentityStore & { value: string | null } {
  const store = {
    value: initial,
    read: () => store.value,
    write: (s: string) => {
      store.value = s;
    },
  };
  return store;
}

function chain(opts: { code?: string | undefined; agentId?: bigint; fail?: Error }): IdentityChain & { register: ReturnType<typeof vi.fn> } {
  const register = vi.fn(async (): Promise<Hash> => {
    if (opts.fail) throw opts.fail;
    return '0xabc';
  });
  return {
    getCode: async () => opts.code,
    register,
    waitForRegistered: async () => ({ agentId: opts.agentId ?? 1n, txHash: '0xabc' }),
  };
}

const base = { agentAddress: AGENT, agentURI: 'data:application/json;base64,e30=', log: { info: vi.fn(), warn: vi.fn() } };

describe('startIdentity (review H9)', () => {
  it('registers in the background: the label reads pending, a slow registry is reported at the deadline, and the label updates when it lands', async () => {
    vi.useFakeTimers();
    try {
      let release: () => void = () => undefined;
      const c: IdentityChain = {
        getCode: () => new Promise<string>((r) => { release = () => r('0x6080'); }),
        register: async () => '0xabc',
        waitForRegistered: async () => ({ agentId: 7n, txHash: '0xabc' }),
      };
      const log = { info: vi.fn(), warn: vi.fn() };
      const identity = startIdentity({ ...base, log, chainId: MONAD_TESTNET_ID, chain: c, store: memStore() }, { deadlineMs: 5_000 });
      expect(identity.label()).toBe('erc8004 pending');
      await vi.advanceTimersByTimeAsync(4_999);
      expect(log.warn).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/5000 ms/));
      expect(identity.label()).toBe('erc8004 pending');
      release();
      await vi.advanceTimersByTimeAsync(0);
      expect(identity.label()).toBe('erc8004 #7');
      await expect(identity.done).resolves.toMatchObject({ status: 'registered', agentId: '7' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('labels an unregistered outcome and never rejects', async () => {
    const identity = startIdentity({ ...base, chainId: ANVIL_ID, chain: chain({}), store: memStore() }, { deadlineMs: 5_000 });
    await expect(identity.done).resolves.toMatchObject({ status: 'unregistered' });
    expect(identity.label()).toBe('erc8004 unregistered');
  });
});

describe('ERC-8004 identity', () => {
  it('documents the Monad registry address from docs.monad.xyz', () => {
    expect(ERC8004_IDENTITY_REGISTRY[MONAD_TESTNET_ID]).toBe('0x8004A169FB4a3325136EB29fA0ceB6D2e539a432');
    expect(ERC8004_IDENTITY_REGISTRY[ANVIL_ID]).toBeUndefined();
  });

  it('skips with status unregistered when the chain has no registry', async () => {
    const log = { info: vi.fn(), warn: vi.fn() };
    const status = await ensureIdentity({ ...base, log, chainId: ANVIL_ID, chain: chain({}), store: memStore() });
    expect(status).toEqual({ status: 'unregistered', agentId: null, registry: null, reason: expect.stringContaining('no ERC-8004 registry') });
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('unregistered'));
  });

  it('skips when the registry address has no bytecode on the selected chain', async () => {
    const status = await ensureIdentity({ ...base, chainId: MONAD_TESTNET_ID, chain: chain({ code: undefined }), store: memStore() });
    expect(status.status).toBe('unregistered');
    expect(status.reason).toMatch(/no code/);
  });

  it('registers once, persists the agent id, and reuses it on the next run', async () => {
    const store = memStore();
    const c = chain({ code: '0x6080', agentId: 42n });
    const first = await ensureIdentity({ ...base, chainId: MONAD_TESTNET_ID, chain: c, store });
    expect(first).toMatchObject({ status: 'registered', agentId: '42', registry: REGISTRY });
    expect(c.register).toHaveBeenCalledWith(REGISTRY, base.agentURI);
    expect(JSON.parse(store.value ?? '{}')).toMatchObject({ chainId: MONAD_TESTNET_ID, agentId: '42', registry: REGISTRY, address: AGENT });

    const second = await ensureIdentity({ ...base, chainId: MONAD_TESTNET_ID, chain: c, store });
    expect(second.status).toBe('registered');
    expect(c.register).toHaveBeenCalledTimes(1);
  });

  it('ignores a persisted id from another chain or wallet', async () => {
    const store = memStore(JSON.stringify({ chainId: 1, agentId: '7', registry: REGISTRY, address: AGENT }));
    const c = chain({ code: '0x6080', agentId: 9n });
    const status = await ensureIdentity({ ...base, chainId: MONAD_TESTNET_ID, chain: c, store });
    expect(status.agentId).toBe('9');
    expect(c.register).toHaveBeenCalledTimes(1);
  });

  it('never throws: a failed registration yields unregistered with the reason logged', async () => {
    const log = { info: vi.fn(), warn: vi.fn() };
    const status = await ensureIdentity({ ...base, log, chainId: MONAD_TESTNET_ID, chain: chain({ code: '0x6080', fail: new Error('insufficient funds') }), store: memStore() });
    expect(status.status).toBe('unregistered');
    expect(status.reason).toContain('insufficient funds');
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('insufficient funds'));
  });

  it('honours a registry override address', async () => {
    const c = chain({ code: '0x6080', agentId: 3n });
    const override = '0x9999999999999999999999999999999999999999' as const;
    const status = await ensureIdentity({ ...base, chainId: ANVIL_ID, chain: c, store: memStore(), registryOverride: override });
    expect(status).toMatchObject({ status: 'registered', registry: override });
    expect(c.register).toHaveBeenCalledWith(override, base.agentURI);
  });
});
