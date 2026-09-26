import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContractFunctionRevertedError, encodeErrorResult, parseEther, type Hash } from 'viem';
import { blockbeatAbi } from '@blockbeat/shared';
import { TIP_AMOUNT_MON, TIP_RESERVE_GUARD_MS, TipError, createBurnerActivity, createTipSender, type TipReceiptSource, type TipWriter } from './tipSender';

/** What viem throws when the node reverts a simulated or sent `tip` with a custom error the ABI knows. */
function revert(errorName: 'NoHits' | 'ZeroTip'): ContractFunctionRevertedError {
  return new ContractFunctionRevertedError({ abi: blockbeatAbi, functionName: 'tip', data: encodeErrorResult({ abi: blockbeatAbi, errorName }) });
}

const TX = `0x${'ab'.repeat(32)}` as Hash;

function receipts(blockNumber = 42n, status: 'success' | 'reverted' = 'success', delayMs = 0): TipReceiptSource {
  return {
    waitForReceipt: (hash) =>
      new Promise((resolve) => {
        expect(hash).toBe(TX);
        setTimeout(() => resolve({ blockNumber, status }), delayMs);
      }),
  };
}

describe('createTipSender', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('tips 0.005 MON and resolves with the landing block and latency', async () => {
    const writer = vi.fn<TipWriter>(async () => TX);
    const sender = createTipSender({ writer, receipts: receipts(42n, 'success', 250) });
    const p = sender.send(7n);
    expect(sender.pending()).toBe(1);
    await vi.advanceTimersByTimeAsync(250);
    const r = await p;
    expect(writer).toHaveBeenCalledWith({ sessionId: 7n, valueWei: parseEther(TIP_AMOUNT_MON) });
    expect(r).toEqual({ txHash: TX, blockNumber: 42n, amountWei: parseEther('0.005'), latencyMs: 250 });
    expect(sender.pending()).toBe(0);
  });

  it('W21b: sends the amount the tipper picked, and explains a revert with that amount', async () => {
    const writer = vi.fn<TipWriter>(async () => TX);
    const explainRevert = vi.fn(async () => 'NoHits');
    const sender = createTipSender({ writer, receipts: { ...receipts(9n, 'success', 10), explainRevert } });
    const p = sender.send(7n, parseEther('0.03'));
    await vi.advanceTimersByTimeAsync(10);
    expect((await p).amountWei).toBe(parseEther('0.03'));
    expect(writer).toHaveBeenCalledWith({ sessionId: 7n, valueWei: parseEther('0.03') });
    const reverted = createTipSender({ writer, receipts: { ...receipts(9n, 'reverted', 10), explainRevert } });
    const q = reverted.send(7n, parseEther('0.04'));
    const settled = q.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(10);
    expect(await settled).toMatchObject({ code: 'NO_HITS' });
    expect(explainRevert).toHaveBeenCalledWith({ sessionId: 7n, valueWei: parseEther('0.04') });
  });

  it('W21b: refuses a zero or negative amount before sending', async () => {
    const writer = vi.fn<TipWriter>(async () => TX);
    const sender = createTipSender({ writer, receipts: receipts() });
    await expect(sender.send(7n, 0n)).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    expect(writer).not.toHaveBeenCalled();
  });

  it('waits out the Monad reserve window after the burner\'s last hit or tip before sending a tip (W11)', async () => {
    // A burner holds < 10 MON: a value transfer lands only if it sent nothing in the past 3 blocks.
    expect(TIP_RESERVE_GUARD_MS).toBe(1_500);
    const activity = createBurnerActivity();
    const writer = vi.fn<TipWriter>(async () => TX);
    const sender = createTipSender({ writer, receipts: receipts(), activity });
    activity.markSend(Date.now()); // a pad tap just went out
    const first = sender.send(7n);
    await vi.advanceTimersByTimeAsync(TIP_RESERVE_GUARD_MS - 100);
    expect(writer).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(writer).toHaveBeenCalledTimes(1);
    await first;
    // The tip itself counts: a second tip right away waits again.
    const second = sender.send(7n);
    await vi.advanceTimersByTimeAsync(10);
    expect(writer).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(TIP_RESERVE_GUARD_MS);
    expect(writer).toHaveBeenCalledTimes(2);
    await second;
  });

  it('serialises overlapping tips so the second waits a full window after the first (review of W11)', async () => {
    const activity = createBurnerActivity();
    const calls: number[] = [];
    const writer = vi.fn<TipWriter>(async () => {
      calls.push(Date.now());
      return TX;
    });
    const sender = createTipSender({ writer, receipts: receipts(), activity });
    const both = Promise.all([sender.send(7n), sender.send(7n)]);
    await vi.advanceTimersByTimeAsync(TIP_RESERVE_GUARD_MS * 3);
    await both;
    expect(calls).toHaveLength(2);
    expect((calls[1] ?? 0) - (calls[0] ?? 0)).toBeGreaterThanOrEqual(TIP_RESERVE_GUARD_MS);
  });

  it('sends immediately when the burner has been quiet for the window', async () => {
    const activity = createBurnerActivity();
    activity.markSend(Date.now() - 5_000);
    const writer = vi.fn<TipWriter>(async () => TX);
    const p = createTipSender({ writer, receipts: receipts(), activity }).send(7n);
    await vi.advanceTimersByTimeAsync(0);
    expect(writer).toHaveBeenCalledTimes(1);
    await p;
  });

  it('rejects with INVALID_ARGS for a non-positive session id', async () => {
    const writer = vi.fn<TipWriter>(async () => TX);
    const sender = createTipSender({ writer, receipts: receipts() });
    await expect(sender.send(0n)).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    expect(writer).not.toHaveBeenCalled();
  });

  it('maps a decoded NoHits revert to NO_HITS by errorName (review H10)', async () => {
    const writer: TipWriter = async () => {
      throw revert('NoHits');
    };
    const sender = createTipSender({ writer, receipts: receipts() });
    const err = await sender.send(1n).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TipError);
    expect(err).toMatchObject({ code: 'NO_HITS' });
    expect(sender.pending()).toBe(0);
  });

  it('names other decoded reverts in the SEND_FAILED message instead of viem\'s wall of text', async () => {
    const writer: TipWriter = async () => {
      throw revert('ZeroTip');
    };
    const sender = createTipSender({ writer, receipts: receipts() });
    const err = (await sender.send(1n).catch((e: unknown) => e)) as TipError;
    expect(err).toMatchObject({ code: 'SEND_FAILED' });
    expect(err.message).toBe('tip reverted: ZeroTip');
  });

  it('does not guess NO_HITS from message text or a raw selector (the ABI decodes, nothing else)', async () => {
    const writer: TipWriter = async () => {
      throw new Error('The contract function "tip" reverted with the following signature:\n0x614121a9');
    };
    const sender = createTipSender({ writer, receipts: receipts() });
    await expect(sender.send(1n)).rejects.toMatchObject({ code: 'SEND_FAILED' });
  });

  it('maps other writer failures to SEND_FAILED with the cause', async () => {
    const cause = new Error('insufficient funds');
    const writer: TipWriter = async () => {
      throw cause;
    };
    const sender = createTipSender({ writer, receipts: receipts() });
    const err = await sender.send(1n).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'SEND_FAILED', cause });
    expect((err as Error).message).toContain('insufficient funds');
  });

  it('reports a reverted receipt as SEND_FAILED with the tx hash', async () => {
    const sender = createTipSender({ writer: async () => TX, receipts: receipts(9n, 'reverted') });
    const settled = sender.send(1n).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(0);
    await expect(settled).resolves.toMatchObject({ code: 'SEND_FAILED', txHash: TX });
  });

  it('diagnoses a reverted receipt through explainRevert (which answers with the errorName) and maps NoHits to NO_HITS', async () => {
    const explainRevert = vi.fn(async () => 'NoHits');
    const sender = createTipSender({ writer: async () => TX, receipts: { ...receipts(9n, 'reverted'), explainRevert } });
    const settled = sender.send(1n).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(0);
    await expect(settled).resolves.toMatchObject({ code: 'NO_HITS', txHash: TX });
    expect(explainRevert).toHaveBeenCalledWith({ sessionId: 1n, valueWei: parseEther('0.005') });
  });

  it('reports any other diagnosis verbatim as SEND_FAILED', async () => {
    const explainRevert = async () => 'ZeroTip';
    const sender = createTipSender({ writer: async () => TX, receipts: { ...receipts(9n, 'reverted'), explainRevert } });
    const settled = sender.send(1n).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(0);
    await expect(settled).resolves.toMatchObject({ code: 'SEND_FAILED', message: 'tip transaction reverted: ZeroTip' });
  });

  it('keeps SEND_FAILED when the revert diagnosis itself fails', async () => {
    const explainRevert = vi.fn(async () => {
      throw new Error('rpc down');
    });
    const sender = createTipSender({ writer: async () => TX, receipts: { ...receipts(9n, 'reverted'), explainRevert } });
    const settled = sender.send(1n).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(0);
    await expect(settled).resolves.toMatchObject({ code: 'SEND_FAILED', txHash: TX });
    expect((settled && (await settled)) as Error).toHaveProperty('message', expect.stringContaining('rpc down'));
  });

  it('times out when no receipt arrives', async () => {
    const sender = createTipSender({ writer: async () => TX, receipts: receipts(1n, 'success', 60_000), timeoutMs: 500 });
    const p = sender.send(1n);
    const settled = p.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(500);
    await expect(settled).resolves.toMatchObject({ code: 'TIMEOUT', txHash: TX });
    expect(sender.pending()).toBe(0);
  });
});

describe('tipReadyAt (W12)', () => {
  it('is null for a quiet burner and the end of the reserve wait after a send', async () => {
    const { createBurnerActivity, tipReadyAt, TIP_RESERVE_GUARD_MS } = await import('./tipSender');
    const activity = createBurnerActivity();
    expect(tipReadyAt(activity, 10_000)).toBeNull();
    activity.markSend(10_000);
    expect(tipReadyAt(activity, 10_000)).toBe(10_000 + TIP_RESERVE_GUARD_MS);
    expect(tipReadyAt(activity, 10_000 + TIP_RESERVE_GUARD_MS)).toBeNull();
    expect(TIP_RESERVE_GUARD_MS).toBe(1_500);
  });
});

