'use client';
/**
 * W21b: hooks for the tip page (/tip/[session]) and the tip views on the stage and track.
 * The tip page runs its own burner (runtime.tipper(), a separate storage key), funded once by
 * the drip in tipper mode; every tip goes out from it with the amount the tipper picked, and
 * its optional name and message are posted to /api/tip-note once the receipt is in.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { Address, Hash } from 'viem';
import type { BurnerAccount } from '../burner';
import { getRuntime, type AcquiredTipSender } from '../runtime';
import { TipError } from '../tipSender';
import type { BurnerWallet, TipReceipt } from '../types';
import { isTipNote, type TipNote } from './noteShape';

const views = new WeakMap<BurnerAccount, BurnerWallet>();
function tipperView(): BurnerWallet {
  const account = getRuntime().tipper();
  let view = views.get(account);
  if (!view) {
    view = { address: account.address, restored: account.restored, persisted: account.persisted };
    views.set(account, view);
  }
  return view;
}
const noopSubscribe = (): (() => void) => () => undefined;
const nullSnapshot = (): null => null;

/** The tip page's burner: null on the server and during hydration (it lives in localStorage). */
export function useTipper(): BurnerWallet | null {
  return useSyncExternalStore(noopSubscribe, tipperView, nullSnapshot);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const MAX_FUNDING_ATTEMPTS = 4;
const MAX_RETRY_AFTER_S = 30;

function retryAfterS(res: Response, fallback: number): number {
  const raw = res.headers.get('retry-after')?.trim();
  return raw && /^\d+$/.test(raw) ? Math.min(MAX_RETRY_AFTER_S, Math.max(1, Number(raw))) : fallback;
}

interface ErrorBody {
  error?: { code?: string; message?: string };
}

function errorOf(status: number, body: unknown): { code: string; message: string } {
  const err = (body as ErrorBody | null)?.error;
  return { code: err?.code ?? `HTTP_${status}`, message: err?.message ?? 'request failed' };
}

interface TipperDripBody {
  txHash: Hash | null;
  alreadyFunded: boolean;
  amountWei: string;
}

function isTipperDripBody(v: unknown): v is TipperDripBody {
  if (typeof v !== 'object' || v === null) return false;
  const b = v as Record<string, unknown>;
  return typeof b.alreadyFunded === 'boolean' && typeof b.amountWei === 'string' && /^\d+$/.test(b.amountWei) && (b.txHash === null || typeof b.txHash === 'string');
}

export interface TipperFunding {
  ready: boolean;
  loading: boolean;
  error: string | null;
  /** Seconds until the automatic retry after a 429; null otherwise. */
  retryInSeconds: number | null;
}

/**
 * Funds the tipper burner once (POST /api/drip { address, mode: "tipper" }). Mock mode: the
 * simulator is credited with the amount. Chain: waits (from this phone) until the balance shows.
 */
export function useTipperFunding(address: Address | null, sessionId: bigint): TipperFunding {
  const [state, setState] = useState<{ address: Address; funding: TipperFunding } | null>(null);

  useEffect(() => {
    if (address === null) return;
    let cancelled = false;
    const set = (funding: TipperFunding): void => {
      if (!cancelled) setState({ address, funding });
    };
    (async () => {
      try {
        for (let attempt = 1; ; attempt++) {
          const res = await fetch('/api/drip', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address, mode: 'tipper', sessionId: sessionId.toString() }) });
          const body: unknown = await res.json().catch(() => null);
          if (res.status === 429 && attempt < MAX_FUNDING_ATTEMPTS) {
            for (let left = retryAfterS(res, 5); left > 0 && !cancelled; left--) {
              set({ ready: false, loading: true, error: null, retryInSeconds: left });
              await sleep(1_000);
            }
            if (cancelled) return;
            continue;
          }
          if (!res.ok || !isTipperDripBody(body)) {
            const err = errorOf(res.status, body);
            set({ ready: false, loading: false, error: `${err.code}: ${err.message}`, retryInSeconds: null });
            return;
          }
          const runtime = getRuntime();
          if (body.txHash === null && !body.alreadyFunded) runtime.creditDrip(address, BigInt(body.amountWei));
          if (body.txHash !== null && !body.alreadyFunded) {
            set({ ready: false, loading: true, error: null, retryInSeconds: null });
            try {
              if (!(await runtime.waitForFunds(address))) console.warn(`tipper drip ${body.txHash}: balance still zero after the wait; opening the form anyway`);
            } catch (e) {
              console.warn(`tipper drip ${body.txHash}: balance check failed (${e instanceof Error ? e.message : String(e)}); opening the form anyway`);
            }
          }
          set({ ready: true, loading: false, error: null, retryInSeconds: null });
          return;
        }
      } catch (e) {
        set({ ready: false, loading: false, error: e instanceof Error ? e.message : String(e), retryInSeconds: null });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [address, sessionId]);

  if (address === null) return { ready: false, loading: false, error: null, retryInSeconds: null };
  if (state === null || state.address !== address) return { ready: false, loading: true, error: null, retryInSeconds: null };
  return state.funding;
}

export interface UseSendTip {
  send(amountWei: bigint): Promise<TipReceipt>;
  pending: boolean;
  /** When a tip can go out under the Monad reserve rule (a countdown); null when it can go now. */
  readyAt(): number | null;
}

/** Sends tips from the tipper burner (fixed gas and fees, never eth_estimateGas; lib/chain/tipWriter.ts). */
export function useSendTip(sessionId: bigint | null): UseSendTip {
  const [pending, setPending] = useState(false);
  const held = useRef<AcquiredTipSender | null>(null);

  useEffect(() => {
    if (sessionId === null) return;
    const acquired = getRuntime().acquireTipSender(sessionId);
    held.current = acquired;
    return () => {
      if (held.current === acquired) held.current = null;
      acquired.release();
    };
  }, [sessionId]);

  const send = useCallback(
    async (amountWei: bigint): Promise<TipReceipt> => {
      if (sessionId === null) throw new TipError('INVALID_ARGS', 'no session selected');
      const transient = held.current ? null : getRuntime().acquireTipSender(sessionId);
      const sender = (held.current ?? transient)?.sender;
      if (!sender) throw new TipError('SEND_FAILED', 'tip sender unavailable');
      const p = sender.send(sessionId, amountWei);
      setPending(sender.pending() > 0);
      try {
        return await p;
      } finally {
        setPending(sender.pending() > 0);
        transient?.release();
      }
    },
    [sessionId],
  );
  const readyAt = useCallback((): number | null => getRuntime().tipReadyAt(), []);
  return { send, pending, readyAt };
}

export interface TipNotePost {
  sessionId: bigint;
  txHash: Hash;
  name: string | null;
  message: string | null;
  /** Mock mode: the simulator tip (the server has no receipt to read). */
  mock?: { from: Address; amountWei: bigint };
}

export type TipNotePostResult = { ok: true; note: TipNote } | { ok: false; code: string; message: string };

export interface PostTipNoteOptions {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** RECEIPT_NOT_FOUND and 429 are retried this many times in all. */
  attempts?: number;
}

/** POST /api/tip-note after the tip's receipt; retries while the node has not indexed it yet. */
export async function postTipNote(post: TipNotePost, options: PostTipNoteOptions = {}): Promise<TipNotePostResult> {
  const doFetch = options.fetchImpl ?? fetch;
  const wait = options.sleep ?? sleep;
  const attempts = options.attempts ?? 5;
  const body = JSON.stringify({
    sessionId: post.sessionId.toString(),
    txHash: post.txHash,
    ...(post.name ? { name: post.name } : {}),
    ...(post.message ? { message: post.message } : {}),
    ...(post.mock ? { mock: { from: post.mock.from, amountWei: post.mock.amountWei.toString() } } : {}),
  });
  let last: TipNotePostResult = { ok: false, code: 'NETWORK', message: 'not sent' };
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let res: Response;
    try {
      res = await doFetch('/api/tip-note', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    } catch (e) {
      last = { ok: false, code: 'NETWORK', message: e instanceof Error ? e.message : String(e) };
      if (attempt < attempts) await wait(1_000);
      continue;
    }
    const answer: unknown = await res.json().catch(() => null);
    if (res.status === 201 && isTipNote((answer as { note?: unknown } | null)?.note)) return { ok: true, note: (answer as { note: TipNote }).note };
    const err = errorOf(res.status, answer);
    last = { ok: false, ...err };
    const retryable = err.code === 'RECEIPT_NOT_FOUND' || res.status === 429;
    if (!retryable || attempt >= attempts) return last;
    await wait(retryAfterS(res, 1) * 1_000);
  }
  return last;
}

export interface UseTipNotes {
  /** Newest first, as the server holds them. */
  notes: TipNote[];
  error: string | null;
  refresh(): void;
}

export const TIP_NOTES_POLL_MS = 3_000;

/** GET /api/tip-note for the session now and every `pollMs` (the laptop asks its own server; no RPC). */
export function useTipNotes(sessionId: bigint | null, pollMs: number = TIP_NOTES_POLL_MS, limit = 50): UseTipNotes {
  const [state, setState] = useState<{ key: string; notes: TipNote[]; error: string | null } | null>(null);
  const [version, setVersion] = useState(0);
  const key = sessionId === null ? null : `${sessionId}:${limit}`;

  useEffect(() => {
    if (sessionId === null || key === null) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const load = async (): Promise<void> => {
      try {
        const res = await fetch(`/api/tip-note?session=${sessionId.toString()}&limit=${limit}`);
        const body: unknown = await res.json().catch(() => null);
        if (!res.ok) throw new Error(`${errorOf(res.status, body).code}`);
        const raw = (body as { notes?: unknown } | null)?.notes;
        const notes = Array.isArray(raw) ? raw.filter(isTipNote) : [];
        if (!cancelled) setState({ key, notes, error: null });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (!cancelled) setState((prev) => (prev && prev.key === key ? { ...prev, error: message } : { key, notes: [], error: message }));
      } finally {
        if (!cancelled && pollMs > 0) timer = setTimeout(() => void load(), pollMs);
      }
    };
    void load();
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [sessionId, key, limit, pollMs, version]);

  const refresh = useCallback(() => setVersion((v) => v + 1), []);
  const current = state && state.key === key ? state : null;
  return { notes: current?.notes ?? [], error: current?.error ?? null, refresh };
}
