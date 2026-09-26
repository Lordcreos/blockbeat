import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Address, Hash } from 'viem';
import { TipNoteError, type TipNoteService } from '@/lib/tips/noteService';
import type { TipNote } from '@/lib/tips/noteStore';
import { createWindowRateLimiter } from '@/lib/tips/rateLimit';

const TX = `0x${'ab'.repeat(32)}` as Hash;
const FROM = '0x1111111111111111111111111111111111111111' as Address;
const NOTE: TipNote = { sessionId: '7', txHash: TX, from: FROM, amountWei: '20000000000000000', hostWei: null, poolWei: null, blockNumber: '900', name: 'Ana', message: '<b>hi</b>', createdAt: 1 };

const submit = vi.fn<TipNoteService['submit']>();
const list = vi.fn<TipNoteService['list']>();
let mock = false;
let readLimiter = createWindowRateLimiter({ perKey: 1_000, global: 1_000 });

vi.mock('@/lib/tips/runtime', () => ({
  getTipNoteService: (): TipNoteService => ({ submit, list }),
  getTipNoteReadLimiter: () => readLimiter,
}));
vi.mock('@/lib/chain/clients', () => ({ isMockMode: () => mock }));

const { GET, POST } = await import('./route');

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/tip-note', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('POST /api/tip-note (W21b)', () => {
  beforeEach(() => {
    submit.mockReset();
    list.mockReset();
    mock = false;
  });

  it('stores a verified note and answers 201 with it', async () => {
    submit.mockResolvedValueOnce(NOTE);
    const res = await POST(post({ sessionId: '7', txHash: TX, name: ' Ana ', message: '<b>hi</b>' }, { 'cf-connecting-ip': '198.51.100.7' }));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ note: NOTE });
    expect(submit).toHaveBeenCalledWith({ sessionId: 7n, txHash: TX, name: 'Ana', message: '<b>hi</b>', mock: null }, '198.51.100.7');
  });

  it('refuses malformed JSON, bad fields and oversized bodies before the service', async () => {
    expect((await POST(post('{nope'))).status).toBe(400);
    const bad = await POST(post({ sessionId: 'x', txHash: TX }));
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe('INVALID_SESSION');
    expect((await POST(post({ sessionId: '1', txHash: TX, message: 'x'.repeat(5_000) }))).status).toBe(413);
    expect((await POST(post({ sessionId: '1', txHash: TX }, { 'content-length': '99999' }))).status).toBe(413);
    expect(submit).not.toHaveBeenCalled();
  });

  it('ignores the mock fields outside mock mode and reads them in mock mode', async () => {
    submit.mockResolvedValue(NOTE);
    const body = { sessionId: '7', txHash: TX, mock: { from: FROM, amountWei: '5' } };
    await POST(post(body));
    expect(submit.mock.calls[0]?.[0].mock).toBeNull();
    mock = true;
    await POST(post(body));
    expect(submit.mock.calls[1]?.[0].mock).toEqual({ from: FROM, amountWei: 5n });
  });

  it('maps service errors to their status with Retry-After and no internals', async () => {
    submit.mockRejectedValueOnce(new TipNoteError('RECEIPT_NOT_FOUND', 'the transaction has no receipt yet', { retryAfterMs: 1_000 }));
    const res = await POST(post({ sessionId: '7', txHash: TX }));
    expect(res.status).toBe(404);
    expect(res.headers.get('retry-after')).toBe('1');
    expect(await res.json()).toEqual({ error: { code: 'RECEIPT_NOT_FOUND', message: 'the transaction has no receipt yet' } });
  });

  it('answers 500 without detail on an unexpected error', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    submit.mockRejectedValueOnce(new Error('ENOSPC /secret/path'));
    const res = await POST(post({ sessionId: '7', txHash: TX }));
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain('secret');
    spy.mockRestore();
  });
});

describe('GET /api/tip-note?session=N (W21b)', () => {
  beforeEach(() => {
    list.mockReset();
    readLimiter = createWindowRateLimiter({ perKey: 1_000, global: 1_000 });
  });

  it('lists the notes of a session, newest first, uncached', async () => {
    list.mockResolvedValueOnce([NOTE]);
    const res = await GET(new Request('http://localhost/api/tip-note?session=7&limit=5'));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ notes: [NOTE] });
    expect(list).toHaveBeenCalledWith(7n, 5);
  });

  it('defaults and clamps the limit', async () => {
    list.mockResolvedValue([]);
    await GET(new Request('http://localhost/api/tip-note?session=7'));
    await GET(new Request('http://localhost/api/tip-note?session=7&limit=100000'));
    expect(list.mock.calls.map((c) => c[1])).toEqual([50, 500]);
  });

  it('refuses a missing or malformed session and a bad limit', async () => {
    expect((await GET(new Request('http://localhost/api/tip-note'))).status).toBe(400);
    expect((await GET(new Request('http://localhost/api/tip-note?session=0'))).status).toBe(400);
    expect((await GET(new Request('http://localhost/api/tip-note?session=1&limit=-2'))).status).toBe(400);
    expect(list).not.toHaveBeenCalled();
  });

  it('rate-limits reads per IP', async () => {
    readLimiter = createWindowRateLimiter({ perKey: 1, global: 100 });
    list.mockResolvedValue([]);
    expect((await GET(new Request('http://localhost/api/tip-note?session=7', { headers: { 'cf-connecting-ip': '1.1.1.1' } }))).status).toBe(200);
    const res = await GET(new Request('http://localhost/api/tip-note?session=7', { headers: { 'cf-connecting-ip': '1.1.1.1' } }));
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
  });
});
