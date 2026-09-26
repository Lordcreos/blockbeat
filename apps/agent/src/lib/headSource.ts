/**
 * Chain head source: `newHeads` over WebSocket (viem watchBlockNumber, which uses
 * eth_subscribe on a webSocket transport) with an HTTP polling fallback when the socket fails.
 * While polling, the socket is tried again every 30 s and the poller is dropped as soon as
 * a head arrives over it (review L4).
 */
import type { PublicClient, WatchBlockNumberParameters } from 'viem';
import type { HeadSource, HeadSourceKind } from './blockClock';

/** The one method the head source needs from a viem PublicClient. */
export type WatchClient = Pick<PublicClient, 'watchBlockNumber'>;

export interface ChainHeadSourceOptions {
  /** WebSocket-transport client; null forces polling. */
  ws: WatchClient | null;
  /** HTTP-transport client used for the polling fallback. */
  http: WatchClient;
  pollingIntervalMs?: number;
  /** While polling: how often to try the socket again. */
  wsRetryIntervalMs?: number;
  warn: (message: string) => void;
}

export const WS_RETRY_INTERVAL_MS = 30_000;

export function createChainHeadSource(options: ChainHeadSourceOptions): HeadSource {
  const { ws, http, warn } = options;
  const pollingIntervalMs = options.pollingIntervalMs ?? 400;
  const wsRetryIntervalMs = options.wsRetryIntervalMs ?? WS_RETRY_INTERVAL_MS;
  let kind: HeadSourceKind = ws ? 'ws' : 'poll';

  return {
    kind: () => kind,
    subscribe(onHead, onError) {
      let unwatchWs: (() => void) | null = null;
      let unwatchPoll: (() => void) | null = null;
      let retryTimer: ReturnType<typeof setTimeout> | null = null;
      let stopped = false;

      function poll(): void {
        kind = 'poll';
        const params: WatchBlockNumberParameters = {
          poll: true,
          pollingInterval: pollingIntervalMs,
          emitMissed: false,
          onBlockNumber: onHead,
          onError,
        };
        unwatchPoll = http.watchBlockNumber(params);
        if (ws) retryTimer = setTimeout(subscribeWs, wsRetryIntervalMs);
      }

      /** First subscription and every retry. While a poller runs, the first head over the socket ends it. */
      function subscribeWs(): void {
        if (!ws || stopped) return;
        retryTimer = null;
        let mine: (() => void) | null = null;
        mine = ws.watchBlockNumber({
          onBlockNumber(head) {
            if (stopped || unwatchWs !== mine) return;
            if (unwatchPoll) {
              unwatchPoll();
              unwatchPoll = null;
              kind = 'ws';
              warn('blockClock: newHeads subscription is back; polling stopped');
            }
            onHead(head);
          },
          onError(error) {
            onError(error);
            if (stopped || unwatchWs !== mine) return;
            unwatchWs = null;
            mine?.();
            if (unwatchPoll) {
              retryTimer = setTimeout(subscribeWs, wsRetryIntervalMs);
              return;
            }
            warn(`blockClock: newHeads subscription failed (${error.message}); polling every ${pollingIntervalMs} ms`);
            poll();
          },
        });
        unwatchWs = mine;
      }

      if (ws) {
        kind = 'ws';
        subscribeWs();
      } else {
        poll();
      }

      return () => {
        stopped = true;
        if (retryTimer !== null) clearTimeout(retryTimer);
        retryTimer = null;
        unwatchWs?.();
        unwatchWs = null;
        unwatchPoll?.();
        unwatchPoll = null;
      };
    },
  };
}
