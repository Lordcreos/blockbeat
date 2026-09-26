/**
 * Load test orchestration, independent of viem so it runs against an in-memory chain in
 * tests. Every RPC call goes through one token bucket; hits are signed locally with the
 * fixed tiered gas limits (HIT_GAS_LIMIT_FIRST until one of the wallet's hits lands, then
 * HIT_GAS_LIMIT, like the phone) and confirmed from the `Hit` log for their transaction hash (same
 * path the phone uses), with a single receipt lookup as the fallback on timeout.
 */
import type { Address, Hash, Hex, LocalAccount } from 'viem';
import { formatEther, parseEther } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { HIT_GAS_LIMIT, HIT_GAS_LIMIT_FIRST, RESERVE_PACING_BLOCKS, TRACKS, isBelowReserve, NOTES_PER_TRACK, stepForBlock } from '@blockbeat/shared';
import { createTokenBucket } from './tokenBucket';
import { predictLanding } from './stepPrediction';
import { aggregate, classifyRpcError, type HitRecord, type Summary } from './stats';

export interface Fees {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

export interface Receipt {
  blockNumber: bigint;
  status: 'success' | 'reverted';
  gasUsed: bigint;
  effectiveGasPrice: bigint;
}

export interface HitLog {
  txHash: Hash;
  blockNumber: bigint;
  step: number;
  sessionId: bigint;
  track: number;
  note: number;
}

export interface ChainAdapter {
  getBlockNumber(): Promise<bigint>;
  getBalance(address: Address): Promise<bigint>;
  getNonce(address: Address): Promise<number>;
  getSessionStartBlock(sessionId: bigint): Promise<bigint>;
  getFees(): Promise<Fees>;
  sendTransfer(from: LocalAccount, to: Address, valueWei: bigint, nonce: number, fees: Fees): Promise<Hash>;
  sendHit(from: LocalAccount, sessionId: bigint, track: number, note: number, nonce: number, fees: Fees, gas: bigint): Promise<Hash>;
  getReceipt(hash: Hash): Promise<Receipt | null>;
  watchHeads(cb: (block: bigint) => void): () => void;
  watchHits(sessionId: bigint, cb: (log: HitLog) => void): () => void;
}

export interface RunOptions {
  chainId: number;
  sessionId: bigint;
  wallets: number;
  hits: number;
  windowMs: number;
  rps: number;
  blockMs: number;
  lagBlocks: number;
  hitTimeoutMs: number;
  /** How often the fee estimate is refreshed during the hit phase (0 disables). */
  feeRefreshMs?: number;
  seed: number;
  sweep: boolean;
  receipts: 'all' | 'sample' | 'none';
  /** Decimal MON per wallet; computed from gas when null/undefined. */
  fundMon?: string | null;
  funderKey: Hex;
  log: (line: string) => void;
}

export interface RunResult {
  startedAt: string;
  durationMs: number;
  measuredBlockMs: number | null;
  funder: Address;
  wallets: Address[];
  fundWeiPerWallet: bigint;
  sweptWei: bigint;
  records: HitRecord[];
  summary: Summary;
}

export const TRANSFER_GAS = 21_000n;
const RECEIPT_SAMPLE = 50;
const FUNDING_TIMEOUT_MS = 120_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** mulberry32: small seeded PRNG so a run's timing plan is reproducible. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Wallet {
  index: number;
  account: LocalAccount;
  nonce: number;
  /** A hit from this wallet has landed: its contributor slot exists, so later hits fit the lower gas tier. */
  landed: boolean;
  /** Serialises sends per wallet so nonces stay gapless even if one send fails. */
  chain: Promise<void>;
}

interface Planned {
  wallet: Wallet;
  index: number;
  at: number;
  track: number;
  note: number;
}

interface Pending {
  record: HitRecord;
  resolve: () => void;
  timer: ReturnType<typeof setTimeout> | null;
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? (s[mid] ?? null) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
}

