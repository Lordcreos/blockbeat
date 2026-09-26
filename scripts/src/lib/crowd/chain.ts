/**
 * W19: viem-backed CrowdChain. Every transaction is signed locally with the fixed gas tiers
 * and fixed EIP-1559 fees from @blockbeat/shared and sent with eth_sendRawTransaction: no
 * eth_estimateGas, no fee or chain-id lookups in the hot path. Heads, Hit logs and Finalized
 * come from one WebSocket (polling when there is none). Transports do not retry, so a rate
 * limit shows up as a send failure instead of a hidden back-off.
 */
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  encodeFunctionData,
  http,
  webSocket,
  TransactionReceiptNotFoundError,
  type Address,
  type Hash,
  type LocalAccount,
} from 'viem';
import { HIT_MAX_FEE_PER_GAS, HIT_MAX_PRIORITY_FEE_PER_GAS, blockbeatAbi, chainById, isTrackId, type TrackId } from '@blockbeat/shared';
import { TRANSFER_GAS } from '../runner';
import type { CrowdChain, CrowdHit, Receipt } from './engine';

export interface CrowdViemOptions {
  chainId: number;
  rpc: string;
  ws: string;
  address: Address;
  pollingIntervalMs?: number;
  onWarn: (line: string) => void;
}

/** getSession reverts SessionNotFound() for an id that was never started. */
export function isSessionNotFound(error: unknown): boolean {
  if (!(error instanceof BaseError)) return false;
  const revert = error.walk((e) => e instanceof ContractFunctionRevertedError);
  return revert instanceof ContractFunctionRevertedError && revert.data?.errorName === 'SessionNotFound';
}

/** The public RPC refuses wide eth_getLogs ranges; 100 blocks answer in ~300 ms (ADR 0001). */
const LOG_CHUNK_BLOCKS = 100n;

export function createCrowdChain(opts: CrowdViemOptions): CrowdChain & { getChainId(): Promise<number>; close(): Promise<void> } {
  const chain = chainById(opts.chainId);
  const pollingInterval = opts.pollingIntervalMs ?? 300;
  const httpClient = createPublicClient({ chain, transport: http(opts.rpc, { retryCount: 0 }), pollingInterval });
  const wsClient = opts.ws ? createPublicClient({ chain, transport: webSocket(opts.ws, { retryCount: 0 }), pollingInterval }) : null;
  const subscriber = wsClient ?? httpClient;

  async function send(from: LocalAccount, tx: { to: Address; value: bigint; data?: `0x${string}`; gas: bigint; nonce: number }): Promise<Hash> {
    const serializedTransaction = await from.signTransaction({
      chainId: opts.chainId,
      type: 'eip1559',
      to: tx.to,
      value: tx.value,
      ...(tx.data ? { data: tx.data } : {}),
      gas: tx.gas,
      nonce: tx.nonce,
      maxFeePerGas: HIT_MAX_FEE_PER_GAS,
      maxPriorityFeePerGas: HIT_MAX_PRIORITY_FEE_PER_GAS,
    });
    return httpClient.sendRawTransaction({ serializedTransaction });
  }

  type HitArgs = { sessionId: bigint; player: Address; blockNumber: bigint; step: number; track: number; note: number; on: boolean };
  const toHit = (l: { args: HitArgs; blockNumber: bigint | null; logIndex: number | null; transactionHash: Hash | null }): CrowdHit | null => {
    if (l.blockNumber === null || l.logIndex === null || l.transactionHash === null || !isTrackId(l.args.track)) return null;
    const track: TrackId = l.args.track;
    return { txHash: l.transactionHash, blockNumber: l.blockNumber, logIndex: l.logIndex, step: l.args.step, track, note: l.args.note, player: l.args.player, on: l.args.on };
  };

  return {
    getChainId: () => httpClient.getChainId(),
    getBlockNumber: () => httpClient.getBlockNumber({ cacheTime: 0 }),
    getBalance: (address) => httpClient.getBalance({ address }),
    getNonce: (address) => httpClient.getTransactionCount({ address, blockTag: 'pending' }),
    async getSession(sessionId) {
      try {
        const s = await httpClient.readContract({ address: opts.address, abi: blockbeatAbi, functionName: 'getSession', args: [sessionId] });
        return { startBlock: BigInt(s.startBlock), finalized: s.finalized };
      } catch (error) {
        if (isSessionNotFound(error)) return { startBlock: 0n, finalized: false };
        throw error;
      }
    },
    async getRecentHits(sessionId, fromBlock, toBlock) {
      const out: CrowdHit[] = [];
      for (let from = fromBlock; from <= toBlock; from += LOG_CHUNK_BLOCKS) {
        const to = from + LOG_CHUNK_BLOCKS - 1n < toBlock ? from + LOG_CHUNK_BLOCKS - 1n : toBlock;
        const logs = await httpClient.getContractEvents({ address: opts.address, abi: blockbeatAbi, eventName: 'Hit', args: { sessionId }, fromBlock: from, toBlock: to, strict: true });
        for (const l of logs) {
          const hit = toHit(l);
          if (hit) out.push(hit);
        }
      }
      return out;
    },
    sendTransfer: (from, to, value, nonce) => send(from, { to, value, gas: TRANSFER_GAS, nonce }),
    sendHit: (from, sessionId, track, note, nonce, gas) =>
      send(from, { to: opts.address, value: 0n, data: encodeFunctionData({ abi: blockbeatAbi, functionName: 'hit', args: [sessionId, track, note] }), gas, nonce }),
    async getReceipt(hash): Promise<Receipt | null> {
      try {
        const r = await httpClient.getTransactionReceipt({ hash });
        return { blockNumber: r.blockNumber, status: r.status };
      } catch (error) {
        if (error instanceof TransactionReceiptNotFoundError) return null;
        throw error;
      }
    },
    watchHeads(cb) {
      return subscriber.watchBlockNumber({ onBlockNumber: cb, emitMissed: false, emitOnBegin: false, onError: (e) => opts.onWarn(`heads: ${e.message}`) });
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
            const hit = toHit(l);
            if (hit) cb(hit);
          }
        },
        onError: (e) => opts.onWarn(`hits: ${e.message}`),
      });
    },
    watchFinalized(sessionId, cb) {
      return subscriber.watchContractEvent({
        address: opts.address,
        abi: blockbeatAbi,
        eventName: 'Finalized',
        args: { sessionId },
        strict: true,
        onLogs: (logs) => {
          if (logs.length > 0) cb();
        },
        onError: (e) => opts.onWarn(`finalized: ${e.message}`),
      });
    },
    async close() {
      if (!wsClient) return;
      const client = await wsClient.transport.getRpcClient();
      client.close();
    },
  };
}
