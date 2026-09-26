/**
 * Client runtime: one place that decides between the in-memory simulator (mock mode) and
 * the real chain, and hands out the shared block clock, per-session event feeds and hit
 * senders that the React hooks use. Mock mode is selected automatically while the resolved
 * Blockbeat address (env override or the shared table for NEXT_PUBLIC_CHAIN_ID) is zero
 * (see lib/chain/clients.ts).
 */
import { isAddress, parseEventLogs, type Address, type Hash } from 'viem';
import { BLOCK_MS, HIT_GAS_LIMIT_FIRST, RESERVE_WINDOW_BLOCKS, blockbeatAbi } from '@blockbeat/shared';
import { createBlockClock, type BlockClockController, type HeadSource } from './blockClock';
import { TIPPER_BURNER_STORAGE_KEY, loadOrCreateBurner, type BurnerAccount, type StorageLike } from './burner';
import {
  createBurnerWalletClient,
  createChainEventSource,
  createChainHeadSource,
  createChainClaimWriter,
  createChainHitWriter,
  createChainTipWriter,
  createHttpClient,
  createWsClient,
  getRpcUrls,
  isMockMode,
  runtimeAddress,
  runtimeChainId,
  type RpcUrls,
  type RuntimeMode,
} from './chain';
import { createEventFeed, type EventFeedController, type EventSource, type HistoryMode } from './eventFeed';
import { decayConfig } from './decay';
import { createHitGasPolicy, type HitGasPolicy } from './hitGas';
import { createHitSender, type HitWriter } from './hitSender';
import { revertErrorName } from './revert';
import { createBroadcastBus } from './mock/bus';
import { createSimulator, type Simulator } from './mock/simulator';
import { createBurnerActivity, createTipSender, DEFAULT_TIP_TIMEOUT_MS, tipReadyAt as reserveReadyAt, type TipReceiptSource, type TipWriter } from './tipSender';
import type { HitSender, TipSender } from './types';

export type { RuntimeMode };

/** W13: what history a page wants from its session feed. */
export interface FeedOptions {
  /** The stage asks for 'full'; everything else gets the live window. */
  history?: HistoryMode;
  /**
   * Only this player's hits are read back (the phone). Applies when the feed is created; a
   * later acquirer's player is ignored (the strip filters by player itself, so nothing breaks).
   */
  player?: Address;
  /** W21b: read totalTipsOf and watch TipSplit (the stage). Applies when the feed is created. */
  tipTotals?: boolean;
}

/** W21b: a player's claim of their tip share; txHash is null in mock mode. */
export interface ClaimResult {
  txHash: Hash | null;
  amountWei: bigint;
}