export async function runLoadTest(opts: RunOptions, chain: ChainAdapter): Promise<RunResult> {
  const { log } = opts;
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const bucket = createTokenBucket({ ratePerSec: opts.rps });
  const rpc = async <T>(f: () => Promise<T>): Promise<T> => {
    await bucket.take();
    return f();
  };

  const startBlock = await rpc(() => chain.getSessionStartBlock(opts.sessionId));
  if (startBlock === 0n) throw new Error(`session ${opts.sessionId} has not started on this contract (startBlock is 0)`);

  const funder = privateKeyToAccount(opts.funderKey);
  // One logical call; viem's estimateFeesPerGas may issue two JSON-RPC requests underneath.
  let fees = await rpc(() => chain.getFees());
  const funderNonce = await rpc(() => chain.getNonce(funder.address));
  const funderBefore = await rpc(() => chain.getBalance(funder.address));

  // Fund enough for `hits` at the fixed gas limit (Monad charges the gas limit, not the
  // gas used) plus one transfer back when sweeping, with 10% headroom. Every hit sent before
  // the wallet's first one lands pays the first-hit tier, so reserve that tier for all of them.
  const perHitReserve = HIT_GAS_LIMIT_FIRST * fees.maxFeePerGas;
  const computedFund = ((perHitReserve * BigInt(opts.hits) + TRANSFER_GAS * fees.maxFeePerGas) * 110n) / 100n;
  const fundWei = opts.fundMon ? parseEther(opts.fundMon) : computedFund;
  const totalNeeded = (fundWei + TRANSFER_GAS * fees.maxFeePerGas) * BigInt(opts.wallets);
  if (funderBefore < totalNeeded) {
    throw new Error(`funder ${funder.address} holds ${formatEther(funderBefore)} MON but ${opts.wallets} wallets need ${formatEther(totalNeeded)} MON (${formatEther(fundWei)} each)`);
  }
  log(`funder ${funder.address}: ${formatEther(funderBefore)} MON; funding ${opts.wallets} wallets with ${formatEther(fundWei)} MON each (maxFeePerGas ${fees.maxFeePerGas} wei)`);

  const wallets: Wallet[] = Array.from({ length: opts.wallets }, (_, index) => ({
    index,
    account: privateKeyToAccount(generatePrivateKey()),
    nonce: 0,
    landed: false,
    chain: Promise.resolve(),
  }));

  // Head tracking for step prediction and block cadence measurement.
  let head = await rpc(() => chain.getBlockNumber());
  let headSeenAt = Date.now();
  const headDeltas: number[] = [];
  const stopHeads = chain.watchHeads((block) => {
    const t = Date.now();
    if (block <= head) return;
    if (headDeltas.length < 64 && block === head + 1n) headDeltas.push(t - headSeenAt);
    head = block;
    headSeenAt = t;
  });

  // Hit log tracking. A log can arrive before sendRaw returns the hash (instant mining).
  const pending = new Map<Hash, Pending>();
  const earlyLogs = new Map<Hash, { log: HitLog; seenAt: number }>();
  const settleFromLog = (p: Pending, hitLog: HitLog, seenAt: number): void => {
    if (p.timer !== null) clearTimeout(p.timer);
    const owner = wallets[p.record.wallet];
    if (owner) owner.landed = true;
    p.record.status = 'confirmed';
    p.record.receiptAt = seenAt;
    p.record.blockNumber = hitLog.blockNumber;
    p.record.actualStep = hitLog.step;
    p.record.latencyMs = seenAt - p.record.sentAt;
    p.resolve();
  };
  const stopHits = chain.watchHits(opts.sessionId, (hitLog) => {
    const seenAt = Date.now();
    const p = pending.get(hitLog.txHash);
    if (p) {
      pending.delete(hitLog.txHash);
      settleFromLog(p, hitLog, seenAt);
    } else {
      earlyLogs.set(hitLog.txHash, { log: hitLog, seenAt });
    }
  });

  /**
   * Monad reserve balance (W11): a value transfer that leaves its sender below 10 MON only
   * lands if the sender sent nothing in the previous 3 blocks. Waits until
   * RESERVE_PACING_BLOCKS heads have passed `fromHead` (timer bound if heads stall).
   */
  const waitReserveWindow = async (fromHead: bigint): Promise<void> => {
    const deadline = Date.now() + 4 * RESERVE_PACING_BLOCKS * opts.blockMs;
    while (head < fromHead + BigInt(RESERVE_PACING_BLOCKS) && Date.now() < deadline) await sleep(opts.blockMs);
  };
  const waitReceipt = async (hash: Hash, deadline: number): Promise<Receipt> => {
    for (;;) {
      if (Date.now() > deadline) throw new Error(`transaction ${hash} was not mined within ${FUNDING_TIMEOUT_MS} ms`);
      await sleep(opts.blockMs);
      const receipt = await rpc(() => chain.getReceipt(hash));
      if (receipt !== null) return receipt;
    }
  };

  const records: HitRecord[] = [];
  let sweptWei = 0n;
  try {
    // ---- Funding
    // Below the reserve, back-to-back transfers revert (4 of 5 on testnet): send one at a
    // time, confirm it, and wait out the reserve window before the next.
    const pacedFunding = isBelowReserve(funderBefore, totalNeeded);
    if (pacedFunding) log(`funder ends below the 10 MON reserve: pacing funding transfers ${RESERVE_PACING_BLOCKS} blocks apart`);
    let lastFundingHash: Hash | null = null;
    for (const w of wallets) {
      if (pacedFunding && lastFundingHash !== null) {
        const receipt = await waitReceipt(lastFundingHash, Date.now() + FUNDING_TIMEOUT_MS);
        if (receipt.status === 'reverted') throw new Error(`funding transaction ${lastFundingHash} reverted`);
        await waitReserveWindow(receipt.blockNumber);
      }
      lastFundingHash = await rpc(() => chain.sendTransfer(funder, w.account.address, fundWei, funderNonce + w.index, fees));
    }
    const fundingDeadline = Date.now() + FUNDING_TIMEOUT_MS;
    if (lastFundingHash !== null) {
      const hash = lastFundingHash;
      let receipt: Receipt | null = null;
      while (receipt === null) {
        if (Date.now() > fundingDeadline) throw new Error(`funding transaction ${hash} was not mined within ${FUNDING_TIMEOUT_MS} ms`);
        await sleep(opts.blockMs);
        receipt = await rpc(() => chain.getReceipt(hash));
      }
      if (receipt.status === 'reverted') throw new Error(`funding transaction ${hash} reverted`);
      // Monad checks a sender's balance at consensus against state 3 blocks behind: a burner
      // that fires right after its funding lands is rejected with "insufficient balance" (W11).
      await waitReserveWindow(receipt.blockNumber);
    }
    await Promise.all(
      wallets.map(async (w) => {
        let balance = await rpc(() => chain.getBalance(w.account.address));
        while (balance < fundWei) {
          if (Date.now() > fundingDeadline) throw new Error(`wallet ${w.account.address} was not funded within ${FUNDING_TIMEOUT_MS} ms`);
          await sleep(opts.blockMs);
          balance = await rpc(() => chain.getBalance(w.account.address));
        }
      }),
    );
    log(`funded ${wallets.length} wallets (last tx ${lastFundingHash ?? 'none'})`);

    // ---- Plan: random offsets in the window, one track per wallet, random notes.
    const rng = seededRandom(opts.seed);
    const plan: Planned[] = [];
    for (const w of wallets) {
      for (let j = 0; j < opts.hits; j++) {
        plan.push({ wallet: w, index: plan.length, at: Math.floor(rng() * opts.windowMs), track: w.index % TRACKS, note: Math.floor(rng() * NOTES_PER_TRACK) });
      }
    }
    plan.sort((a, b) => a.at - b.at || a.index - b.index);

    // ---- Fire
    const t0 = Date.now();
    const feeRefreshMs = opts.feeRefreshMs ?? 10_000;
    let feeRefresh: ReturnType<typeof setInterval> | null = null;
    if (feeRefreshMs > 0) {
      feeRefresh = setInterval(() => {
        void rpc(() => chain.getFees()).then(
          (next) => {
            fees = next;
          },
          (err: unknown) => log(`fee refresh failed: ${classifyRpcError(err).message}`),
        );
      }, feeRefreshMs);
    }
    const settled: Promise<void>[] = [];
    let sentCount = 0;
    let lastHitHead = head;
    for (const item of plan) {
      const wait = t0 + item.at - Date.now();
      if (wait > 0) await sleep(wait);
      const done = new Promise<void>((resolve) => {
        item.wallet.chain = item.wallet.chain.then(async () => {
          await bucket.take();
          const w = item.wallet;
          const nonce = w.nonce;
          const sentAt = Date.now();
          const predicted = predictLanding({ startBlock, head, headSeenAt, now: sentAt, blockMs: measured() ?? opts.blockMs, lagBlocks: opts.lagBlocks });
          const record: HitRecord = { wallet: w.index, index: item.index, sentAt, intendedStep: predicted.step, intendedBlock: predicted.block, status: 'timeout' };
          records.push(record);
          let hash: Hash;
          try {
            hash = await chain.sendHit(w.account, opts.sessionId, item.track, item.note, nonce, fees, w.landed ? HIT_GAS_LIMIT : HIT_GAS_LIMIT_FIRST);
          } catch (err) {
            const cls = classifyRpcError(err);
            record.status = 'send-failed';
            record.errorCode = cls.code;
            record.errorMessage = cls.message;
            record.rateLimited = cls.rateLimited;
            resolve();
            return;
          }
          w.nonce = nonce + 1;
          sentCount += 1;
          lastHitHead = head;
          record.txHash = hash;
          const early = earlyLogs.get(hash);
          if (early) {
            earlyLogs.delete(hash);
            settleFromLog({ record, resolve, timer: null }, early.log, early.seenAt);
            return;
          }
          const timer = setTimeout(() => {
            void (async () => {
              if (!pending.has(hash)) return;
              pending.delete(hash);
              let receipt: Receipt | null = null;
              try {
                receipt = await rpc(() => chain.getReceipt(hash));
              } catch (err) {
                const cls = classifyRpcError(err);
                record.errorCode = cls.code;
                record.errorMessage = cls.message;
                record.rateLimited = cls.rateLimited;
              }
              const now = Date.now();
              if (receipt === null) {
                record.status = 'timeout';
              } else if (receipt.status === 'reverted') {
                record.status = 'reverted';
                record.blockNumber = receipt.blockNumber;
                record.gasUsed = receipt.gasUsed;
                record.effectiveGasPrice = receipt.effectiveGasPrice;
              } else {
                // Landed, but the log path missed it: latency is bounded by the timeout.
                w.landed = true;
                record.status = 'confirmed';
                record.receiptAt = now;
                record.latencyMs = now - record.sentAt;
                record.blockNumber = receipt.blockNumber;
                record.actualStep = stepForBlock(startBlock, receipt.blockNumber);
                record.gasUsed = receipt.gasUsed;
                record.effectiveGasPrice = receipt.effectiveGasPrice;
              }
              resolve();
            })();
          }, opts.hitTimeoutMs);
          pending.set(hash, { record, resolve, timer });
        });
      });
      settled.push(done);
    }
    await Promise.all(settled);
    if (feeRefresh !== null) clearInterval(feeRefresh);
    feeRefresh = null;
    const durationMs = Date.now() - t0;
    // Bucket pressure during funding and the hit phase; receipts and balances below also queue.
    const hitPhaseBucket = bucket.stats();
    log(`sent ${sentCount}/${plan.length} hits in ${durationMs} ms; ${records.filter((r) => r.status === 'confirmed').length} confirmed`);

    // ---- Receipts (post-run so they never compete with the hits for the bucket)
    if (opts.receipts !== 'none') {
      const wanted = records.filter((r) => r.status === 'confirmed' && r.txHash !== undefined && r.gasUsed === undefined);
      const targets = opts.receipts === 'all' ? wanted : wanted.slice(0, RECEIPT_SAMPLE);
      for (const r of targets) {
        const hash = r.txHash;
        if (hash === undefined) continue;
        const receipt = await rpc(() => chain.getReceipt(hash));
        if (receipt) {
          r.gasUsed = receipt.gasUsed;
          r.effectiveGasPrice = receipt.effectiveGasPrice;
        }
      }
    }

    // ---- Money
    const funderAfter = await rpc(() => chain.getBalance(funder.address));
    let burnerSpent = 0n;
    const leftovers: Array<{ wallet: Wallet; balance: bigint }> = [];
    for (const w of wallets) {
      const balance = await rpc(() => chain.getBalance(w.account.address));
      burnerSpent += fundWei - balance;
      leftovers.push({ wallet: w, balance });
    }
    if (opts.sweep) {
      const sweepGas = TRANSFER_GAS * fees.maxFeePerGas;
      // Each sweep empties a burner below the reserve: its last hit must be out of the window.
      await waitReserveWindow(lastHitHead);
      const sweeps: Array<{ hash: Hash; value: bigint }> = [];
      for (const { wallet: w, balance } of leftovers) {
        if (balance <= sweepGas) continue;
        const value = balance - sweepGas;
        const hash = await rpc(() => chain.sendTransfer(w.account, funder.address, value, w.nonce, fees));
        w.nonce += 1;
        sweeps.push({ hash, value });
      }
      const sweepDeadline = Date.now() + FUNDING_TIMEOUT_MS;
      for (const { hash, value } of sweeps) {
        try {
          const receipt = await waitReceipt(hash, sweepDeadline);
          if (receipt.status === 'success') sweptWei += value;
          else log(`sweep ${hash} reverted; ${formatEther(value)} MON stays in the burner`);
        } catch (err) {
          log(`sweep ${hash} not confirmed: ${classifyRpcError(err).message}`);
        }
      }
      log(`swept ${formatEther(sweptWei)} MON back to the funder (${sweeps.length} transfers)`);
    }

    const summary = aggregate(records, {
      fundedWei: fundWei * BigInt(wallets.length),
      funderSpentWei: funderBefore - funderAfter,
      burnerSpentWei: burnerSpent,
      durationMs,
      bucketWaits: hitPhaseBucket.waited,
      bucketWaitedMs: hitPhaseBucket.waitedMs,
    });
    return {
      startedAt,
      durationMs,
      measuredBlockMs: measured(),
      funder: funder.address,
      wallets: wallets.map((w) => w.account.address),
      fundWeiPerWallet: fundWei,
      sweptWei,
      records,
      summary,
    };
  } finally {
    stopHeads();
    stopHits();
    for (const p of pending.values()) if (p.timer !== null) clearTimeout(p.timer);
    pending.clear();
    earlyLogs.clear();
  }

  function measured(): number | null {
    return headDeltas.length >= 3 ? median(headDeltas) : null;
  }
}
