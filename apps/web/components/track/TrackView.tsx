import Link from 'next/link';
import { formatEther } from 'viem';
import { formatInt, shortAddress } from '@/components/format';
import type { TrackView as TrackData } from '@/lib/track/read';
import { encodePatternProp } from '@/lib/track/pattern';
import { ShareButton } from './ShareButton';
import { TrackPlayer } from './TrackPlayer';

interface TrackViewProps {
  track: TrackData;
  /** Explorer page for the token, or null on chains without one (anvil). */
  explorerUrl: string | null;
}

const muted = { fontSize: 'var(--text-md)', color: 'var(--ink-muted)' } as const;
const label = { fontSize: 'var(--text-sm)', color: 'var(--ink-muted)', fontWeight: 500 } as const;

/** One finalized track: the onchain SVG framed as a record sleeve you can play (W15), its attributes and who played it. Server component; the player is a client island. */
export function TrackView({ track, explorerUrl }: TrackViewProps) {
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
              <dt style={{ color: 'var(--ink-muted)' }}>tip pool</dt>
              <dd className="num" data-testid="tip-pool">{formatEther(track.tipPool)} MON</dd>
            </dl>
          </section>

          <section aria-label="Contributors" className="flex flex-col gap-3">
            <h2 style={{ fontSize: 'var(--text-lg)', fontWeight: 700, letterSpacing: '-0.01em' }}>
              Contributors <span className="num" style={{ color: 'var(--ink-muted)', fontWeight: 500 }}>({formatInt(contributors)})</span>
            </h2>
            {contributors === 0 ? (
              <p style={muted}>Nobody played this session.</p>
            ) : (
              <table data-testid="contributors" className="w-full border-collapse" style={{ fontSize: 'var(--text-md)' }}>
                <thead>
                  <tr style={{ color: 'var(--ink-muted)', textAlign: 'left', fontSize: 'var(--text-sm)' }}>
                    <th className="pb-2 font-medium">Player</th>
                    <th className="pb-2 text-right font-medium">Hits</th>
                    <th className="pb-2 pl-6 text-right font-medium" style={{ width: '38%' }}>Share</th>
                  </tr>
                </thead>
                <tbody>
                  {track.contributors.map((c) => {
                    const pct = Math.round(c.share * 100);
                    return (
                      <tr key={c.address} data-player={c.address} style={{ borderTop: '1px solid var(--line)' }}>
                        <td className="num py-3" title={c.address} style={{ fontFamily: 'var(--font-mono)' }}>{shortAddress(c.address)}</td>
                        <td className="num py-3 text-right">{formatInt(c.hits)}</td>
                        <td className="num py-3 pl-6">
                          <span className="flex items-center gap-3">
                            <span aria-hidden="true" className="h-[6px] flex-1 overflow-hidden rounded-full" style={{ background: 'var(--surface-2)' }}>
                              <span className="block h-full rounded-full" style={{ width: `${Math.max(2, pct)}%`, background: 'var(--ink)' }} />
                            </span>
                            <span className="w-[4ch] text-right">{pct}%</span>
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
            <p style={{ fontSize: 'var(--text-sm)', color: 'var(--ink-muted)' }}>Tips split pro rata by hits. Each player claims their own share.</p>
          </section>
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
