import type { Metadata } from 'next';
import Link from 'next/link';
import { TrackGallery, type GalleryItem } from '@/components/track/TrackGallery';
import { createHttpClient, getRpcUrls, isMockMode, runtimeAddress } from '@/lib/chain/clients';
import { listTracks, type TrackSummary } from '@/lib/track/list';
import { encodePatternProp } from '@/lib/track/pattern';

/** A track can be minted between two views; the list itself is memoised for 60 s (lib/track/list). */
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Tracks · Blockbeat',
  description: 'Every loop a room composed live on Monad and minted onchain. Press play to hear it again.',
};

function toItem(t: TrackSummary): GalleryItem {
  return {
    tokenId: t.tokenId.toString(),
    sessionId: t.sessionId.toString(),
    name: t.name,
    imageDataUri: t.imageDataUri,
    contributors: t.contributors,
    hits: t.hitCount.toString(),
    tipPoolWei: t.tipPool.toString(),
    pattern: encodePatternProp(t.pattern),
  };
}

export default async function TracksPage() {
  const mock = isMockMode();
  const items = mock ? [] : (await listTracks({ client: createHttpClient(process.env.MONAD_RPC_URL?.trim() || getRpcUrls().http), address: runtimeAddress() })).map(toItem);
  return (
    <main className="mx-auto flex w-full max-w-[1100px] flex-1 flex-col gap-8 px-4 py-10 sm:px-8 lg:py-14">
      <header className="flex flex-col gap-3">
        <h1 style={{ fontSize: 'clamp(40px, 5vw, var(--text-title))', fontWeight: 800, letterSpacing: '-0.035em', lineHeight: 1 }}>Tracks</h1>
        <p style={{ fontSize: 'var(--text-md)', color: 'var(--ink-muted)', maxWidth: '56ch', textWrap: 'pretty' }}>
          Every loop a room played on Monad and minted, newest first. Every note in them was a transaction.
        </p>
        {mock && (
          <p data-testid="gallery-mock" style={{ fontSize: 'var(--text-sm)', color: 'var(--ink-muted)' }}>
            This deployment runs on the built-in simulator, so nothing is minted on chain.
          </p>
        )}
      </header>
      <TrackGallery items={items} />
      <nav className="flex flex-wrap gap-4" aria-label="Gallery links">
        <Link href="/host" className="rounded-full px-6 py-3 font-semibold" style={{ background: 'var(--surface-2)', border: '1px solid var(--line-strong)', fontSize: 'var(--text-md)' }}>
          Host a session
        </Link>
        <Link href="/" className="rounded-full px-6 py-3 font-semibold" style={{ color: 'var(--ink-muted)', fontSize: 'var(--text-md)' }}>
          Back to Blockbeat
        </Link>
      </nav>
    </main>
  );
}
