/**
 * viem adapters: clients, the chain-backed HitSender (fixed gas and fees, local nonce
 * manager, confirmation from the Hit log stream) and the ERC-8004 IdentityChain. This is
 * the only module that talks to the RPC for writes.
 *
 * Review M4: the agent shares the laptop's IP with the stage and the drip route. Receipts
 * used to be polled every 150 ms per in-flight hit (~7 rps each); now one Hit log
 * subscription (ws, or http polling at 300 ms) confirms every hit and one
 * eth_getTransactionReceipt per landed hit fetches gasUsed.
 */
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeFunctionData,
  http,
  nonceManager,
  parseEventLogs,
  webSocket,
  type Account,
  type Address,
  type Chain,
  type Hash,
  type Hex,
  type PublicClient,
  type TransactionSerializableEIP1559,
  type Transport,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import {
  BLOCK_MS,
  HIT_GAS_LIMIT,
  HIT_GAS_LIMIT_FIRST,
  HIT_MAX_FEE_PER_GAS,
  HIT_MAX_PRIORITY_FEE_PER_GAS,
  SUPPORTED_CHAINS,
  blockbeatAbi,
  chainById,
  isNote,
  isTrackId,
  type SessionState,
  type TrackId,
} from '@blockbeat/shared';
import type { AgentConfig } from '../config';
import { REGISTER_GAS_LIMIT, erc8004IdentityAbi, type IdentityChain } from './identity';
import type { HitLanding, HitSender } from './scheduler';

export interface Clients {
  chain: Chain;
  account: PrivateKeyAccount;
  http: PublicClient;
  /** W17: JSON-RPC batching (requests made in the same tick go in one POST, in order) for the hit broadcasts. */
  batchHttp: PublicClient;
  ws: PublicClient | null;
  wallet: WalletClient<Transport, Chain, Account>;
}

export function createClients(config: Pick<AgentConfig, 'chainId' | 'rpcUrl' | 'wsUrl' | 'privateKey'>): Clients {
  // chainById defaults unknown ids to Monad testnet; sign with the configured id instead.
  const chain: Chain =
    config.chainId in SUPPORTED_CHAINS
      ? chainById(config.chainId)
      : defineChain({
          id: config.chainId,
          name: `chain ${config.chainId}`,
          nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
          rpcUrls: { default: { http: [config.rpcUrl], ...(config.wsUrl ? { webSocket: [config.wsUrl] } : {}) } },
        });
  // Local nonce manager: the first nonce is fetched once, then incremented in memory so
  // several hits in flight never collide.
  const account = privateKeyToAccount(config.privateKey, { nonceManager });
  // 300 ms: one block. viem's 4 s default is too slow for the clock fallback and 150 ms was ~7 rps per waiter.
  const httpClient = createPublicClient({ chain, transport: http(config.rpcUrl), pollingInterval: BLOCK_MS });
  const wsClient = config.wsUrl ? createPublicClient({ chain, transport: webSocket(config.wsUrl, { reconnect: true }) }) : null;
  const wallet = createWalletClient({ chain, account, transport: http(config.rpcUrl) });
  // W17: the Monad public RPC answers JSON-RPC batches (probed 2026-09-25); wait 0 = one POST per tick.
  const batchHttp = createPublicClient({ chain, transport: http(config.rpcUrl, { batch: { wait: 0 } }), pollingInterval: BLOCK_MS });
  return { chain, account, http: httpClient, batchHttp, ws: wsClient, wallet };
}

export async function readSession(client: PublicClient, address: Address, sessionId: bigint): Promise<SessionState> {
  const s = await client.readContract({ address, abi: blockbeatAbi, functionName: 'getSession', args: [sessionId] });
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
}

/** A decoded Hit log as the stream delivers it. */
export interface SeenHit {
  txHash: Hash;
  sessionId: bigint;
  blockNumber: bigint;
  step: number;
  on: boolean;
}

/** One subscription to this session's Hit logs, shared by every in-flight confirmation. */
export interface HitLogStream {
  onHit(cb: (hit: SeenHit) => void): () => void;
  stop(): void;
}

