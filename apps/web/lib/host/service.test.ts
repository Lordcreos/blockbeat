import { describe, expect, it, vi } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, type Hash, type Hex, type Log } from 'viem';
import { blockbeatAbi } from '@blockbeat/shared';
import { createChainHostService, createMockHostService, FINALIZE_GAS_LIMIT, HostError, START_SESSION_GAS_LIMIT } from './service';

const ADDRESS = '0x5FbDB2315678afecb367f032d93F642f64180aa3' as const;
const HOST = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC' as const;
const TX = `0x${'ab'.repeat(32)}` as Hash;

function sessionStartedLog(sessionId: bigint): Log {
  return {
    address: ADDRESS,
    topics: encodeEventTopics({ abi: blockbeatAbi, eventName: 'SessionStarted', args: { sessionId, host: HOST, parentSessionId: 0n } }) as [Hex, ...Hex[]],
    data: encodeAbiParameters([{ type: 'uint64' }], [123n]),
    blockNumber: 10n,
    transactionHash: TX,
    logIndex: 0,
    blockHash: `0x${'00'.repeat(32)}`,
    transactionIndex: 0,
    removed: false,
  };
}

function finalizedLog(sessionId: bigint, tokenId: bigint, contributors: bigint): Log {
  return {
    address: ADDRESS,
    topics: encodeEventTopics({ abi: blockbeatAbi, eventName: 'Finalized', args: { sessionId, tokenId } }) as [Hex, ...Hex[]],
    data: encodeAbiParameters([{ type: 'uint256' }], [contributors]),
    blockNumber: 11n,
    transactionHash: TX,
    logIndex: 0,
    blockHash: `0x${'00'.repeat(32)}`,
    transactionIndex: 0,
    removed: false,
  };
}

function deps(logs: Log[], status: 'success' | 'reverted' = 'success') {
  const writeContract = vi.fn(async () => TX);
  const waitForTransactionReceipt = vi.fn(async () => ({ status, logs, blockNumber: 10n }));
  const service = createChainHostService({
    wallet: { writeContract } as never,
    publicClient: { waitForTransactionReceipt } as never,
    address: ADDRESS,
  });
  return { service, writeContract, waitForTransactionReceipt };
}

describe('chain host service', () => {
  it('starts a session with a fixed gas limit and returns the id from the SessionStarted log', async () => {
    const { service, writeContract } = deps([sessionStartedLog(7n)]);
    const result = await service.startSession();
    expect(result).toEqual({ sessionId: 7n, txHash: TX });
    expect(writeContract).toHaveBeenCalledWith(expect.objectContaining({ address: ADDRESS, functionName: 'startSession', gas: START_SESSION_GAS_LIMIT }));
  });

  it('finalizes with a fixed gas limit and returns tokenId and contributors from the Finalized log', async () => {
    const { service, writeContract } = deps([finalizedLog(7n, 3n, 12n)]);
    const result = await service.finalize(7n);
    expect(result).toEqual({ sessionId: 7n, tokenId: 3n, contributors: 12n, txHash: TX });
    expect(writeContract).toHaveBeenCalledWith(expect.objectContaining({ functionName: 'finalize', args: [7n], gas: FINALIZE_GAS_LIMIT }));
  });

  it('rejects with TX_REVERTED when the receipt status is reverted', async () => {
    const { service } = deps([], 'reverted');
    await expect(service.finalize(7n)).rejects.toMatchObject({ code: 'TX_REVERTED' });
  });

  it('rejects with LOG_MISSING when the expected event is absent', async () => {
    const { service } = deps([]);
    await expect(service.startSession()).rejects.toMatchObject({ code: 'LOG_MISSING' });
  });

  it('wraps send failures as SEND_FAILED, logging the RPC detail server-side and keeping it out of the error', async () => {
    const writeContract = vi.fn(async () => {
      throw new Error('HTTP request failed. URL: https://rpc.example/v2/SECRET_KEY nonce too low');
    });
    const log = vi.fn();
    const service = createChainHostService({ wallet: { writeContract } as never, publicClient: {} as never, address: ADDRESS, log });
    const err = await service.startSession().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HostError);
    expect((err as HostError).code).toBe('SEND_FAILED');
    expect((err as HostError).message).not.toContain('SECRET_KEY');
    expect((err as HostError).message).toMatch(/startSession/);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('SECRET_KEY'));
  });

  it('serialises concurrent calls so the host nonce never collides', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const writeContract = vi.fn(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return TX;
    });
    const waitForTransactionReceipt = vi.fn(async () => ({ status: 'success', logs: [sessionStartedLog(1n)], blockNumber: 1n }));
    const service = createChainHostService({ wallet: { writeContract } as never, publicClient: { waitForTransactionReceipt } as never, address: ADDRESS });
    await Promise.all([service.startSession(), service.startSession(), service.startSession()]);
    expect(maxInFlight).toBe(1);
  });
});

describe('mock host service', () => {
  it('hands out increasing session ids from 1 and mints token = session id with no tx', async () => {
    const service = createMockHostService();
    expect(await service.startSession()).toEqual({ sessionId: 1n, txHash: null });
    expect(await service.startSession()).toEqual({ sessionId: 2n, txHash: null });
    expect(await service.finalize(2n)).toEqual({ sessionId: 2n, tokenId: 2n, contributors: 0n, txHash: null });
  });
});
