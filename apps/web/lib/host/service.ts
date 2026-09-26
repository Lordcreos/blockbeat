/**
 * Host service: `startSession` and `finalize` signed by the host key. Server only. Calls
 * are serialised so a double click never races the host nonce. The chain-backed service
 * uses fixed gas limits and reads the result from the emitted event, never from a return
 * value (viem cannot return values from a sent transaction).
 */
import { parseEventLogs, type Account, type Address, type Chain, type Hash, type Log, type PublicClient, type Transport, type WalletClient } from 'viem';
import { FINALIZE_GAS_LIMIT, HOST_CLAIM_GAS_LIMIT, START_SESSION_GAS_LIMIT, blockbeatAbi } from '@blockbeat/shared';

export type HostErrorCode = 'SEND_FAILED' | 'TX_REVERTED' | 'LOG_MISSING' | 'TIMEOUT';

export class HostError extends Error {
  readonly code: HostErrorCode;
  override readonly cause: unknown;
  constructor(code: HostErrorCode, message: string, options: { cause?: unknown } = {}) {
    super(message);
    this.name = 'HostError';
    this.code = code;
    this.cause = options.cause;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface StartSessionResult {
  sessionId: bigint;
  txHash: Hash | null;
}

export interface FinalizeResult {
  sessionId: bigint;
  tokenId: bigint;
  contributors: bigint;
  txHash: Hash | null;
}

/** W21b: the host pulled its share of the session's tips (W21a `claimHost`). */
export interface HostClaimResult {
  sessionId: bigint;
  amountWei: bigint;
  txHash: Hash | null;
}

export interface HostService {
  startSession(): Promise<StartSessionResult>;
  finalize(sessionId: bigint): Promise<FinalizeResult>;
  /** W21b: host only, any time; reverts NotHost / NothingToClaim on chain (a 409 TX_REVERTED). */
  claimHost(sessionId: bigint): Promise<HostClaimResult>;
}

export { FINALIZE_GAS_LIMIT, HOST_CLAIM_GAS_LIMIT, START_SESSION_GAS_LIMIT };
export const RECEIPT_TIMEOUT_MS = 30_000;

export interface ChainHostServiceOptions {
  wallet: WalletClient<Transport, Chain, Account>;
  publicClient: PublicClient<Transport, Chain>;
  address: Address;
  receiptTimeoutMs?: number;
  /** Server-side log for RPC failures. viem error text embeds the RPC URL (and any provider key in it), so it must never reach a response. */
  log?: (message: string) => void;
}

interface Receipt {
  status: 'success' | 'reverted';
  logs: Log[];
}

export function createChainHostService(options: ChainHostServiceOptions): HostService {
  const { wallet, publicClient, address } = options;
  const receiptTimeoutMs = options.receiptTimeoutMs ?? RECEIPT_TIMEOUT_MS;
  const log = options.log ?? ((m: string) => console.error(m));
  let queue: Promise<unknown> = Promise.resolve();

  /** Runs `task` after every previously queued task, whether they succeeded or failed. */
  function serialised<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(task, task);
    queue = run.catch(() => undefined);
    return run;
  }

  async function sendAndWait(what: string, send: () => Promise<Hash>): Promise<{ txHash: Hash; receipt: Receipt }> {
    let txHash: Hash;
    try {
      txHash = await send();
    } catch (error) {
      log(`host: ${what} send failed: ${describe(error)}`);
      throw new HostError('SEND_FAILED', `${what} send failed; see the server log`, { cause: error });
    }
    let receipt: Receipt;
    try {
      receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: receiptTimeoutMs });
    } catch (error) {
      log(`host: ${what} receipt ${txHash} not seen: ${describe(error)}`);
      throw new HostError('TIMEOUT', `${what} receipt not seen within ${receiptTimeoutMs} ms (${txHash})`, { cause: error });
    }
    if (receipt.status !== 'success') throw new HostError('TX_REVERTED', `${what} reverted (${txHash})`);
    return { txHash, receipt };
  }

  return {
    startSession: () =>
      serialised(async () => {
        const { txHash, receipt } = await sendAndWait('startSession', () =>
          wallet.writeContract({ address, abi: blockbeatAbi, functionName: 'startSession', gas: START_SESSION_GAS_LIMIT }),
        );
        const [started] = parseEventLogs({ abi: blockbeatAbi, eventName: 'SessionStarted', logs: receipt.logs, strict: true });
        if (!started) throw new HostError('LOG_MISSING', `startSession mined (${txHash}) but no SessionStarted log was emitted`);
        return { sessionId: started.args.sessionId, txHash };
      }),

    finalize: (sessionId) =>
      serialised(async () => {
        const { txHash, receipt } = await sendAndWait('finalize', () =>
          wallet.writeContract({ address, abi: blockbeatAbi, functionName: 'finalize', args: [sessionId], gas: FINALIZE_GAS_LIMIT }),
        );
        const [finalized] = parseEventLogs({ abi: blockbeatAbi, eventName: 'Finalized', logs: receipt.logs, strict: true });
        if (!finalized) throw new HostError('LOG_MISSING', `finalize mined (${txHash}) but no Finalized log was emitted`);
        return { sessionId: finalized.args.sessionId, tokenId: finalized.args.tokenId, contributors: finalized.args.contributors, txHash };
      }),

    claimHost: (sessionId) =>
      serialised(async () => {
        const { txHash, receipt } = await sendAndWait('claimHost', () =>
          wallet.writeContract({ address, abi: blockbeatAbi, functionName: 'claimHost', args: [sessionId], gas: HOST_CLAIM_GAS_LIMIT }),
        );
        const own = receipt.logs.filter((log) => log.address.toLowerCase() === address.toLowerCase());
        const [claimed] = parseEventLogs({ abi: blockbeatAbi, eventName: 'HostClaimed', logs: own, strict: true });
        if (!claimed) throw new HostError('LOG_MISSING', `claimHost mined (${txHash}) but no HostClaimed log was emitted`);
        return { sessionId: claimed.args.sessionId, amountWei: claimed.args.amount, txHash };
      }),
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Mock mode: no chain, no key. Ids count up from 1 so the demo links stay predictable. */
export function createMockHostService(): HostService {
  let next = 1n;
  return {
    async startSession() {
      const sessionId = next;
      next += 1n;
      return { sessionId, txHash: null };
    },
    async finalize(sessionId) {
      return { sessionId, tokenId: sessionId, contributors: 0n, txHash: null };
    },
    // W21b: the simulator lives in the browser; the stage pulls the mock host share there.
    async claimHost(sessionId) {
      return { sessionId, amountWei: 0n, txHash: null };
    },
  };
}
