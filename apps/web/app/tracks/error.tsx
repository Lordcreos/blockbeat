'use client';
import Link from 'next/link';
import { useEffect } from 'react';

/** The gallery reads the chain (memoised 60 s); a busy RPC must not end in Next's generic error page. */
export default function TracksError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error('tracks page failed', error);
  }, [error]);
  return (
    <main className="mx-auto flex w-full max-w-[640px] flex-1 flex-col justify-center gap-6 px-5 py-16">
      <h1 style={{ fontSize: 'var(--text-title)', fontWeight: 800, letterSpacing: '-0.035em', lineHeight: 1 }}>The chain is busy</h1>
      <p style={{ fontSize: 'var(--text-md)', color: 'var(--ink-muted)', textWrap: 'pretty' }}>
        Reading the tracks from Monad did not finish. They are still there; try again in a moment.
      </p>
      <div className="flex flex-wrap gap-4">
        <button type="button" onClick={reset} className="rounded-full px-6 py-3 font-semibold" style={{ background: 'var(--ink)', color: 'var(--ink-on-track)', fontSize: 'var(--text-md)' }}>
          Try again
        </button>
        <Link href="/" className="rounded-full px-6 py-3 font-semibold" style={{ color: 'var(--ink-muted)', fontSize: 'var(--text-md)' }}>
          Back to Blockbeat
        </Link>
      </div>
    </main>
  );
}