export interface HitLogStreamOptions {
  ws: PublicClient | null;
  http: PublicClient;
  address: Address;
  sessionId: bigint;
  pollingIntervalMs?: number;
  /** While polling: how often the socket subscription is attempted again (review L4). */
  wsRetryIntervalMs?: number;
  warn: (message: string) => void;
}

export const HIT_STREAM_WS_RETRY_MS = 30_000;

interface RawHitLog {
  args: { sessionId: bigint; step: number; on: boolean };
  transactionHash: Hash | null;
  blockNumber: bigint | null;
}

export function createHitLogStream(options: HitLogStreamOptions): HitLogStream {
  const { ws, http, address, sessionId, warn } = options;
  const pollingInterval = options.pollingIntervalMs ?? BLOCK_MS;
  const wsRetryIntervalMs = options.wsRetryIntervalMs ?? HIT_STREAM_WS_RETRY_MS;
  const listeners = new Set<(hit: SeenHit) => void>();
  let unwatchWs: (() => void) | null = null;
  let unwatchPoll: (() => void) | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const onLogs = (logs: readonly RawHitLog[]): void => {
    for (const log of logs) {
      if (log.transactionHash === null || log.blockNumber === null) continue; // pending log; the mined one follows
      const hit: SeenHit = { txHash: log.transactionHash, sessionId: log.args.sessionId, blockNumber: log.blockNumber, step: log.args.step, on: log.args.on };
      for (const cb of listeners) cb(hit);
    }
  };
  const common = { address, abi: blockbeatAbi, eventName: 'Hit', args: { sessionId }, strict: true, onLogs } as const;

  function poll(): void {
    unwatchPoll = http.watchContractEvent({ ...common, poll: true, pollingInterval, onError: (error) => warn(`hit stream: polling error: ${error.message}`) });
    if (ws) retryTimer = setTimeout(subscribeWs, wsRetryIntervalMs);
  }

  /** First subscription and every retry; the first logs delivered over the socket end the poller. */
  function subscribeWs(): void {
    if (!ws || stopped) return;
    retryTimer = null;
    let mine: (() => void) | null = null;
    // No `poll` flag: on a webSocket transport viem uses eth_subscribe.
    mine = ws.watchContractEvent({
      ...common,
      onLogs(logs) {
        if (stopped || unwatchWs !== mine) return;
        if (unwatchPoll) {
          unwatchPoll();
          unwatchPoll = null;
          warn('hit stream: socket is back; polling stopped');
        }
        onLogs(logs);
      },
      onError(error) {
        if (stopped || unwatchWs !== mine) return;
        unwatchWs = null;
        mine?.();
        if (unwatchPoll) {
          retryTimer = setTimeout(subscribeWs, wsRetryIntervalMs);
          return;
        }
        warn(`hit stream: socket failed (${error.message}); polling every ${pollingInterval} ms`);
        poll();
      },
    });
    unwatchWs = mine;
  }

  if (ws) subscribeWs();
  else poll();

  return {
    onHit(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    stop() {
      stopped = true;
      if (retryTimer !== null) clearTimeout(retryTimer);
      retryTimer = null;
      unwatchWs?.();
      unwatchWs = null;
      unwatchPoll?.();
      unwatchPoll = null;
      listeners.clear();
    },
  };
}

export interface ChainHitSenderOptions {
  wallet: WalletClient<Transport, Chain, Account>;
  publicClient: PublicClient;
  address: Address;
  sessionId: bigint;
  /**
   * Whether this wallet already has a hit in the session (`hitsOf > 0`). Monad charges the
   * gas LIMIT, so the first hit (contributor push) uses HIT_GAS_LIMIT_FIRST and every hit
   * after a confirmed landing uses the lower HIT_GAS_LIMIT.
   */
  hasHitBefore: boolean;
  /**
   * Hit logs for this session. With it, `confirm` resolves on the log and reads the receipt
   * once for gasUsed; without it, `confirm` polls the receipt (tests, one-off scripts).
   */
  hits?: HitLogStream;
  /** Confirmation timeout; a few blocks is plenty on Monad and anvil. */
  confirmTimeoutMs?: number;
  warn?: (message: string) => void;
  /**
   * W17: sign locally and broadcast the hits of one step together. A phrase puts 3-4 notes on
   * one step (kick, bass, pad on the downbeat); one writeContract after another took a round trip
   * each, so the last notes landed a block or two late. Hits sent in the same tick get consecutive
   * nonces from a local counter (read once from the pending count, re-read after any rejected
   * broadcast so a gap never stalls the queue) and go out in order in one JSON-RPC batch.
   */
  batch?: BatchSendOptions;
}

export interface BatchSendOptions {
  signer: { address: Address; signTransaction(tx: TransactionSerializableEIP1559): Promise<Hex> };
  rpc: { sendRawTransaction(args: { serializedTransaction: Hex }): Promise<Hash> };
  chainId: number;
  /** The one nonce authority of the account (shared with the ERC-8004 register tx; review). */
  nonces: NonceSource;
}

/**
 * W17 (TS review): the single nonce authority of the agent account. The batched hit sender and the
 * ERC-8004 register tx both take their nonces here, so two counters never hand out the same one.
 */
export interface NonceSource {
  /** Reserve `count` consecutive nonces and return the first. Calls are serialised, so ranges never overlap. */
  take(count: number): Promise<number>;
  /**
   * A broadcast with nonce `failed` was rejected: the next take re-reads the pending count, but never
   * goes below `failed`. That fills the gap (later nonces would wait behind it forever) and never
   * reuses a nonce already broadcast when a lagging node reports an old count.
   */
  resync(failed: number): void;
}

export function createNonceSource(readPending: () => Promise<number>): NonceSource {
  let next: number | null = null;
  let floor = 0;
  let queue: Promise<unknown> = Promise.resolve();
  return {
    take(count) {
      const reserved = queue.then(async () => {
        if (next === null) next = Math.max(await readPending(), floor);
        const first = next;
        next += count;
        return first;
      });
      // A failed read must not poison later takes: they retry the read.
      queue = reserved.catch(() => undefined);
      return reserved;
    },
    resync(failed) {
      floor = Math.max(floor, failed);
      next = null;
    },
  };
}

interface QueuedHit {
  track: TrackId;
  note: number;
  resolve: (hash: Hash) => void;
  reject: (error: unknown) => void;
}

/** Hits seen on the stream before their confirm() was called are kept this long. */
const SEEN_TTL_MS = 60_000;

export function createChainHitSender(options: ChainHitSenderOptions): HitSender {
  const { wallet, publicClient, address, sessionId, hits } = options;
  const confirmTimeoutMs = options.confirmTimeoutMs ?? 15_000;
  const warn = options.warn ?? (() => undefined);
  let landed = options.hasHitBefore;
  /** W17: the gas limit each hit was sent with, so its confirmation can report the MON charged. */
  const gasOf = new Map<Hash, bigint>();

  const seen = new Map<Hash, { hit: SeenHit; at: number }>();
  const waiters = new Map<Hash, (hit: SeenHit) => void>();
  hits?.onHit((hit) => {
    if (hit.sessionId !== sessionId) return;
    const waiter = waiters.get(hit.txHash);
    if (waiter) {
      waiter(hit);
      return;
    }
    const now = Date.now();
    for (const [hash, entry] of seen) if (now - entry.at > SEEN_TTL_MS) seen.delete(hash);
    seen.set(hit.txHash, { hit, at: now });
  });

  function waitForLog(hash: Hash): Promise<SeenHit | null> {
    const early = seen.get(hash);
    if (early) {
      seen.delete(hash);
      return Promise.resolve(early.hit);
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        waiters.delete(hash);
        resolve(null);
      }, confirmTimeoutMs);
      waiters.set(hash, (hit) => {
        clearTimeout(timer);
        waiters.delete(hash);
        resolve(hit);
      });
    });
  }

  async function confirmFromReceipt(hash: Hash): Promise<HitLanding> {
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: confirmTimeoutMs });
    if (receipt.status !== 'success') throw new Error(`hit ${hash} reverted in block ${receipt.blockNumber}`);
    const [log] = parseEventLogs({ abi: blockbeatAbi, eventName: 'Hit', logs: receipt.logs, strict: true });
    if (!log) throw new Error(`no Hit log in receipt ${hash}`);
    if (log.args.sessionId !== sessionId) throw new Error(`Hit log for session ${log.args.sessionId}, expected ${sessionId}`);
    landed = true;
    return { blockNumber: receipt.blockNumber, step: log.args.step, on: log.args.on, gasUsed: receipt.gasUsed, ...feeOf(hash, receipt.effectiveGasPrice) };
  }

  /** Monad charges the gas LIMIT: fee = limit × effective gas price (omitted when either is unknown). */
  function feeOf(hash: Hash, effectiveGasPrice: unknown): { feeWei?: bigint } {
    const gas = gasOf.get(hash);
    gasOf.delete(hash);
    return gas !== undefined && typeof effectiveGasPrice === 'bigint' ? { feeWei: gas * effectiveGasPrice } : {};
  }

  async function confirmFromStream(hash: Hash): Promise<HitLanding> {
    const hit = await waitForLog(hash);
    if (!hit) {
      gasOf.delete(hash); // TS review: no fee to report for a hit that never showed up, and no leak
      // No log inside the window: one receipt read tells a revert from a hit that is merely late.
      let detail = '';
      try {
        const receipt = await publicClient.getTransactionReceipt({ hash });
        if (receipt.status === 'reverted') throw new Error(`hit ${hash} reverted in block ${receipt.blockNumber}`);
        detail = `; receipt says ${receipt.status} in block ${receipt.blockNumber}`;
      } catch (error) {
        if (error instanceof Error && error.message.includes('reverted in block')) throw error;
        detail = `; receipt lookup failed: ${error instanceof Error ? error.message : String(error)}`;
      }
      throw new Error(`no Hit log for ${hash} within ${confirmTimeoutMs} ms${detail}`);
    }
    landed = true;
    let gasUsed = 0n;
    let fee: { feeWei?: bigint } = {};
    try {
      const receipt = await publicClient.getTransactionReceipt({ hash });
      gasUsed = receipt.gasUsed;
      fee = feeOf(hash, receipt.effectiveGasPrice);
    } catch (error) {
      gasOf.delete(hash);
      warn(`hit ${hash} landed in block ${hit.blockNumber} but its receipt could not be read for gasUsed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return { blockNumber: hit.blockNumber, step: hit.step, on: hit.on, gasUsed, ...fee };
  }

  // W17 batched path: nonces from the account's one NonceSource, one flush per tick, flushes in order.
  let queue: QueuedHit[] = [];
  let flushing: Promise<void> = Promise.resolve();
  let scheduled = false;

  async function flush(batch: BatchSendOptions, items: QueuedHit[]): Promise<void> {
    let first: number;
    try {
      first = await batch.nonces.take(items.length);
    } catch (error) {
      for (const item of items) item.reject(error);
      return;
    }
    const gas = landed ? HIT_GAS_LIMIT : HIT_GAS_LIMIT_FIRST;
    const signed: Array<{ item: QueuedHit; raw: Hex; nonce: number }> = [];
    for (const [i, item] of items.entries()) {
      const nonce = first + i;
      const tx: TransactionSerializableEIP1559 = {
        type: 'eip1559',
        chainId: batch.chainId,
        to: address,
        data: encodeFunctionData({ abi: blockbeatAbi, functionName: 'hit', args: [sessionId, item.track, item.note] }),
        value: 0n,
        gas,
        maxFeePerGas: HIT_MAX_FEE_PER_GAS,
        maxPriorityFeePerGas: HIT_MAX_PRIORITY_FEE_PER_GAS,
        nonce,
      };
      try {
        signed.push({ item, raw: await batch.signer.signTransaction(tx), nonce });
      } catch (error) {
        // Never broadcast past a gap: this and the rest of the step fail, the next step starts at `nonce`.
        for (const rest of items.slice(i)) rest.reject(error);
        batch.nonces.resync(nonce);
        break;
      }
    }
    // Issued in one synchronous pass, so the batching transport sends them as one ordered POST.
    const results = await Promise.allSettled(signed.map(({ raw }) => batch.rpc.sendRawTransaction({ serializedTransaction: raw })));
    let firstFailed: number | null = null;
    results.forEach((result, i) => {
      const entry = signed[i];
      if (!entry) return;
      if (result.status === 'fulfilled') {
        gasOf.set(result.value, gas);
        entry.item.resolve(result.value);
      } else {
        firstFailed ??= entry.nonce;
        entry.item.reject(result.reason);
      }
    });
    if (firstFailed !== null) {
      warn(`hit broadcast rejected at nonce ${firstFailed}; re-reading the pending nonce before the next step`);
      batch.nonces.resync(firstFailed);
    }
  }

  function enqueue(batch: BatchSendOptions, track: TrackId, note: number): Promise<Hash> {
    return new Promise<Hash>((resolve, reject) => {
      queue.push({ track, note, resolve, reject });
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        const items = queue;
        queue = [];
        flushing = flushing.then(() => flush(batch, items));
      });
    });
  }

  return {
    send(track: TrackId, note: number): Promise<Hash> {
      if (!isTrackId(track) || !isNote(note)) return Promise.reject(new Error(`invalid hit track ${track} note ${note}`));
      // `gas` and both fees are explicit so viem never calls eth_estimateGas, eth_getBlock or
      // eth_maxPriorityFeePerGas. Until one hit has landed the contributor push may still be
      // pending, so keep the first-hit tier for in-flight sends.
      if (options.batch) return enqueue(options.batch, track, note);
      const gas = landed ? HIT_GAS_LIMIT : HIT_GAS_LIMIT_FIRST;
      return wallet
        .writeContract({
          address,
          abi: blockbeatAbi,
          functionName: 'hit',
          args: [sessionId, track, note],
          gas,
          maxFeePerGas: HIT_MAX_FEE_PER_GAS,
          maxPriorityFeePerGas: HIT_MAX_PRIORITY_FEE_PER_GAS,
        })
        .then((hash) => {
          gasOf.set(hash, gas);
          return hash;
        });
    },
    confirm: (hash) => (hits ? confirmFromStream(hash) : confirmFromReceipt(hash)),
  };
}

export async function readHitsOf(client: PublicClient, address: Address, sessionId: bigint, player: Address): Promise<bigint> {
  return client.readContract({ address, abi: blockbeatAbi, functionName: 'hitsOf', args: [sessionId, player] });
}

export function createChainIdentity(clients: Pick<Clients, 'http' | 'wallet'>, nonces?: NonceSource): IdentityChain {
  return {
    getCode: (address) => clients.http.getCode({ address }),
    async register(registry, agentURI) {
      const request = { address: registry, abi: erc8004IdentityAbi, functionName: 'register', args: [agentURI], gas: REGISTER_GAS_LIMIT } as const;
      if (!nonces) return clients.wallet.writeContract(request);
      // W17 (TS review): the same nonce authority as the batched hits, so the two never collide.
      const nonce = await nonces.take(1);
      try {
        return await clients.wallet.writeContract({ ...request, nonce });
      } catch (error) {
        nonces.resync(nonce);
        throw error;
      }
    },
    async waitForRegistered(txHash) {
      const receipt = await clients.http.waitForTransactionReceipt({ hash: txHash, timeout: 60_000 });
      if (receipt.status !== 'success') throw new Error(`register tx ${txHash} reverted`);
      const [log] = parseEventLogs({ abi: erc8004IdentityAbi, eventName: 'Registered', logs: receipt.logs, strict: true });
      if (!log) throw new Error(`no Registered log in receipt ${txHash}`);
      return { agentId: log.args.agentId, txHash };
    },
  };
}
