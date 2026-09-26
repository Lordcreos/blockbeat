import Link from 'next/link';
import { HeroGrid } from '@/components/landing/HeroGrid';

export default function Home() {
  return (
    <main className="mx-auto flex w-full max-w-[1240px] flex-1 flex-col justify-center gap-10 px-5 py-12 sm:px-10 lg:py-16">
      <div className="grid items-center gap-10 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.3fr)] lg:gap-16">
        <header className="flex flex-col gap-7">
          <h1 style={{ fontSize: 'clamp(56px, 8vw, 104px)', fontWeight: 800, letterSpacing: '-0.045em', lineHeight: 0.92 }}>
            Blockbeat
          </h1>
          <div data-testid="explainer" className="flex flex-col gap-3" style={{ fontSize: 'clamp(20px, 2.2vw, 28px)', lineHeight: 1.3, maxWidth: '36ch', textWrap: 'pretty' }}>
            <p>A 16-step techno loop. Its clock is the Monad chain.</p>
            <p style={{ color: 'var(--ink-muted)' }}>Every block is a step. Every tap from your phone is a transaction.</p>
            <p style={{ color: 'var(--ink-muted)' }}>The room writes the pattern together, then mints it.</p>
          </div>
          <nav className="flex flex-wrap items-center gap-3" aria-label="Demo">
            <Link
              href="/stage/1"
              className="rounded-full px-7 py-4 font-semibold"
              style={{ background: 'var(--ink)', color: 'var(--ink-on-track)', fontSize: 'var(--text-md)' }}
            >
              Open the demo stage
            </Link>
            <Link
              href="/join/1"
              className="rounded-full px-7 py-4 font-semibold"
              style={{ background: 'var(--surface-2)', border: '1px solid var(--line-strong)', fontSize: 'var(--text-md)' }}
            >
              Join the demo
            </Link>
            <Link href="/host" className="rounded-full px-5 py-4 font-semibold" style={{ color: 'var(--ink-muted)', fontSize: 'var(--text-md)' }}>
              Host a session
            </Link>
            <Link href="/tracks" className="rounded-full px-5 py-4 font-semibold" style={{ color: 'var(--ink-muted)', fontSize: 'var(--text-md)' }}>
              Hear the tracks
            </Link>
          </nav>
        </header>
        <HeroGrid />
      </div>
    </main>
  );
}