export class ClaimError extends Error {
  constructor(
    message: string,
    readonly txHash: Hash | null = null,
  ) {
    super(message);
    this.name = 'ClaimError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface AcquiredFeed {
  feed: EventFeedController;
  /** Call from the effect cleanup; the feed stops when the last holder releases it. */
  release(): void;
}

export interface AcquiredHitSender {
  sender: HitSender;
  /** Call from the effect cleanup; the sender and its feed hold go away with the last holder. */
  release(): void;
}

export interface AcquiredTipSender {
  sender: TipSender;
  /** Call from the effect cleanup; the sender goes away with the last holder. */
  release(): void;
}

export interface WaitForFundsOptions {
  timeoutMs?: number;
  intervalMs?: number;
  /** Wait until the balance is above this (a top-up on a wallet that still holds dust); default 0. */
  above?: bigint;
}

/** The one PublicClient read the funding check needs (injectable for tests). */
export interface BalanceSource {
  getBalance(args: { address: Address }): Promise<bigint>;
}

export interface BlockbeatRuntime {
  mode: RuntimeMode;
  simulator: Simulator | null;
  clock: BlockClockController;
  burner(): BurnerAccount;
  /** W21b: the tip page's burner (its own storage key, funded by the tipper drip); every tip is sent from it. */
  tipper(): BurnerAccount;
  acquireFeed(sessionId: bigint, options?: FeedOptions): AcquiredFeed;
  acquireHitSender(sessionId: bigint): AcquiredHitSender;
  acquireTipSender(sessionId: bigint): AcquiredTipSender;
  /**
   * Polls the burner's balance from this device until it is spendable (review C3: the drip
   * route answers with the hash, not the receipt). Resolves false on timeout; rejects when
   * the balance cannot be read at all.
   */
  waitForFunds(address: Address, options?: WaitForFundsOptions): Promise<boolean>;
  /**
   * W12: the burner's balance read from this device. Null in mock mode for a wallet the
   * simulator never funded; rejects when the read fails.
   */
  readBalance(address: Address): Promise<bigint | null>;
  /** W12: a drip or top-up answered. Mock mode credits the simulator (no chain); a no-op on chain. */
  creditDrip(address: Address, amountWei: bigint): void;
  /**
   * W12: when a tip from the tipper burner can go out under Monad's reserve rule (1.5 s after
   * its last transaction), or null when it can go now. Always null in mock mode.
   */
  tipReadyAt(): number | null;
  /** Gas limit the next hit in this session would carry (first-hit tier until a confirmed hit, keyed by chain). */
  hitGasFor(sessionId: bigint): bigint;
  /** W21b: `claimableOf(sessionId, address)`: what a player's claim would pay now (one eth_call). */
  readClaimable(sessionId: bigint, address: Address): Promise<bigint>;
  /** W21b: the player burner claims its tip share (after finalize) and resolves on the receipt. */
  claimShare(sessionId: bigint): Promise<ClaimResult>;
  /** W21b: `hostClaimableOf(sessionId)`: the host share not pulled yet (one eth_call). */
  readHostClaimable(sessionId: bigint): Promise<bigint>;
  /**
   * W21b, mock mode only (the host routes answer without a chain): mark the session finalized
   * in the simulator (the other tabs hear it) and pull the host share. No-ops on chain.
   */
  mockFinalize(sessionId: bigint, tokenId: bigint): void;
  mockClaimHost(sessionId: bigint): bigint | null;
}

export const CLAIM_RECEIPT_TIMEOUT_MS = 15_000;

export type RuntimeOptions =
  | { mode: 'mock'; simulator?: Simulator; burner?: BurnerAccount; tipper?: BurnerAccount }
  | {
      mode: 'chain';
      address: Address;
      rpc?: RpcUrls;
      burner?: BurnerAccount;
      tipper?: BurnerAccount;
      balances?: BalanceSource;
      /** Defaults to runtimeChainId(); the gas-tier flags are keyed by it (review M3). */
      chainId?: number;
      /** Storage for the gas-tier flags; defaults to localStorage, null keeps them in memory. */
      gasStorage?: StorageLike | null;
    };

export const WAIT_FOR_FUNDS_TIMEOUT_MS = 8_000;
export const WAIT_FOR_FUNDS_INTERVAL_MS = 400;
/**
 * W11: Monad validates a sender's balance at consensus against state RESERVE_WINDOW_BLOCKS
 * behind the tip, so a burner that just received its drip is rejected ("Signer had
 * insufficient balance") for about three blocks. waitForFunds holds this long after the balance shows.
 */
export const FUNDS_SETTLE_MS = (RESERVE_WINDOW_BLOCKS + 1) * BLOCK_MS;

interface FeedEntry {
  feed: EventFeedController;
  holders: number;
}

interface TipEntry {
  sender: TipSender;
  holders: number;
}

interface SenderEntry {
  sender: HitSender;
  releaseFeed: () => void;
  holders: number;
}

export function createRuntime(options: RuntimeOptions): BlockbeatRuntime {
  let burnerAccount: BurnerAccount | null = options.burner ?? null;
  const burner = (): BurnerAccount => {
    if (!burnerAccount) burnerAccount = loadOrCreateBurner();
    return burnerAccount;
  };
  let tipperAccount: BurnerAccount | null = options.tipper ?? null;
  const tipper = (): BurnerAccount => {
    tipperAccount ??= loadOrCreateBurner({ storageKey: TIPPER_BURNER_STORAGE_KEY });
    return tipperAccount;
  };

  let simulator: Simulator | null = null;
  let headSource: HeadSource;
  let eventSource: EventSource;
  let writerFor: (account: BurnerAccount) => HitWriter;
  let tipWriterFor: (account: BurnerAccount) => TipWriter;
  let receipts: TipReceiptSource;
  let balances: BalanceSource | null = null;
  let gasPolicyFor: (account: BurnerAccount) => HitGasPolicy | null = () => null;
  let readClaimable: (sessionId: bigint, address: Address) => Promise<bigint>;
  let readHostClaimable: (sessionId: bigint) => Promise<bigint>;
  let claimShare: (sessionId: bigint) => Promise<ClaimResult>;

  if (options.mode === 'mock') {
    simulator = options.simulator ?? createSimulator();
    simulator.start();
    headSource = simulator.headSource;
    eventSource = simulator.eventSource;
    const sim = simulator;
    writerFor = (account) => sim.hitWriterFor(account.address);
    tipWriterFor = (account) => sim.tipWriterFor(account.address);
    receipts = sim.receipts;
    readClaimable = async (sessionId, address) => sim.claimableOf(sessionId, address);
    readHostClaimable = async (sessionId) => sim.hostClaimableOf(sessionId);
    claimShare = async (sessionId) => ({ txHash: null, amountWei: sim.claim(sessionId, burner().address) });
  } else {
    const rpc = options.rpc ?? getRpcUrls();
    const http = createHttpClient(rpc.http);
    const ws = createWsClient(rpc.ws);
    balances = options.balances ?? http;
    const chainId = options.chainId ?? runtimeChainId();
    const gasPolicies = new WeakMap<BurnerAccount, HitGasPolicy>();
    gasPolicyFor = (account) => {
      let policy = gasPolicies.get(account);
      if (!policy) {
        policy = createHitGasPolicy({ address: account.address, chainId, ...(options.gasStorage === undefined ? {} : { storage: options.gasStorage }) });
        gasPolicies.set(account, policy);
      }
      return policy;
    };
    headSource = createChainHeadSource({ ws, http });
    eventSource = createChainEventSource({ ws, http, address: options.address });
    writerFor = (account) => {
      const gasPolicy = gasPolicyFor(account);
      return createChainHitWriter({
        wallet: createBurnerWalletClient(account.account, rpc.http),
        address: options.address,
        ...(gasPolicy ? { gasPolicy } : {}),
        receipts: http,
      });
    };
    tipWriterFor = (account) =>
      createChainTipWriter({ wallet: createBurnerWalletClient(account.account, rpc.http), address: options.address });
    const address = options.address;
    readClaimable = (sessionId, player) => http.readContract({ address, abi: blockbeatAbi, functionName: 'claimableOf', args: [sessionId, player] });
    readHostClaimable = (sessionId) => http.readContract({ address, abi: blockbeatAbi, functionName: 'hostClaimableOf', args: [sessionId] });
    claimShare = async (sessionId) => {
      const account = burner();
      const txHash = await createChainClaimWriter({ wallet: createBurnerWalletClient(account.account, rpc.http), address })(sessionId);
      const receipt = await http.waitForTransactionReceipt({ hash: txHash, timeout: CLAIM_RECEIPT_TIMEOUT_MS });
      if (receipt.status !== 'success') throw new ClaimError('the claim reverted', txHash);
      const own = receipt.logs.filter((log) => log.address.toLowerCase() === address.toLowerCase());
      const [claimed] = parseEventLogs({ abi: blockbeatAbi, eventName: 'Claimed', logs: own, strict: true });
      // Review (TS HIGH): a mined claim without its Claimed log is an error, never "claimed 0".
      if (!claimed) throw new ClaimError(`the claim mined (${txHash}) but no Claimed log was emitted`, txHash);
      return { txHash, amountWei: claimed.args.amount };
    };
    receipts = {
      async waitForReceipt(hash) {
        // Shorter than the sender's own timer so a slow receipt always surfaces as TIMEOUT there.
        const r = await http.waitForTransactionReceipt({ hash, timeout: DEFAULT_TIP_TIMEOUT_MS - 2_000 });
        return { blockNumber: r.blockNumber, status: r.status };
      },
      async explainRevert({ sessionId, valueWei }) {
        try {
          await http.simulateContract({
            address,
            abi: blockbeatAbi,
            functionName: 'tip',
            args: [sessionId],
            value: valueWei,
            account: tipper().address,
          });
          return 'simulation succeeded; the revert was transient';
        } catch (error) {
          // The decoded custom error name (NoHits, ZeroTip…); viem's message text only when nothing decodes.
          return revertErrorName(error) ?? (error instanceof Error ? error.message : String(error));
        }
      },
    };
  }

  const clock = createBlockClock({ headSource });
  clock.onError((error) => console.warn(`blockClock: head source error: ${error.message}`));

  // W13: a bad NEXT_PUBLIC_NOTE_LIFETIME_BARS / NEXT_PUBLIC_MAX_LIVE_PER_TRACK fails here, loudly.
  const decay = decayConfig();
  const feeds = new Map<bigint, FeedEntry>();
  const senders = new Map<bigint, SenderEntry>();
  const tipSenders = new Map<bigint, TipEntry>();
  let writer: HitWriter | null = null;
  let tipWriter: TipWriter | null = null;
  // W11: back-to-back value transfers from one sub-10-MON burner revert; the tipper's tips wait it out.
  // W21b: only tips come from the tipper burner, so only they mark it.
  const activity = createBurnerActivity();

  function acquireFeed(sessionId: bigint, feedOptions: FeedOptions = {}): AcquiredFeed {
    let entry = feeds.get(sessionId);
    if (entry && feedOptions.history === 'full') entry.feed.requestFullHistory();
    if (!entry) {
      const feed = createEventFeed({
        sessionId,
        source: eventSource,
        history: feedOptions.history ?? 'window',
        ...(feedOptions.player ? { historyPlayer: feedOptions.player } : {}),
        lifetimeBars: decay.lifetimeBars,
        ...(feedOptions.tipTotals ? { tipTotals: true } : {}),
        // Phones spread their first history read over 1.5 s; the one stage reads at once.
        initialSyncDelayMs: feedOptions.history === 'full' ? 0 : Math.floor(Math.random() * 1_500),
      });
      feed.onError((error) => console.warn(`eventFeed(${sessionId}): ${error.message}`));
      entry = { feed, holders: 0 };
      feeds.set(sessionId, entry);
    }
    const current = entry;
    current.holders += 1;
    let released = false;
    return {
      feed: current.feed,
      release() {
        if (released) return;
        released = true;
        current.holders -= 1;
        if (current.holders <= 0) {
          current.feed.stop();
          if (feeds.get(sessionId) === current) feeds.delete(sessionId);
        }
      },
    };
  }

  function acquireHitSender(sessionId: bigint): AcquiredHitSender {
    let entry = senders.get(sessionId);
    if (!entry) {
      // W21b: hits come from the player burner; tips from the tipper, so hits no longer mark the tip gate.
      writer ??= writerFor(burner());
      // The sender resolves hits from this session's feed, so it holds the feed while held itself.
      // Only a phone sends hits: its feed reads back its own notes of the live window (W13).
      const { feed, release } = acquireFeed(sessionId, { player: burner().address });
      feed.start().catch((error: unknown) => {
        console.warn(`eventFeed(${sessionId}): start failed: ${error instanceof Error ? error.message : String(error)}`);
      });
      entry = { sender: createHitSender({ writer, hits: feed }), releaseFeed: release, holders: 0 };
      senders.set(sessionId, entry);
    }
    const current = entry;
    current.holders += 1;
    let released = false;
    return {
      sender: current.sender,
      release() {
        if (released) return;
        released = true;
        current.holders -= 1;
        if (current.holders <= 0) {
          current.releaseFeed();
          if (senders.get(sessionId) === current) senders.delete(sessionId);
        }
      },
    };
  }

  function acquireTipSender(sessionId: bigint): AcquiredTipSender {
    let entry = tipSenders.get(sessionId);
    if (!entry) {
      tipWriter ??= tipWriterFor(tipper());
      // The simulator has no reserve rule, so mock tips go out at once as before.
      entry = { sender: createTipSender({ writer: tipWriter, receipts, ...(options.mode === 'mock' ? {} : { activity }) }), holders: 0 };
      tipSenders.set(sessionId, entry);
    }
    const current = entry;
    current.holders += 1;
    let released = false;
    return {
      sender: current.sender,
      release() {
        if (released) return;
        released = true;
        current.holders -= 1;
        if (current.holders <= 0 && tipSenders.get(sessionId) === current) tipSenders.delete(sessionId);
      },
    };
  }

  async function waitForFunds(address: Address, opts: WaitForFundsOptions = {}): Promise<boolean> {
    if (!balances) return true;
    const source = balances;
    const timeoutMs = opts.timeoutMs ?? WAIT_FOR_FUNDS_TIMEOUT_MS;
    const intervalMs = opts.intervalMs ?? WAIT_FOR_FUNDS_INTERVAL_MS;
    const above = opts.above ?? 0n;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if ((await source.getBalance({ address })) > above) {
        await new Promise((r) => setTimeout(r, FUNDS_SETTLE_MS));
        return true;
      }
      if (Date.now() + intervalMs > deadline) return false;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }

  function hitGasFor(sessionId: bigint): bigint {
    if (simulator) return simulator.nextHitGas(burner().address, sessionId);
    return gasPolicyFor(burner())?.gasFor(sessionId) ?? HIT_GAS_LIMIT_FIRST;
  }

  async function readBalance(address: Address): Promise<bigint | null> {
    if (balances) return balances.getBalance({ address });
    return simulator?.balanceOf(address) ?? null;
  }

  function creditDrip(address: Address, amountWei: bigint): void {
    simulator?.credit(address, amountWei);
  }

  function tipReadyAt(): number | null {
    return options.mode === 'mock' ? null : reserveReadyAt(activity, Date.now());
  }

  return {
    mode: options.mode,
    simulator,
    clock,
    burner,
    tipper,
    acquireFeed,
    acquireHitSender,
    acquireTipSender,
    waitForFunds,
    hitGasFor,
    readBalance,
    creditDrip,
    tipReadyAt,
    readClaimable,
    claimShare,
    readHostClaimable,
    mockFinalize(sessionId, tokenId) {
      simulator?.finalize(sessionId, tokenId);
    },
    mockClaimHost(sessionId) {
      return simulator ? simulator.claimHost(sessionId) : null;
    },
  };
}

let runtime: BlockbeatRuntime | null = null;

/** The resident DJ's public address (NEXT_PUBLIC_AGENT_ADDRESS), or null when unset or malformed. */
export function agentAddress(): Address | null {
  const raw = process.env.NEXT_PUBLIC_AGENT_ADDRESS?.trim();
  return raw && isAddress(raw) ? raw : null;
}

/** Browser-only singleton. Call from effects and event handlers, never during render on the server. */
export function getRuntime(): BlockbeatRuntime {
  if (runtime) return runtime;
  // W21b: in the browser, mock simulators of one origin share hits and tips (lib/mock/bus.ts).
  runtime = isMockMode()
    ? createRuntime({ mode: 'mock', simulator: createSimulator({ bus: createBroadcastBus(), agent: agentAddress() }) })
    : createRuntime({ mode: 'chain', address: runtimeAddress() });
  return runtime;
}
