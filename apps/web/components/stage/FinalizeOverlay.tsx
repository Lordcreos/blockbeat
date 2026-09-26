'use client';
import Link from 'next/link';
import { useEffect, useRef } from 'react';
import type { Hash } from 'viem';
import { formatInt } from '@/components/format';

export interface FinalizeSummary {
  sessionId: bigint;
  tokenId: bigint;
  contributors: bigint;
  txHash: Hash | null;
  /** Monadscan token page, null on anvil or in mock mode. */
  explorerTokenUrl: string | null;
  explorerTxUrl: string | null;
}

interface FinalizeOverlayProps {
  result: FinalizeSummary;
  onClose: () => void;
}

/** The pitch closer: the minted track, its co-authors and where to see it. */
export function FinalizeOverlay({ result, onClose }: FinalizeOverlayProps) {
  const ref = useRef<HTMLAnchorElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Focus the primary action now and hand focus back to whatever opened us on close.
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    ref.current?.focus();
    return () => opener?.focus();
  }, []);
  const trackHref = `/track/${result.tokenId.toString()}`;

  const trapTab = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Tab' || !dialogRef.current) return;
    const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>('a[href], button:not([disabled])'));
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) return;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };
  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="finalize-title"
      data-testid="finalize-overlay"
      className="fixed inset-0 z-30 flex items-center justify-center px-6 backdrop-blur-sm"
      style={{ background: 'rgba(5, 5, 7, 0.86)' }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
        else trapTab(e);
      }}
    >
      <div className="flex max-w-[60ch] flex-col items-center gap-6 text-center">
        <p style={{ fontSize: 'var(--text-lg)', color: 'var(--ink-muted)' }}>Minted on chain</p>
        <h2 id="finalize-title" className="num" style={{ fontSize: 'clamp(40px, 5vw, var(--text-title))', fontWeight: 650, letterSpacing: '-0.025em', lineHeight: 1 }}>
          Blockbeat Track #{result.tokenId.toString()}
        </h2>
        <p className="num" style={{ fontSize: 'var(--text-lg)' }}>
          {formatInt(result.contributors)} {result.contributors === 1n ? 'co-author' : 'co-authors'} · session {result.sessionId.toString()}
        </p>
        <p style={{ fontSize: 'var(--text-md)', color: 'var(--ink-muted)', maxWidth: '44ch' }}>
          Everyone who tapped owns it. Tips to the session split by notes.
        </p>
        <div className="flex flex-wrap items-center justify-center gap-4">
          <Link
            ref={ref}
            href={trackHref}
            className="rounded-full px-8 py-4 font-semibold"
            style={{ background: 'var(--ink)', color: 'var(--ink-on-track)', fontSize: 'var(--text-md)' }}
          >
            Play the track
          </Link>
          {result.explorerTokenUrl && (
            <a
              href={result.explorerTokenUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="rounded-full px-8 py-4 font-semibold"
              style={{ background: 'var(--surface-2)', border: '1px solid var(--line-strong)', fontSize: 'var(--text-md)' }}
            >
              View on Monadscan
            </a>
          )}
          <Link
            href="/tracks"
            className="rounded-full px-8 py-4 font-semibold"
            style={{ background: 'var(--surface-2)', border: '1px solid var(--line-strong)', fontSize: 'var(--text-md)' }}
          >
            Open the gallery
          </Link>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full px-6 py-4 font-medium"
            style={{ color: 'var(--ink-muted)', fontSize: 'var(--text-md)' }}
          >
            Back to the stage
          </button>
        </div>
        <p className="num break-all" style={{ fontSize: 'var(--text-sm)', color: 'var(--ink-faint)' }}>
          {result.txHash ? (
            result.explorerTxUrl ? (
              <a href={result.explorerTxUrl} target="_blank" rel="noreferrer noopener">
                tx {result.txHash}
              </a>
            ) : (
              `tx ${result.txHash}`
            )
          ) : (
            'mock mode: nothing was sent'
          )}
        </p>
      </div>
    </div>
  );
}
