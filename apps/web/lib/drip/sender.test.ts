import { describe, expect, it, vi } from 'vitest';
import { createWalletClient, custom } from 'viem';
import { nonceManager } from 'viem/accounts';
import { monadTestnet } from '@blockbeat/shared';
import { DripRevertedError } from './service';
import { parseEther, toHex, type Account, type Chain, type Hash, type Transport, type WalletClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { DRIP_AMOUNT_MON, HIT_MAX_FEE_PER_GAS, HIT_MAX_PRIORITY_FEE_PER_GAS } from '@blockbeat/shared';
import { DRIP_GAS_LIMIT, createChainDripSender, dripAccountFromEnv } from './sender';

const TX = `0x${'cd'.repeat(32)}` as Hash;
const PK = `0x${'11'.repeat(32)}`;
const TO = '0x2222222222222222222222222222222222222222';

function addr(i: number): `0x${string}` {
  return `0x${i.toString(16).padStart(40, '0')}`;
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 1));

/**
 * A wallet that behaves like a node: every send fetches the pending nonce (after a network
 * round trip), signs with it, and the node rejects a nonce it has already seen. Two sends
 * that overlap without a nonce manager or a queue read the same nonce and one of them fails.
 */
function nodeLikeWallet(account: Account) {
  const used = new Set<number>();
  let inFlight = 0;
  let maxInFlight = 0;
  const client = {
    request: async ({ method }: { method: string }): Promise<string> => {
      await tick();
      if (method !== 'eth_getTransactionCount') throw new Error(`unexpected ${method}`);
      return toHex(used.size);
    },
  };
  const sendTransaction = vi.fn(async (args: { to: `0x${string}`; nonce?: number }): Promise<Hash> => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      const nonce =
        args.nonce ??
        (account.nonceManager
          ? await account.nonceManager.consume({ address: account.address, chainId: 1, client: client as never })
          : Number(BigInt(await client.request({ method: 'eth_getTransactionCount' }))));
      await tick();
      if (used.has(nonce)) throw new Error(`nonce too low: ${nonce} already used`);
      used.add(nonce);
      return `0x${nonce.toString(16).padStart(64, '0')}` as Hash;
    } finally {
      inFlight -= 1;
    }
  });
  const wallet = { account, sendTransaction, chain: monadTestnet } as unknown as WalletClient<Transport, Chain, Account>;
  return { wallet, sendTransaction, used, maxInFlight: () => maxInFlight };
}

/** W16: a real viem wallet on a transport that records every RPC method (no node). */
function recordingWallet() {
  const methods: string[] = [];
  const transport = custom({
    async request({ method }: { method: string }) {
      methods.push(method);
      switch (method) {
        case 'eth_chainId':
          return '0x279f';
        case 'eth_getTransactionCount':
          return '0x0';
        case 'eth_sendRawTransaction':
          return `0x${'ab'.repeat(32)}`;
        case 'eth_getBlockByNumber':
          return { baseFeePerGas: '0x174876e800', number: '0x1', hash: `0x${'ab'.repeat(32)}`, timestamp: '0x1', transactions: [] };
        case 'eth_maxPriorityFeePerGas':
          return '0x77359400';
        default:
          throw new Error(`${method} is not available`);
      }
    },
  });
  const wallet = createWalletClient({ account: privateKeyToAccount(`0x${'11'.repeat(32)}`, { nonceManager }), chain: monadTestnet, transport });
  return { methods, wallet };
}

