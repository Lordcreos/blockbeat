/**
 * Chain-backed drip sender: a plain value transfer of DRIP_AMOUNT_MON from the drip key,
 * with the fixed 21 000 gas a transfer costs.
 *
 * Review C3: sixty phones can hit /api/drip inside twenty seconds. Sends are serialised
 * through one queue (the next send starts as soon as the previous one has a hash, never
 * after its receipt) and the drip account carries viem's nonce manager, so overlapping
 * requests can never sign the same nonce. `send` answers with the hash; `confirm` watches
 * the receipt off the request path, one receipt at a time, so N in-flight drips cost one
 * receipt poll per block instead of N. Server only; the key never reaches a log.
 *
 * W11 (Monad reserve balance): while the drip account would end below 10 MON, a transfer
 * only lands if the account sent nothing in the previous 3 blocks, so with `pacing` the
 * queue waits RESERVE_PACING_BLOCKS heads between sends (timer fallback when heads cannot be
 * read). Above the reserve it sends back-to-back as before. Requests queue; none is refused.
 */
import { parseEther, type Account, type Address, type Chain, type Hash, type Transport, type WalletClient } from 'viem';
import { nonceManager, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { BLOCK_MS, DRIP_AMOUNT_MON, HIT_MAX_FEE_PER_GAS, HIT_MAX_PRIORITY_FEE_PER_GAS, RESERVE_PACING_BLOCKS, isBelowReserve } from '@blockbeat/shared';
import { DripRevertedError, type DripBacklog, type DripSender } from './service';

/** A native transfer always costs exactly 21 000 gas; no estimation needed. */
export const DRIP_GAS_LIMIT = 21_000n;
export const DRIP_RECEIPT_TIMEOUT_MS = 20_000;

const PK_RE = /^0x[0-9a-fA-F]{64}$/;

/** The one PublicClient method the sender needs (keeps tests free of a real client). */
export interface ReceiptSource {
  waitForTransactionReceipt(args: { hash: Hash; timeout: number }): Promise<{ status: 'success' | 'reverted' }>;
}

/** Balance and head reads for reserve pacing (a PublicClient bound to the drip address). */
export interface DripPacing {
  getBalance(): Promise<bigint>;
  getBlockNumber(): Promise<bigint>;
}

/** Wait used between paced sends when the head cannot be read. */
export const DRIP_PACING_FALLBACK_MS = RESERVE_PACING_BLOCKS * BLOCK_MS;
/** A stalled head never blocks the queue for longer than this per send. */
const DRIP_PACING_MAX_WAIT_MS = 4 * DRIP_PACING_FALLBACK_MS;

export interface ChainDripSenderOptions {
  wallet: WalletClient<Transport, Chain, Account>;
  /** Reserve-balance pacing (W11); without it every send goes out as soon as the previous has a hash. */
  pacing?: DripPacing;
  /** Where pacing anomalies go (server log); never receives the key. */
  log?: (message: string) => void;
  /** When omitted there is no `confirm` step: the hash is all the service learns. */
  receipts?: ReceiptSource;
  amountMon?: string;
  receiptTimeoutMs?: number;
}

/** One task at a time, in call order, whether or not the previous task failed. */
export function createSerialQueue(): <T>(task: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task, task);
    tail = run.catch(() => undefined);
    return run;
  };
}

export function createChainDripSender({
  wallet,
  pacing,
  log = (m: string) => console.warn(m),
  receipts,
  amountMon = DRIP_AMOUNT_MON,
  receiptTimeoutMs = DRIP_RECEIPT_TIMEOUT_MS,
}: ChainDripSenderOptions): DripSender {
  const value = parseEther(amountMon);
  const sends = createSerialQueue();
  const confirmations = createSerialQueue();
  let queued = 0;
  let paced = false;
  let lastSendHead: bigint | null = null;
  let lastSendAt: number | null = null;

  const headOrNull = (): Promise<bigint | null> => (pacing ? pacing.getBlockNumber().catch(() => null) : Promise.resolve(null));

  /** Below the reserve: wait until RESERVE_PACING_BLOCKS heads have passed since the previous send. */
  async function paceIfBelowReserve(amount: bigint): Promise<bigint | null> {
    if (!pacing) return null;
    // An unreadable balance is treated as below the reserve: pacing is slower, never wrong.
    const balance = await pacing.getBalance().catch(() => 0n);
    paced = isBelowReserve(balance, amount);
    let head = await headOrNull();
    if (!paced || lastSendAt === null) return head;
    const deadline = lastSendAt + DRIP_PACING_MAX_WAIT_MS;
    while (Date.now() < deadline) {
      if (head !== null && lastSendHead !== null) {
        if (head >= lastSendHead + BigInt(RESERVE_PACING_BLOCKS)) return head;
      } else if (Date.now() >= lastSendAt + DRIP_PACING_FALLBACK_MS) {
        return head;
      }
      await new Promise((r) => setTimeout(r, BLOCK_MS));
      head = await headOrNull();
    }
    log(`drip: reserve pacing gave up after ${DRIP_PACING_MAX_WAIT_MS} ms (head ${head ?? 'unreadable'}, last send head ${lastSendHead ?? 'unknown'}); sending anyway, the transfer may revert`);
    return head;
  }

  const send = (to: Address, amountWei: bigint = value): Promise<Hash> => {
    queued += 1;
    return sends(async () => {
      try {
        const head = await paceIfBelowReserve(amountWei);
        // W16: fixed fees and chainId, so viem sends with one nonce read and one raw send (no
        // eth_fillTransaction, eth_getBlock or eth_maxPriorityFeePerGas per drip).
        const hash = await wallet.sendTransaction({
          to,
          value: amountWei,
          gas: DRIP_GAS_LIMIT,
          maxFeePerGas: HIT_MAX_FEE_PER_GAS,
          maxPriorityFeePerGas: HIT_MAX_PRIORITY_FEE_PER_GAS,
          chainId: wallet.chain.id,
        });
        lastSendHead = head;
        lastSendAt = Date.now();
        return hash;
      } finally {
        queued -= 1;
      }
    });
  };
  const backlog = (): DripBacklog => ({ ahead: queued, etaMs: paced ? queued * DRIP_PACING_FALLBACK_MS : 0 });
  if (!receipts) return { send, backlog };

  const source = receipts;
  return {
    send,
    backlog,
    confirm: (hash) =>
      confirmations(async () => {
        const receipt = await source.waitForTransactionReceipt({ hash, timeout: receiptTimeoutMs });
        if (receipt.status !== 'success') throw new DripRevertedError(hash);
      }),
  };
}

/**
 * Reads DRIP_PRIVATE_KEY. Returns null when unset; throws (without echoing the value) when
 * malformed. The account carries a nonce manager (review C3).
 */
export function dripAccountFromEnv(env: Record<string, string | undefined>): PrivateKeyAccount | null {
  const raw = env.DRIP_PRIVATE_KEY?.trim();
  if (!raw) return null;
  if (!PK_RE.test(raw)) throw new Error('DRIP_PRIVATE_KEY is set but is not a 0x-prefixed 32-byte hex key');
  return privateKeyToAccount(raw as `0x${string}`, { nonceManager });
}
