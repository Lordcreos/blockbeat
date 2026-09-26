/**
 * Chain-backed EventSource: `pattern()` and `getSession()` via readContract, `Hit` logs via
 * watchContractEvent over WebSocket (eth_subscribe) or HTTP polling. W13: past `Hit` logs
 * via getContractEvents (eth_getLogs, the feed keeps each range to 100 blocks) and the head.
 */
import type { Address, Hash, PublicClient } from 'viem';
import {
  STEPS,
  ZERO_ADDRESS,
  blockbeatAbi,
  isNote,
  isTrackId,
  type HitEvent,
  type Pattern,
  type SessionState,
} from '@blockbeat/shared';
import type { EventSource, HitRange, HitRangeQuery, HitWatchArgs, TipWatchArgs } from '../eventFeed';
import type { TipEvent } from '../types';

export class HitDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HitDecodeError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** The fields of a strict `Hit` log this module needs (structurally satisfied by viem's Log). */
export interface RawHitLog {
  args: {
    sessionId: bigint;
    player: Address;
    blockNumber: bigint;
    step: number;
    track: number;
    note: number;
    on: boolean;
  };
  blockNumber: bigint | null;
  transactionHash: Hash | null;
  logIndex: number | null;
}

export function decodeHitLog(log: RawHitLog): HitEvent {
  const { args } = log;
  if (log.transactionHash === null || log.logIndex === null) {
    throw new HitDecodeError('Hit log is pending: missing transactionHash or logIndex');
  }
  if (!isTrackId(args.track)) throw new HitDecodeError(`Hit log has track ${args.track} out of range`);
  if (!isNote(args.note)) throw new HitDecodeError(`Hit log has note ${args.note} out of range`);
  if (!Number.isInteger(args.step) || args.step < 0 || args.step >= STEPS) {
    throw new HitDecodeError(`Hit log has step ${args.step} out of range`);
  }
  return {
    sessionId: args.sessionId,
    player: args.player,
    blockNumber: log.blockNumber ?? args.blockNumber,
    step: args.step,
    track: args.track,
    note: args.note,
    on: args.on,
    txHash: log.transactionHash,
    logIndex: log.logIndex,
  };
}

/** The fields of a strict `Tipped` log this module needs (W12). */
export interface RawTipLog {
  args: { sessionId: bigint; from: Address; amount: bigint };
  blockNumber: bigint | null;
  transactionHash: Hash | null;
  logIndex: number | null;
}

export function decodeTipLog(log: RawTipLog): TipEvent {
  if (log.transactionHash === null || log.logIndex === null || log.blockNumber === null) {
    throw new HitDecodeError('Tipped log is pending: missing transactionHash, logIndex or blockNumber');
  }
  return {
    sessionId: log.args.sessionId,
    from: log.args.from,
    amountWei: log.args.amount,
    blockNumber: log.blockNumber,
    txHash: log.transactionHash,
    logIndex: log.logIndex,
  };
}

export interface ChainEventSourceOptions {
  ws: PublicClient | null;
  http: PublicClient;
  address: Address;
}

export function createChainEventSource(options: ChainEventSourceOptions): EventSource {
  const { ws, http, address } = options;

  return {
    async readPattern(sessionId): Promise<Pattern> {
      const words = await http.readContract({ address, abi: blockbeatAbi, functionName: 'pattern', args: [sessionId] });
      return [...words];
    },

    async readSession(sessionId): Promise<SessionState | null> {
      const s = await http.readContract({ address, abi: blockbeatAbi, functionName: 'getSession', args: [sessionId] });
      if (s.host === ZERO_ADDRESS && s.startBlock === 0n) return null;
      return {
        sessionId,
        startBlock: s.startBlock,
        host: s.host,
        finalized: s.finalized,
        hitCount: s.hitCount,
        tokenId: s.tokenId,
        parentSessionId: s.parentSessionId,
        tipPool: s.tipPool,
      };
    },

    async readHits({ sessionId, fromBlock, toBlock, player }: HitRangeQuery): Promise<HitRange> {
      const logs = await http.getContractEvents({
        address,
        abi: blockbeatAbi,
        eventName: 'Hit',
        args: player ? { sessionId, player } : { sessionId },
        fromBlock,
        toBlock,
        strict: true,
      });
      const hits: HitEvent[] = [];
      let decodeErrors = 0;
      for (const log of logs) {
        try {
          hits.push(decodeHitLog(log));
        } catch (error) {
          if (!(error instanceof HitDecodeError)) throw error;
          decodeErrors += 1;
        }
      }
      return { hits, decodeErrors };
    },

    readHead(): Promise<bigint> {
      return http.getBlockNumber({ cacheTime: 0 });
    },

    watchHits({ sessionId, mode, pollingIntervalMs, onHits, onError }: HitWatchArgs): () => void {
      const onLogs = (logs: readonly RawHitLog[]): void => {
        const hits: HitEvent[] = [];
        for (const log of logs) {
          try {
            hits.push(decodeHitLog(log));
          } catch (error) {
            onError(error instanceof Error ? error : new Error(String(error)));
          }
        }
        if (hits.length > 0) onHits(hits);
      };
      const common = { address, abi: blockbeatAbi, eventName: 'Hit', args: { sessionId }, strict: true, onLogs, onError } as const;
      if (mode === 'ws' && ws) {
        // No `poll` flag: on a webSocket transport viem uses eth_subscribe.
        return ws.watchContractEvent(common);
      }
      return http.watchContractEvent({ ...common, poll: true, pollingInterval: pollingIntervalMs ?? 400 });
    },

    watchTips({ sessionId, mode, pollingIntervalMs, onTips, onError }: TipWatchArgs): () => void {
      const onLogs = (logs: readonly RawTipLog[]): void => {
        const tips: TipEvent[] = [];
        for (const log of logs) {
          try {
            tips.push(decodeTipLog(log));
          } catch (error) {
            onError(error instanceof Error ? error : new Error(String(error)));
          }
        }
        if (tips.length > 0) onTips(tips);
      };
      const common = { address, abi: blockbeatAbi, eventName: 'Tipped', args: { sessionId }, strict: true, onLogs, onError } as const;
      if (mode === 'ws' && ws) return ws.watchContractEvent(common);
      return http.watchContractEvent({ ...common, poll: true, pollingInterval: pollingIntervalMs ?? 400 });
    },
  };
}
