import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { MONAD_TESTNET_ID, explorerTokenUrl } from '@blockbeat/shared';
import { DEMO_PATTERN } from '@/components/landing/demo-pattern';
import { MockTrackTips } from '@/components/track/MockTrackTips';
import { TrackPlayer } from '@/components/track/TrackPlayer';
import { TrackView } from '@/components/track/TrackView';
import { createHttpClient, getRpcUrls, isMockMode, runtimeAddress, runtimeChainId } from '@/lib/chain/clients';
import { encodePatternProp, rowsToPattern } from '@/lib/track/pattern';
import { readTrack } from '@/lib/track/read';
import { readTrackTips } from '@/lib/track/tips';
import { getTipNoteStore } from '@/lib/tips/runtime';
import { mergeTips } from '@/lib/tips/tipList';

/** W15: the landing's demo bar, so the player can be heard (and tested) on the simulator. */
const DEMO_LOOP = encodePatternProp(rowsToPattern(DEMO_PATTERN));

/** Every request hits the chain: a token can be minted between two views. */
export const dynamic = 'force-dynamic';

interface Props {
  params: Promise<{ tokenId: string }>;
}

function parseTokenId(raw: string): bigint | null {
  if (!/^\d+$/.test(raw)) return null;
  const id = BigInt(raw);
  return id > 0n ? id : null;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { tokenId } = await params;
  const title = `Blockbeat Track #${tokenId}`;
  const description = 'A 16-step loop composed live by the room on Monad. Every column is a block, every note is a transaction.';
  return { title: `Track #${tokenId} · Blockbeat`, description, openGraph: { title, description, images: ['/og.png'] }, twitter: { card: 'summary_large_image', title, description, images: ['/og.png'] } };
}

function MockModePanel({ tokenId }: { tokenId: bigint }) {
  return (
    <main className="mx-auto flex w-full max-w-[640px] flex-1 flex-col justify-center gap-6 px-4 py-16 sm:px-8">
      <h1 style={{ fontSize: 'var(--text-title)', fontWeight: 800, letterSpacing: '-0.035em', lineHeight: 1 }}>No chain, no track</h1>
      <p style={{ fontSize: 'var(--text-md)', color: 'var(--ink-muted)', textWrap: 'pretty' }}>
        Tracks are minted on chain, and this deployment runs on the built-in simulator. Point it at a contract to read a minted track:
      </p>
      <pre className="rounded-[var(--radius-control)] px-4 py-3" style={{ fontSize: 'var(--text-sm)', background: 'var(--surface-1)', border: '1px solid var(--line)', fontFamily: 'var(--font-mono)' }}>
        NEXT_PUBLIC_BLOCKBEAT_ADDRESS=0x…{'\n'}NEXT_PUBLIC_CHAIN_ID=10143
      </pre>
      <section aria-label="Demo loop" className="flex flex-col gap-4">
        <h2 style={{ fontSize: 'var(--text-lg)', fontWeight: 700 }}>Hear how a track plays back</h2>
        <p style={{ fontSize: 'var(--text-md)', color: 'var(--ink-muted)', textWrap: 'pretty' }}>
          A demo loop, not a minted track. A minted track plays the same way, from the pattern stored with the token.
        </p>
        <TrackPlayer id="demo" name="Demo loop" imageDataUri={null} pattern={DEMO_LOOP} />
      </section>
      {/* W21b: the tip split of the session the stage just minted (it lives in the tab's simulator). */}
      <MockTrackTips tokenId={tokenId} />
      <div className="flex flex-wrap gap-4">
        <Link href="/tracks" className="rounded-full px-6 py-3 font-semibold" style={{ background: 'var(--surface-2)', border: '1px solid var(--line-strong)' }}>
          All tracks
        </Link>
        <Link href="/" className="rounded-full px-6 py-3 font-semibold" style={{ background: 'var(--ink)', color: 'var(--ink-on-track)' }}>
          Back to Blockbeat
        </Link>
      </div>
    </main>
  );
}

export default async function TrackPage({ params }: Props) {
  const { tokenId: raw } = await params;
  const tokenId = parseTokenId(raw);
  if (tokenId === null) notFound();
  if (isMockMode()) return <MockModePanel tokenId={tokenId} />;

  const address = runtimeAddress();
  const client = createHttpClient(process.env.MONAD_RPC_URL?.trim() || getRpcUrls().http);
  const track = await readTrack({ client, address, tokenId });
  if (track === null) notFound();

  const explorerUrl = runtimeChainId() === MONAD_TESTNET_ID ? explorerTokenUrl(address, tokenId) : null;
  // W21b: the W21a tip views and the receipt-checked notes (every app tip posts one).
  const [totals, notes] = await Promise.all([
    readTrackTips({ client, address, sessionId: track.sessionId }),
    getTipNoteStore()
      .list(track.sessionId.toString(), 500)
      .catch((error: unknown) => {
        console.error(`track: tip notes for session ${track.sessionId} unreadable`, error);
        return [];
      }),
  ]);
  return <TrackView track={track} explorerUrl={explorerUrl} tips={{ totals, lines: mergeTips([], notes) }} />;
}
