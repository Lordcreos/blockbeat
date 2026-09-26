/**
 * Chain-backed HitWriter: `writeContract` for `hit` with a fixed gas limit from the gas
 * policy (HIT_GAS_LIMIT_FIRST until the burner has a confirmed hit in the session, then
 * HIT_GAS_LIMIT) and fixed EIP-1559 fees from shared. Passing `gas`, `maxFeePerGas` and
 * `maxPriorityFeePerGas` explicitly means viem never calls eth_estimateGas, eth_getBlock or
 * eth_maxPriorityFeePerGas, and passing `chainId` means it never tries eth_fillTransaction (W16):
 * a tap is one eth_getTransactionCount (nonce manager) plus one eth_sendRawTransaction (review H7).
 *
 * The hash is returned as soon as the node accepts the transaction; the sender resolves on
 * the Hit log. With a receipt source the writer also watches the receipt off the send
 * path: a success marks the session confirmed (lower gas tier from then on); a revert that
 * consumed the whole (lower) limit is an out-of-gas from a stale flag and is retried once
 * with the first-hit limit, the replacement hash reported through `hooks.onRetry`; any
 * other revert is reported through `hooks.onReverted` so the phone fails fast.
 */
import type { Account, Address, Chain, Hash, Transport, WalletClient } from 'viem';
import { HIT_GAS_LIMIT_FIRST, HIT_MAX_FEE_PER_GAS, HIT_MAX_PRIORITY_FEE_PER_GAS, blockbeatAbi } from '@blockbeat/shared';
import type { HitGasPolicy } from '../hitGas';
import type { HitWriteArgs, HitWriteHooks, HitWriter } from '../hitSender';

export interface HitReceiptSource {
  waitForTransactionReceipt(args: { hash: Hash; timeout: number }): Promise<{ status: 'success' | 'reverted'; gasUsed: bigint }>;
}

export interface ChainHitWriterOptions {
  wallet: WalletClient<Transport, Chain, Account>;
  address: Address;
  /** Defaults to the first-hit limit for every hit (safe, costs more). */
  gasPolicy?: HitGasPolicy;
  /** Enables the confirmed-flag update and the out-of-gas retry. */
  receipts?: HitReceiptSource;
  receiptTimeoutMs?: number;
  /** Background receipt problems are reported here, never swallowed. */
  warn?: (message: string) => void;
}

/**
 * Review M3: the sender's DEFAULT_HIT_TIMEOUT_MS (15 s) must cover a send, this wait, a
 * retry send and its wait, with margin: 2 × 6 s + 3 s. A receipt for an accepted hit
 * lands within a few 300 ms blocks, so 6 s is already generous.
 */
export const HIT_RECEIPT_TIMEOUT_MS = 6_000;

/**
 * W16: without a numeric `chainId` viem >= 2.5x first tries eth_fillTransaction (a round trip
 * per tap, retried when the node lacks it) even though gas, fees and nonce are known. viem's
 * writeContract forwards it to sendTransaction but does not declare it; spreading this object
 * (not a literal property) passes the excess-property check.
 */
export function withChainId(wallet: { chain: Chain }): { chainId: number } {
  return { chainId: wallet.chain.id };
}

/** W16: forget the account's local nonce (lib/localNonce.ts re-reads it); a no-op without a nonce manager. */
export function resetNonce(wallet: { account?: Account; chain: Chain }): void {
  const account = wallet.account;
  account?.nonceManager?.reset({ address: account.address, chainId: wallet.chain.id });
}

export function createChainHitWriter(options: ChainHitWriterOptions): HitWriter {
  const { wallet, address, gasPolicy, receipts } = options;
  const receiptTimeoutMs = options.receiptTimeoutMs ?? HIT_RECEIPT_TIMEOUT_MS;
  const warn = options.warn ?? ((m: string) => console.warn(m));

  function send({ sessionId, track, note }: HitWriteArgs, gas: bigint): Promise<Hash> {
    return wallet.writeContract({
      address,
      abi: blockbeatAbi,
      functionName: 'hit',
      args: [sessionId, track, note],
      gas,
      maxFeePerGas: HIT_MAX_FEE_PER_GAS,
      maxPriorityFeePerGas: HIT_MAX_PRIORITY_FEE_PER_GAS,
      ...withChainId(wallet),
    });
  }

  /** Off the send path: confirm the tier flag, retry an out-of-gas once, or report the revert. */
  async function watchReceipt(source: HitReceiptSource, args: HitWriteArgs, hash: Hash, gas: bigint, hooks: HitWriteHooks): Promise<void> {
    const receipt = await source.waitForTransactionReceipt({ hash, timeout: receiptTimeoutMs });
    if (receipt.status === 'success') {
      gasPolicy?.markConfirmed(args.sessionId);
      return;
    }
    // Review L9: `gasUsed >= gas` as the out-of-gas signal is safe for this contract because
    // every revert (SessionFinalized, TrackOutOfRange…) happens early and cheaply; only
    // running out of gas consumes the whole limit. It is a heuristic, not a receipt field.
    const outOfGas = receipt.gasUsed >= gas;
    if (outOfGas && gas < HIT_GAS_LIMIT_FIRST) {
      // The lower tier was wrong for this session (stale flag); pay for a contributor slot once.
      const retry = await send(args, HIT_GAS_LIMIT_FIRST);
      hooks.onRetry?.(retry);
      const again = await source.waitForTransactionReceipt({ hash: retry, timeout: receiptTimeoutMs });
      if (again.status !== 'success') {
        hooks.onReverted?.(retry, `hit reverted twice (${hash}, ${retry})`);
        return;
      }
      gasPolicy?.markConfirmed(args.sessionId);
      return;
    }
    hooks.onReverted?.(hash, `hit reverted (${hash}); the session may be finalized or unknown`);
  }

  return async (args, hooks = {}) => {
    const gas = gasPolicy?.gasFor(args.sessionId) ?? HIT_GAS_LIMIT_FIRST;
    // A refused send ("nonce too low/high", a network error) resets the account's nonce inside
    // viem's sendTransaction already; lib/localNonce.ts then re-reads it.
    const hash = await send(args, gas);
    if (receipts) {
      watchReceipt(receipts, args, hash, gas, hooks).catch((error: unknown) => {
        // W16: no receipt in time; the tx may have been dropped, so the next nonce is unknown.
        resetNonce(wallet);
        warn(`hit ${hash}: receipt not confirmed (${error instanceof Error ? error.message : String(error)}); the gas tier flag is unchanged`);
      });
    }
    return hash;
  };
}
