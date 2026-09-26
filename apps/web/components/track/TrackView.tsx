import Link from 'next/link';
import { formatInt, shortAddress } from '@/components/format';
import type { TipLine } from '@/lib/tips/tipList';
import type { TrackView as TrackData } from '@/lib/track/read';
import type { TrackTipTotals } from '@/lib/track/tips';
import { encodePatternProp } from '@/lib/track/pattern';
import { ShareButton } from './ShareButton';
import { TrackPlayer } from './TrackPlayer';
import { TrackTips } from './TrackTips';

interface TrackViewProps {
  track: TrackData;
  /** Explorer page for the token, or null on chains without one (anvil). */
  explorerUrl: string | null;
  /** W21b: the session's tip views (null on a contract without the split) and its tips, newest first. */
  tips?: { totals: TrackTipTotals | null; lines: readonly TipLine[] };
}

const muted = { fontSize: 'var(--text-md)', color: 'var(--ink-muted)' } as const;
const label = { fontSize: 'var(--text-sm)', color: 'var(--ink-muted)', fontWeight: 500 } as const;

/** One finalized track: the onchain SVG framed as a record sleeve you can play (W15), its attributes and who played it. Server component; the player is a client island. */
export function TrackView({ track, explorerUrl, tips }: TrackViewProps) {
  const { metadata } = track;
  const contributors = track.contributors.length;
  return (
    <main className="mx-auto flex w-full max-w-[1100px] flex-1 flex-col gap-10 px-4 py-10 sm:px-8 lg:py-14">
      <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] lg:gap-14">
        {/* The sleeve: cover art from the contract, the disc behind it; W15: press Play to hear it. */}
        <TrackPlayer id={track.tokenId.toString()} name={metadata.name} imageDataUri={metadata.imageDataUri} pattern={encodePatternProp(track.pattern)}>
          <div className="flex items-end justify-between gap-4">
            <div className="flex min-w-0 flex-col gap-1">
              <span style={label}>Blockbeat</span>
              <span className="num" style={{ fontSize: 'clamp(18px, 3vw, 34px)', fontWeight: 800, letterSpacing: '-0.03em', lineHeight: 1.05, textWrap: 'balance' }}>
                {metadata.name}
              </span>
            </div>
            <span className="num shrink-0 text-right" style={{ ...label, lineHeight: 1.3 }}>
              {formatInt(contributors)} {contributors === 1 ? 'co-author' : 'co-authors'}
              <br />
              session {track.sessionId.toString()}
            </span>
          </div>
        </TrackPlayer>

        <div className="flex flex-col gap-8">
          <header className="flex flex-col gap-3">
            <h1 data-testid="track-title" className="num" style={{ fontSize: 'clamp(40px, 5vw, var(--text-title))', fontWeight: 800, letterSpacing: '-0.035em', lineHeight: 1 }}>
              {metadata.name}
            </h1>
            <p style={{ ...muted, maxWidth: '48ch', textWrap: 'pretty' }}>{metadata.description}</p>
            {/* W13: the live grid fades; the NFT keeps every note the room played. */}
            <p data-testid="recorded-note" style={{ fontSize: 'var(--text-sm)', color: 'var(--ink-muted)' }}>
              Recorded pattern: every note the room played
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-3">
              <ShareButton title={metadata.name} />
              {explorerUrl ? (
                <a
                  href={explorerUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="rounded-full px-6 py-3 font-semibold"
                  style={{ background: 'var(--surface-2)', border: '1px solid var(--line-strong)', fontSize: 'var(--text-md)' }}
                >
                  View on Monadscan
                </a>
              ) : (
                <p style={{ fontSize: 'var(--text-sm)', color: 'var(--ink-muted)' }}>Local anvil chain, no explorer.</p>
              )}
            </div>
          </header>

          <section aria-label="Attributes" className="flex flex-col gap-3">
            <h2 style={{ fontSize: 'var(--text-lg)', fontWeight: 700, letterSpacing: '-0.01em' }}>Onchain</h2>
            <dl className="grid grid-cols-[auto_1fr] gap-x-8 gap-y-2" style={{ fontSize: 'var(--text-md)' }}>
              {metadata.attributes.map((a, i) => (
                <div key={`${i}-${a.traitType}`} className="contents">
                  <dt style={{ color: 'var(--ink-muted)' }}>{a.traitType}</dt>
                  <dd className="num" data-testid={`attr-${a.traitType}`}>{typeof a.value === 'number' ? formatInt(a.value) : a.value}</dd>
                </div>
              ))}
              <dt style={{ color: 'var(--ink-muted)' }}>token</dt>
              <dd className="num">#{track.tokenId.toString()}</dd>
              <dt style={{ color: 'var(--ink-muted)' }}>host</dt>
              <dd className="num" title={track.host} style={{ fontFamily: 'var(--font-mono)' }}>{shortAddress(track.host)}</dd>
            </dl>
          </section>

          {/* W21b: raised, the host's 20 %, the players' 80 % by notes (the DJ takes none) and every tip. */}
          <TrackTips
            hostWei={tips?.totals?.hostWei ?? null}
            hostClaimableWei={tips?.totals?.hostClaimableWei ?? null}
            poolWei={track.tipPool}
            contributors={track.contributors}
            agent={tips?.totals?.agent ?? null}
            lines={tips?.lines ?? []}
          />
        </div>
      </div>

      <nav className="flex flex-wrap gap-4" aria-label="Track links">
        <Link href={`/stage/${track.sessionId.toString()}`} className="rounded-full px-6 py-3 font-semibold" style={{ background: 'var(--surface-2)', border: '1px solid var(--line-strong)', fontSize: 'var(--text-md)' }}>
          Session {track.sessionId.toString()} stage
        </Link>
        <Link href="/tracks" className="rounded-full px-6 py-3 font-semibold" style={{ background: 'var(--surface-2)', border: '1px solid var(--line-strong)', fontSize: 'var(--text-md)' }}>
          All tracks
        </Link>
        <Link href="/" className="rounded-full px-6 py-3 font-semibold" style={{ color: 'var(--ink-muted)', fontSize: 'var(--text-md)' }}>
          Back to Blockbeat
        </Link>
      </nav>
    </main>
  );
}
