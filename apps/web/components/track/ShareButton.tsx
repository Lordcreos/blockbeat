'use client';
import { useState, useSyncExternalStore } from 'react';

interface ShareButtonProps {
  /** Absolute URL to share; defaults to the page the button is on. */
  url?: string;
  title: string;
}

type Outcome = 'idle' | 'copied' | 'shared' | 'unavailable';

const noSubscribe = () => () => {};
const readCanShare = () => typeof navigator !== 'undefined' && typeof navigator.share === 'function';

const OUTCOME_TEXT: Record<Outcome, string> = {
  idle: '',
  copied: 'Link copied',
  shared: 'Shared',
  unavailable: 'Copy the address bar to share this track',
};

/** Native share sheet where there is one (phones), clipboard elsewhere. */
export function ShareButton({ url, title }: ShareButtonProps) {
  const [outcome, setOutcome] = useState<Outcome>('idle');
  // The server cannot know about navigator.share: the server snapshot is false, so the
  // hydrated HTML matches and the real capability shows right after hydration.
  const canShare = useSyncExternalStore(noSubscribe, readCanShare, () => false);

  const share = async () => {
    const target = url ?? window.location.href;
    const nav = navigator;
    try {
      if (typeof nav.share === 'function') {
        await nav.share({ title, url: target });
        setOutcome('shared');
      } else if (nav.clipboard?.writeText) {
        await nav.clipboard.writeText(target);
        setOutcome('copied');
      } else {
        setOutcome('unavailable');
      }
    } catch (err) {
      // A dismissed share sheet rejects with AbortError: not a failure worth reporting.
      if (err instanceof Error && err.name === 'AbortError') return;
      setOutcome('unavailable');
    }
  };

  return (
    <span className="flex flex-wrap items-center gap-3">
      <button
        type="button"
        onClick={() => void share()}
        className="rounded-full px-6 py-3 font-semibold"
        style={{ background: 'var(--ink)', color: 'var(--ink-on-track)', fontSize: 'var(--text-md)' }}
      >
        {canShare ? 'Share' : 'Copy link'}
      </button>
      <span role="status" aria-live="polite" style={{ fontSize: 'var(--text-sm)', color: 'var(--ink-muted)' }}>
        {OUTCOME_TEXT[outcome]}
      </span>
    </span>
  );
}