describe('createChainDripSender', () => {
  it('sends DRIP_AMOUNT_MON with a fixed gas limit and no gas estimation', async () => {
    const sendTransaction = vi.fn(async () => TX);
    const estimateGas = vi.fn();
    const wallet = { sendTransaction, estimateGas, chain: monadTestnet } as unknown as WalletClient<Transport, Chain, Account>;
    const sender = createChainDripSender({ wallet });
    expect(await sender.send(TO)).toBe(TX);
    expect(sendTransaction).toHaveBeenCalledWith({
      to: TO,
      value: parseEther(DRIP_AMOUNT_MON),
      gas: DRIP_GAS_LIMIT,
      // W16: fixed fees and chainId, so viem never fills or reads fees before a drip.
      maxFeePerGas: HIT_MAX_FEE_PER_GAS,
      maxPriorityFeePerGas: HIT_MAX_PRIORITY_FEE_PER_GAS,
      chainId: monadTestnet.id,
    });
    expect(estimateGas).not.toHaveBeenCalled();
    expect(DRIP_GAS_LIMIT).toBe(21_000n);
  });

  it('serialises 20 concurrent drips to distinct addresses so no two sends share a nonce (review C3)', async () => {
    // No nonce manager on purpose: the queue alone must keep the nonces distinct.
    const node = nodeLikeWallet(privateKeyToAccount(PK as `0x${string}`));
    const sender = createChainDripSender({ wallet: node.wallet });
    const hashes = await Promise.all(Array.from({ length: 20 }, (_, i) => sender.send(addr(i + 1))));
    expect(new Set(hashes).size).toBe(20);
    expect(node.sendTransaction).toHaveBeenCalledTimes(20);
    expect(node.maxInFlight()).toBe(1);
    expect([...node.used].sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i));
  });

  it('keeps the queue moving after a failed send', async () => {
    const sendTransaction = vi.fn().mockRejectedValueOnce(new Error('insufficient funds')).mockResolvedValueOnce(TX);
    const wallet = { sendTransaction, chain: monadTestnet } as unknown as WalletClient<Transport, Chain, Account>;
    const sender = createChainDripSender({ wallet });
    const [a, b] = await Promise.allSettled([sender.send(addr(1)), sender.send(addr(2))]);
    expect(a.status).toBe('rejected');
    expect(b).toEqual({ status: 'fulfilled', value: TX });
  });

  it('returns the hash as soon as the node accepts the transfer; the receipt is confirmed off the request path', async () => {
    const sendTransaction = vi.fn(async () => TX);
    let resolveReceipt: (r: { status: 'success' | 'reverted' }) => void = () => undefined;
    const waitForTransactionReceipt = vi.fn(() => new Promise<{ status: 'success' | 'reverted' }>((r) => (resolveReceipt = r)));
    const wallet = { sendTransaction, chain: monadTestnet } as unknown as WalletClient<Transport, Chain, Account>;
    const sender = createChainDripSender({ wallet, receipts: { waitForTransactionReceipt } as never, receiptTimeoutMs: 1234 });
    expect(await sender.send(TO)).toBe(TX);
    expect(waitForTransactionReceipt).not.toHaveBeenCalled();
    expect(sender.confirm).toBeDefined();
    let settled = false;
    const p = sender.confirm?.(TX).then(() => {
      settled = true;
    });
    await tick();
    expect(waitForTransactionReceipt).toHaveBeenCalledWith({ hash: TX, timeout: 1234 });
    expect(settled).toBe(false);
    resolveReceipt({ status: 'success' });
    await p;
    expect(settled).toBe(true);
  });

  it('confirm rejects when the funding transaction reverted', async () => {
    const wallet = { sendTransaction: vi.fn(async () => TX), chain: monadTestnet } as unknown as WalletClient<Transport, Chain, Account>;
    const receipts = { waitForTransactionReceipt: vi.fn(async () => ({ status: 'reverted' })) } as never;
    const sender = createChainDripSender({ wallet, receipts });
    await expect(sender.confirm?.(TX)).rejects.toBeInstanceOf(DripRevertedError);
  });

  it('confirms receipts one at a time so N in-flight drips never poll the RPC N times per block', async () => {
    const wallet = { sendTransaction: vi.fn(async () => TX), chain: monadTestnet } as unknown as WalletClient<Transport, Chain, Account>;
    let inFlight = 0;
    let maxInFlight = 0;
    const waitForTransactionReceipt = vi.fn(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await tick();
      inFlight -= 1;
      return { status: 'success' as const };
    });
    const sender = createChainDripSender({ wallet, receipts: { waitForTransactionReceipt } as never });
    await Promise.all(Array.from({ length: 5 }, (_, i) => sender.confirm?.(`0x${i.toString(16).padStart(64, '0')}` as Hash)));
    expect(waitForTransactionReceipt).toHaveBeenCalledTimes(5);
    expect(maxInFlight).toBe(1);
  });

  it('has no confirm step without a receipt source', () => {
    const wallet = { sendTransaction: vi.fn(async () => TX), chain: monadTestnet } as unknown as WalletClient<Transport, Chain, Account>;
    expect(createChainDripSender({ wallet }).confirm).toBeUndefined();
  });

  it('honours a custom amount', async () => {
    const sendTransaction = vi.fn(async () => TX);
    const wallet = { sendTransaction, chain: monadTestnet } as unknown as WalletClient<Transport, Chain, Account>;
    const sender = createChainDripSender({ wallet, amountMon: '0.1' });
    await sender.send(TO);
    expect(sendTransaction).toHaveBeenCalledWith(expect.objectContaining({ value: parseEther('0.1') }));
  });
});

describe('dripAccountFromEnv', () => {
  it('returns null when the key is unset or blank', () => {
    expect(dripAccountFromEnv({})).toBeNull();
    expect(dripAccountFromEnv({ DRIP_PRIVATE_KEY: '  ' })).toBeNull();
  });

  it('throws a clear error for a malformed key without echoing it', () => {
    expect(() => dripAccountFromEnv({ DRIP_PRIVATE_KEY: 'abc' })).toThrow(/DRIP_PRIVATE_KEY/);
    expect(() => dripAccountFromEnv({ DRIP_PRIVATE_KEY: 'abc' })).not.toThrow(/abc/);
  });

  it('derives the account from a valid key', () => {
    const account = dripAccountFromEnv({ DRIP_PRIVATE_KEY: PK });
    expect(account?.address).toBe('0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A');
  });

  it('attaches a nonce manager so overlapping sends never sign the same nonce (review C3)', async () => {
    const account = dripAccountFromEnv({ DRIP_PRIVATE_KEY: PK });
    expect(account?.nonceManager).toBeDefined();
    const node = nodeLikeWallet(account as Account);
    const nonces = await Promise.all(Array.from({ length: 5 }, () => node.wallet.sendTransaction({ to: TO } as never)));
    expect(new Set(nonces).size).toBe(5);
  });
});

describe('createChainDripSender RPC budget (W16)', () => {
  it('a drip is one nonce read and one raw send: chainId and the fixed fees are passed', async () => {
    const { methods, wallet } = recordingWallet();
    await createChainDripSender({ wallet }).send(TO);
    expect(methods).toEqual(['eth_getTransactionCount', 'eth_sendRawTransaction']);
  });
});
