'use client';
import Link from 'next/link';
import { useMemo } from 'react';
import { formatEther } from 'viem';
import { decodePatternProp } from '@/lib/track/pattern';
import type { AudioEngine } from '@/lib/types';
import { formatInt } from '@/components/format';
import { useReducedMotion } from '@/components/useReducedMotion';
import { CoverArt } from './CoverArt';
import { TransportIcon } from './TrackPlayer';
import { useTrackPlayer, type TrackPlayer } from './useTrackPlayer';

/** One minted track as plain JSON (bigints as decimal strings, the pattern as hex words). */
export interface GalleryItem {
  tokenId: string;
  sessionId: string;
  name: string;
  imageDataUri: string;
  contributors: number;
  hits: string;
  tipPoolWei: string;
  pattern: string[];
}

interface TrackGalleryProps {
  items: GalleryItem[];
  createEngine?: () => AudioEngine;
}

const stat = { fontSize: 'var(--text-sm)', color: 'var(--ink-muted)' } as const;

function GalleryRow({ item, player, reducedMotion }: { item: GalleryItem; player: TrackPlayer; reducedMotion: boolean }) {
  const pattern = useMemo(() => decodePatternProp(item.pattern), [item.pattern]);
  const playing = player.playingId === item.tokenId;
  const starting = player.startingId === item.tokenId;
  const title = `Track #${item.tokenId}`;
  return (
    <li
      data-testid="gallery-track"
      data-token={item.tokenId}
      className="grid items-center gap-x-8 gap-y-4 py-6 sm:grid-cols-[minmax(0,240px)_minmax(0,1fr)_auto]"
      style={{ borderTop: '1px solid var(--line)' }}
    >
      <CoverArt imageDataUri={item.imageDataUri} pattern={pattern} alt={`${item.name}: 16 steps by 8 tracks`} step={playing ? player.step : null} reducedMotion={reducedMotion} imageTestId={`gallery-image-${item.tokenId}`} />
      <div className="flex min-w-0 flex-col gap-2">
        <h2 className="num" style={{ fontSize: 'var(--text-hud)', fontWeight: 800, letterSpacing: '-0.03em', lineHeight: 1 }}>
          <Link href={`/track/${item.tokenId}`} className="hover:underline">
            {title}
          </Link>
        </h2>
        <p className="num" style={stat}>Session {item.sessionId}</p>
        <dl className="num mt-1 flex flex-wrap gap-x-8 gap-y-1" style={{ fontSize: 'var(--text-md)' }}>
          <div className="flex items-baseline gap-2">
            <dt style={stat}>Contributors</dt>
            <dd data-testid="gallery-contributors">{formatInt(item.contributors)}</dd>
          </div>
          <div className="flex items-baseline gap-2">
            <dt style={stat}>Hits</dt>
            <dd data-testid="gallery-hits">{formatInt(BigInt(item.hits))}</dd>
          </div>
          <div className="flex items-baseline gap-2">
            <dt style={stat}>Tip pool</dt>
            <dd data-testid="gallery-tips">{formatEther(BigInt(item.tipPoolWei))} MON</dd>
          </div>
        </dl>
      </div>
      <button
        type="button"
        aria-pressed={playing}
        aria-label={`${starting ? 'Starting' : playing ? 'Stop' : 'Play'} track #${item.tokenId}`}
        onClick={() => {
          // aria-disabled, not disabled: a disabled button drops the keyboard focus it just got.
          if (!player.starting) void player.toggle(item.tokenId, pattern);
        }}
        aria-disabled={player.starting}
        className="inline-flex min-w-[11ch] items-center justify-center gap-2 justify-self-start rounded-full px-6 py-3 font-semibold aria-disabled:opacity-70 sm:justify-self-end"
        style={{ background: playing ? 'var(--surface-2)' : 'var(--ink)', color: playing ? 'var(--ink)' : 'var(--ink-on-track)', border: '1px solid var(--line-strong)', fontSize: 'var(--text-md)' }}
      >
        <TransportIcon playing={playing} />
        {starting ? 'Starting…' : playing ? 'Stop' : 'Play'}
      </button>
    </li>
  );
}

/** W15: every minted track as a tracklist; one engine for the page, so one track plays at a time. */
export function TrackGallery({ items, createEngine }: TrackGalleryProps) {
  const player = useTrackPlayer(createEngine ? { createEngine } : {});
  const reducedMotion = useReducedMotion();

  if (items.length === 0) {
    return (
      <section data-testid="gallery-empty" className="flex flex-col items-start gap-4 py-10" style={{ borderTop: '1px solid var(--line)' }}>
        <h2 style={{ fontSize: 'var(--text-hud)', fontWeight: 700, letterSpacing: '-0.02em' }}>No tracks minted yet</h2>
        <p style={{ fontSize: 'var(--text-md)', color: 'var(--ink-muted)', maxWidth: '52ch', textWrap: 'pretty' }}>
          A track appears here when the host ends a session with End session and mint on the stage.
        </p>
        <Link href="/host" className="rounded-full px-6 py-3 font-semibold" style={{ background: 'var(--ink)', color: 'var(--ink-on-track)', fontSize: 'var(--text-md)' }}>
          Host a session
        </Link>
      </section>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <p style={{ fontSize: 'var(--text-sm)', color: 'var(--ink-muted)', maxWidth: '60ch' }}>
          Each loop is rebuilt from chain state and played at 100 BPM. One plays at a time.
        </p>
        <label className="flex items-center gap-3" style={{ fontSize: 'var(--text-sm)', color: 'var(--ink-muted)' }}>
          Volume
          <input type="range" min={0} max={1} step={0.01} value={player.volume} onChange={(e) => player.setVolume(Number(e.currentTarget.value))} className="w-36 accent-[var(--ink)]" />
        </label>
      </div>
      {player.error && (
        <p role="alert" style={{ fontSize: 'var(--text-sm)', color: 'var(--danger)' }}>
          Audio did not start: {player.error}. Press Play again.
        </p>
      )}
      <ol className="flex flex-col" style={{ borderBottom: '1px solid var(--line)' }}>
        {items.map((item) => (
          <GalleryRow key={item.tokenId} item={item} player={player} reducedMotion={reducedMotion} />
        ))}
      </ol>
    </div>
  );
}
