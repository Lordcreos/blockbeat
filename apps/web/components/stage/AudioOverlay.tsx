'use client';
import { useEffect, useRef } from 'react';

interface AudioOverlayProps {
  onStart: () => void;
  /** Set when the last start attempt failed; keeps the overlay up with a retry. */
  error: string | null;
  starting: boolean;
  /** True when audio was running before and the system suspended it. */
  resume?: boolean;
}

/** Browsers only unlock audio after a gesture. One click, then it is gone. */
export function AudioOverlay({ onStart, error, starting, resume = false }: AudioOverlayProps) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="audio-overlay-title"
      className="fixed inset-0 z-20 flex items-center justify-center px-6 backdrop-blur-sm"
      style={{ background: 'rgba(5, 5, 7, 0.82)' }}
      onKeyDown={(e) => {
        // Single focusable control: keep Tab inside the dialog.
        if (e.key === 'Tab') {
          e.preventDefault();
          ref.current?.focus();
        }
      }}
    >
      <div className="flex flex-col items-center gap-8 text-center">
        <h2 id="audio-overlay-title" style={{ fontSize: 'clamp(32px, 4vw, var(--text-title))', fontWeight: 700, letterSpacing: '-0.03em' }}>
          {resume ? 'Audio was paused by the system.' : 'Every column is a Monad block.'}
        </h2>
        <p style={{ fontSize: 'var(--text-lg)', color: 'var(--ink-muted)', maxWidth: '40ch' }}>
          {resume ? 'A speaker change or a sleep did it. Click to resume; the chain kept playing.' : '300 milliseconds each. Click to let the room hear it.'}
        </p>
        <button
          ref={ref}
          type="button"
          onClick={onStart}
          disabled={starting}
          className="rounded-full px-10 py-5 font-semibold disabled:opacity-60"
          style={{ fontSize: 'var(--text-lg)', background: 'var(--ink)', color: 'var(--ink-on-track)' }}
        >
          {starting ? 'Starting…' : error ? 'Try again' : resume ? 'Resume audio' : 'Start the room'}
        </button>
        <p role="status" aria-live="polite" style={{ fontSize: 'var(--text-md)', color: 'var(--danger)', minHeight: '1.5em' }}>
          {error ? `Audio did not start: ${error}` : ''}
        </p>
      </div>
    </div>
  );
}
