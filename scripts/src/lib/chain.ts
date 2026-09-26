/**
 * viem-backed ChainAdapter. Transactions are signed locally and sent with
 * eth_sendRawTransaction and a fixed gas limit: no eth_estimateGas, no per-send chain id
 * lookup. Transports do not retry (retryCount 0) so rate limits show up in the report
 * instead of being hidden by back-off.
 */
import {
  createPublicClient,
  encodeFunctionData,
  http,
  webSocket,
  TransactionReceiptNotFoundError,
  type Address,
  type Hash,
  type LocalAccount,
  type PublicClient,
} from 'viem';
import { blockbeatAbi, chainById } from '@blockbeat/shared';
import type { ChainAdapter, Fees, HitLog, Receipt } from './runner';
import { TRANSFER_GAS } from './runner';

export interface ViemAdapterOptions {
  chainId: number;
  rpc: string;
  ws: string;
  address: Address;
  /** Polling interval used when no WebSocket URL is configured. */
  pollingIntervalMs?: number;
  /** Receives watcher errors (already redacted by the caller's logger). */
  onWarn?: (line: string) => void;
}

export interface ViemAdapter extends ChainAdapter {
  http: PublicClient;
  close(): Promise<void>;
}

export function createViemAdapter(opts: ViemAdapterOptions): ViemAdapter {
  const chain = chainById(opts.chainId);
  const pollingInterval = opts.pollingIntervalMs ?? 300;
  const httpClient = createPublicClient({ chain, transport: http(opts.rpc, { retryCount: 0 }), pollingInterval });
  const wsClient = opts.ws ? createPublicClient({ chain, transport: webSocket(opts.ws, { retryCount: 0 }), pollingInterval }) : null;
  const subscriber = wsClient ?? httpClient;
  const warn = opts.onWarn ?? ((line: string) => console.warn(line));

  async function sendSigned(from: LocalAccount, tx: { to: Address; value: bigint; data?: `0x${string}`; gas: bigint; nonce: number }, fees: Fees): Promise<Hash> {
    const serializedTransaction = await from.signTransaction({
      chainId: opts.chainId,
      type: 'eip1559',
      to: tx.to,
      value: tx.value,
      ...(tx.data ? { data: tx.data } : {}),
      gas: tx.gas,
      nonce: tx.nonce,
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    });
    return httpClient.sendRawTransaction({ serializedTransaction });
  }

  return {
    http: httpClient,
    getBlockNumber: () => httpClient.getBlockNumber({ cacheTime: 0 }),
    getBalance: (address) => httpClient.getBalance({ address }),
    getNonce: (address) => httpClient.getTransactionCount({ address, blockTag: 'pending' }),
    async getSessionStartBlock(sessionId) {
      const session = await httpClient.readContract({ address: opts.address, abi: blockbeatAbi, functionName: 'getSession', args: [sessionId] });
      return BigInt(session.startBlock);
    },
    async getFees() {
      const { maxFeePerGas, maxPriorityFeePerGas } = await httpClient.estimateFeesPerGas();
      return { maxFeePerGas, maxPriorityFeePerGas };
    },
    sendTransfer: (from, to, valueWei, nonce, fees) => sendSigned(from, { to, value: valueWei, gas: TRANSFER_GAS, nonce }, fees),
    sendHit: (from, sessionId, track, note, nonce, fees, gas) =>
      sendSigned(
        from,
        {
          to: opts.address,
          value: 0n,
          data: encodeFunctionData({ abi: blockbeatAbi, functionName: 'hit', args: [sessionId, track, note] }),
          gas,
          nonce,
        },
        fees,
      ),
    async getReceipt(hash): Promise<Receipt | null> {
      try {
        const r = await httpClient.getTransactionReceipt({ hash });
        return { blockNumber: r.blockNumber, status: r.status, gasUsed: r.gasUsed, effectiveGasPrice: r.effectiveGasPrice };
      } catch (err) {
        if (err instanceof TransactionReceiptNotFoundError) return null;
        throw err;
      }
    },
    watchHeads(cb) {
      return subscriber.watchBlockNumber({ onBlockNumber: cb, emitMissed: false, emitOnBegin: false, onError: (e) => warn(`heads: ${e.message}`) });
    },
    watchHits(sessionId, cb) {
      return subscriber.watchContractEvent({
        address: opts.address,
        abi: blockbeatAbi,
        eventName: 'Hit',
        args: { sessionId },
        strict: true,
        onLogs: (logs) => {
          for (const l of logs) {
            if (l.blockNumber === null || l.transactionHash === null) continue;
            const log: HitLog = { txHash: l.transactionHash, blockNumber: l.blockNumber, step: l.args.step, sessionId: l.args.sessionId, track: l.args.track, note: l.args.note };
            cb(log);
          }
        },
        onError: (e) => warn(`hits: ${e.message}`),
      });
    },
    async close() {
      if (!wsClient) return;
      const client = await wsClient.transport.getRpcClient();
      client.close();
    },
  };
}
