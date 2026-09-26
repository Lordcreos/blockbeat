import { describe, expect, it, vi } from 'vitest';
import type { Address, Hash } from 'viem';
import type { TipNoteRequest } from './note';
import { createTipNoteStore } from './noteStore';
import { TipNoteError, createTipNoteService } from './noteService';
import { createWindowRateLimiter } from './rateLimit';
import { TipVerifyError, type VerifiedTip } from './verify';

const FROM = '0x1111111111111111111111111111111111111111' as Address;
const TX = `0x${'ab'.repeat(32)}` as Hash;
const TX2 = `0x${'cd'.repeat(32)}` as Hash;

function request(overrides: Partial<TipNoteRequest> = {}): TipNoteRequest {
  return { sessionId: 7n, txHash: TX, name: 'Ana', message: 'more kick', mock: null, ...overrides };
}

const verified: VerifiedTip = { from: FROM, amountWei: 20_000_000_000_000_000n, blockNumber: 900n, hostWei: null, poolWei: null };

function setup(options: { verify?: (sessionId: bigint, txHash: Hash) => Promise<VerifiedTip>; mock?: boolean; perIp?: number } = {}) {
  const store = createTipNoteStore({ file: null });
  const verify = vi.fn(options.verify ?? (async () => verified));
  const service = createTipNoteService({
    store,
    verify,
    mock: options.mock ?? false,
    limiter: createWindowRateLimiter({ perKey: options.perIp ?? 10, global: 100 }),
    now: () => 1_790_000_000_000,
    log: () => undefined,
  });
  return { store, verify, service };
}

describe('createTipNoteService (W21b)', () => {
  it('stores a note with the amount and tipper read from the verified receipt, not from the client', async () => {
    const { service, verify } = setup();
    const note = await service.submit(request(), '1.1.1.1');
    expect(verify).toHaveBeenCalledWith(7n, TX);
    expect(note).toEqual({
      sessionId: '7',
      txHash: TX,
      from: FROM,
      amountWei: '20000000000000000',
      hostWei: null,
      poolWei: null,
      blockNumber: '900',
      name: 'Ana',
      message: 'more kick',
      createdAt: 1_790_000_000_000,
    });
    expect((await service.list(7n, 10)).map((n) => n.txHash)).toEqual([TX]);
  });

  it('keeps the W21a split amounts when the receipt has them', async () => {
    const { service } = setup({ verify: async () => ({ ...verified, hostWei: 4n, poolWei: 16n }) });
    expect(await service.submit(request(), 'ip')).toMatchObject({ hostWei: '4', poolWei: '16' });
  });

  it('refuses a second note for the same tx without reading the chain again', async () => {
    const { service, verify } = setup();
    await service.submit(request(), 'ip');
    await expect(service.submit(request({ name: 'Bob' }), 'ip')).rejects.toMatchObject({ code: 'DUPLICATE', status: 409 });
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it('refuses a concurrent duplicate while the first one is still being verified', async () => {
    let release: (tip: VerifiedTip) => void = () => undefined;
    const { service } = setup({ verify: () => new Promise((r) => (release = r)) });
    const first = service.submit(request(), 'ip');
    await expect(service.submit(request(), 'ip')).rejects.toMatchObject({ code: 'DUPLICATE' });
    release(verified);
    await expect(first).resolves.toMatchObject({ txHash: TX });
  });

  it.each([
    ['NOT_FOUND', 'RECEIPT_NOT_FOUND', 404],
    ['REVERTED', 'TX_REVERTED', 422],
    ['NOT_A_TIP', 'NOT_A_TIP', 422],
    ['RPC_ERROR', 'RPC_ERROR', 502],
  ] as const)('maps a %s receipt check to %s (%i)', async (verifyCode, code, status) => {
    const { service } = setup({ verify: async () => Promise.reject(new TipVerifyError(verifyCode, 'x')) });
    const failure = service.submit(request(), 'ip');
    await expect(failure).rejects.toBeInstanceOf(TipNoteError);
    await expect(failure).rejects.toMatchObject({ code, status });
  });

  it('lets the phone retry after a receipt the node has not seen yet', async () => {
    const verify = vi.fn<(s: bigint, h: Hash) => Promise<VerifiedTip>>().mockRejectedValueOnce(new TipVerifyError('NOT_FOUND', 'x')).mockResolvedValueOnce(verified);
    const { service } = setup({ verify });
    await expect(service.submit(request(), 'ip')).rejects.toMatchObject({ code: 'RECEIPT_NOT_FOUND', retryAfterMs: 1_000 });
    await expect(service.submit(request(), 'ip')).resolves.toMatchObject({ txHash: TX });
  });

  it('rate-limits per IP before touching the RPC', async () => {
    const { service, verify } = setup({ perIp: 1 });
    await service.submit(request(), 'ip');
    await expect(service.submit(request({ txHash: TX2 }), 'ip')).rejects.toMatchObject({ code: 'RATE_LIMITED', status: 429 });
    expect(verify).toHaveBeenCalledTimes(1);
    await expect(service.submit(request({ txHash: TX2 }), 'other-ip')).resolves.toBeDefined();
  });

  it('in mock mode takes the tip from the simulator fields and never reads a chain', async () => {
    const { service, verify } = setup({ mock: true });
    const note = await service.submit(request({ mock: { from: FROM, amountWei: 30n } }), 'ip');
    expect(note).toMatchObject({ from: FROM, amountWei: '30', blockNumber: '0' });
    expect(verify).not.toHaveBeenCalled();
    await expect(service.submit(request({ txHash: TX2 }), 'ip')).rejects.toMatchObject({ code: 'INVALID_MOCK', status: 400 });
  });

  it('reports a full store as NOTES_FULL', async () => {
    const store = createTipNoteStore({ file: null, maxPerSession: 1 });
    const service = createTipNoteService({ store, verify: async () => verified, mock: false, limiter: createWindowRateLimiter({ perKey: 10, global: 10 }), log: () => undefined });
    await service.submit(request(), 'ip');
    await expect(service.submit(request({ txHash: TX2 }), 'ip')).rejects.toMatchObject({ code: 'NOTES_FULL', status: 409 });
  });
});
