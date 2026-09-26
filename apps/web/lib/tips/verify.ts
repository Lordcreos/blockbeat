/**
 * W21b: proof that a tip note belongs to a real tip. One eth_getTransactionReceipt (not an
 * eth_call, so outside the 25 rps budget): the receipt must be a success and carry a `Tipped`
 * log emitted by the Blockbeat contract for the note's session. The tipper and the amount come
 * from that log, never from the client.
 */
import { BaseError, TransactionReceiptNotFoundError, parseEventLogs, type Address, type Hash, type Log } from 'viem';
import { blockbeatAbi } from '@blockbeat/shared';

export type TipVerifyCode = 'NOT_FOUND' | 'REVERTED' | 'NOT_A_TIP' | 'RPC_ERROR';

export class TipVerifyError extends Error {
  override readonly cause: unknown;
  constructor(
    readonly code: TipVerifyCode,
    message: string,
    options: { cause?: unknown } = {},
  ) {
    super(message);
    this.name = 'TipVerifyError';
    this.cause = options.cause;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface VerifiedTip {
  from: Address;
  amountWei: bigint;
  blockNumber: bigint;
  /** W21a TipSplit amounts; null when the receipt has no TipSplit event. */
  hostWei: bigint | null;
  poolWei: bigint | null;
}

/** The one PublicClient read this needs (a fake in tests). */
export interface ReceiptClient {
  getTransactionReceipt(args: { hash: Hash }): Promise<{ status: 'success' | 'reverted'; logs: Log[]; blockNumber: bigint }>;
}

export interface VerifyTipArgs {
  client: ReceiptClient;
  address: Address;
  sessionId: bigint;
  txHash: Hash;
}

function isNotFound(error: unknown): boolean {
  if (error instanceof TransactionReceiptNotFoundError) return true;
  return error instanceof BaseError && error.walk((e) => e instanceof TransactionReceiptNotFoundError) instanceof TransactionReceiptNotFoundError;
}

export async function verifyTipTx({ client, address, sessionId, txHash }: VerifyTipArgs): Promise<VerifiedTip> {
  let receipt: Awaited<ReturnType<ReceiptClient['getTransactionReceipt']>>;
  try {
    receipt = await client.getTransactionReceipt({ hash: txHash });
  } catch (error) {
    if (isNotFound(error)) throw new TipVerifyError('NOT_FOUND', 'the transaction has no receipt yet', { cause: error });
    throw new TipVerifyError('RPC_ERROR', 'could not read the transaction receipt', { cause: error });
  }
  if (receipt.status !== 'success') throw new TipVerifyError('REVERTED', 'the transaction reverted');
  const contract = address.toLowerCase();
  const own = receipt.logs.filter((log) => log.address.toLowerCase() === contract);
  const tip = parseEventLogs({ abi: blockbeatAbi, eventName: 'Tipped', logs: own, strict: true }).find((log) => log.args.sessionId === sessionId);
  if (!tip) throw new TipVerifyError('NOT_A_TIP', 'the transaction is not a tip to this session');
  // W21a: the TipSplit the contract emits right after every Tipped.
  const split = parseEventLogs({ abi: blockbeatAbi, eventName: 'TipSplit', logs: own, strict: true }).find((log) => log.args.sessionId === sessionId);
  return {
    from: tip.args.from,
    amountWei: tip.args.amount,
    blockNumber: receipt.blockNumber,
    hostWei: split ? split.args.hostAmount : null,
    poolWei: split ? split.args.poolAmount : null,
  };
}
