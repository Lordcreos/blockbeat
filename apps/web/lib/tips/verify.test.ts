import { describe, expect, it, vi } from 'vitest';
import { TransactionReceiptNotFoundError, encodeAbiParameters, encodeEventTopics, type Address, type Hash, type Log } from 'viem';
import { blockbeatAbi } from '@blockbeat/shared';
import { TipVerifyError, verifyTipTx, type ReceiptClient } from './verify';

const CONTRACT = '0x00000000000000000000000000000000000c0de1' as Address;
const OTHER = '0x00000000000000000000000000000000000bad00' as Address;
const FROM = '0x1111111111111111111111111111111111111111' as Address;
const TX = `0x${'ab'.repeat(32)}` as Hash;

function tippedLog(sessionId: bigint, amount: bigint, address: Address = CONTRACT): Log {
  return {
    address,
    topics: encodeEventTopics({ abi: blockbeatAbi, eventName: 'Tipped', args: { sessionId, from: FROM } }) as Log['topics'],
    data: encodeAbiParameters([{ type: 'uint256' }], [amount]),
    blockHash: `0x${'11'.repeat(32)}`,
    blockNumber: 500n,
    logIndex: 0,
    transactionHash: TX,
    transactionIndex: 0,
    removed: false,
  };
}

function splitLog(sessionId: bigint, hostAmount: bigint, poolAmount: bigint, address: Address = CONTRACT): Log {
  return {
    ...tippedLog(sessionId, 0n, address),
    topics: encodeEventTopics({ abi: blockbeatAbi, eventName: 'TipSplit', args: { sessionId } }) as Log['topics'],
    data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [hostAmount, poolAmount]),
    logIndex: 1,
  };
}

function client(receipt: { status: 'success' | 'reverted'; logs: Log[]; blockNumber?: bigint } | Error): ReceiptClient {
  return {
    getTransactionReceipt: vi.fn(async () => {
      if (receipt instanceof Error) throw receipt;
      return { status: receipt.status, logs: receipt.logs, blockNumber: receipt.blockNumber ?? 500n };
    }),
  };
}

describe('verifyTipTx (W21b: a note needs a real Tipped log)', () => {
  it('reads the tipper, the amount and the block from the Tipped log of the session', async () => {
    const tip = await verifyTipTx({ client: client({ status: 'success', logs: [tippedLog(7n, 20n)] }), address: CONTRACT, sessionId: 7n, txHash: TX });
    expect(tip).toEqual({ from: FROM, amountWei: 20n, blockNumber: 500n, hostWei: null, poolWei: null });
  });

  it('W21a: reads the host and pool amounts from the TipSplit log of the same tx', async () => {
    const tip = await verifyTipTx({ client: client({ status: 'success', logs: [tippedLog(7n, 20n), splitLog(7n, 4n, 16n)] }), address: CONTRACT, sessionId: 7n, txHash: TX });
    expect(tip).toMatchObject({ amountWei: 20n, hostWei: 4n, poolWei: 16n });
  });

  it('W21a: ignores a TipSplit from another contract or session', async () => {
    const logs = [tippedLog(7n, 20n), splitLog(7n, 4n, 16n, OTHER), splitLog(8n, 1n, 1n)];
    const tip = await verifyTipTx({ client: client({ status: 'success', logs }), address: CONTRACT, sessionId: 7n, txHash: TX });
    expect(tip).toMatchObject({ hostWei: null, poolWei: null });
  });

  it('matches the contract address case-insensitively', async () => {
    const tip = await verifyTipTx({ client: client({ status: 'success', logs: [tippedLog(7n, 20n)] }), address: CONTRACT.toUpperCase().replace('0X', '0x') as Address, sessionId: 7n, txHash: TX });
    expect(tip.amountWei).toBe(20n);
  });

  it('refuses a Tipped log from another contract (a copycat emitting the same event)', async () => {
    await expect(verifyTipTx({ client: client({ status: 'success', logs: [tippedLog(7n, 20n, OTHER)] }), address: CONTRACT, sessionId: 7n, txHash: TX })).rejects.toMatchObject({ code: 'NOT_A_TIP' });
  });

  it('refuses a tip to another session', async () => {
    await expect(verifyTipTx({ client: client({ status: 'success', logs: [tippedLog(8n, 20n)] }), address: CONTRACT, sessionId: 7n, txHash: TX })).rejects.toMatchObject({ code: 'NOT_A_TIP' });
  });

  it('refuses a transaction without any Tipped log', async () => {
    await expect(verifyTipTx({ client: client({ status: 'success', logs: [] }), address: CONTRACT, sessionId: 7n, txHash: TX })).rejects.toMatchObject({ code: 'NOT_A_TIP' });
  });

  it('refuses a reverted transaction', async () => {
    await expect(verifyTipTx({ client: client({ status: 'reverted', logs: [] }), address: CONTRACT, sessionId: 7n, txHash: TX })).rejects.toMatchObject({ code: 'REVERTED' });
  });

  it('reports a receipt the node does not have yet as NOT_FOUND (the phone retries)', async () => {
    const err = new TransactionReceiptNotFoundError({ hash: TX });
    await expect(verifyTipTx({ client: client(err), address: CONTRACT, sessionId: 7n, txHash: TX })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('wraps any other RPC failure without leaking its text (it embeds the RPC URL)', async () => {
    const failure = verifyTipTx({ client: client(new Error('fetch failed https://rpc.example/key=secret')), address: CONTRACT, sessionId: 7n, txHash: TX });
    await expect(failure).rejects.toBeInstanceOf(TipVerifyError);
    await expect(failure).rejects.toMatchObject({ code: 'RPC_ERROR', message: expect.not.stringContaining('secret') });
  });
});
