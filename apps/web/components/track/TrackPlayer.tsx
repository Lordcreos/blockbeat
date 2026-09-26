'use client';
import { useMemo, type ReactNode } from 'react';
import { decodePatternProp } from '@/lib/track/pattern';
import type { AudioEngine } from '@/lib/types';
import { cx } from '@/components/cx';
import { useReducedMotion } from '@/components/useReducedMotion';
import { CoverArt } from './CoverArt';
import { useTrackPlayer } from './useTrackPlayer';

/** Drawn play / stop marks, one stroke weight, sized by the text around them. */
export function TransportIcon({ playing }: { playing: boolean }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" width="1em" height="1em" fill="currentColor">
      {playing ? <rect x="4" y="4" width="12" height="12" rx="2" /> : <path d="M6 3.8v12.4a1 1 0 0 0 1.5.86l10-6.2a1 1 0 0 0 0-1.72l-10-6.2A1 1 0 0 0 6 3.8Z" />}
    </svg>
  );
}

interface TrackPlayerProps {
  id: string;
  name: string;
  imageDataUri: string | null;
  /** 16 step words as hex strings (see encodePatternProp). */
  pattern: readonly string[];
  /** Rendered on the sleeve under the cover (title, co-authors). */
  children?: ReactNode;
  createEngine?: () => AudioEngine;
}

/**
 * W15: the minted track as a record you can play. The sleeve holds the onchain cover; Play
 * loops the recorded pattern at 100 BPM through the stage's audio engine, a playhead sweeps
 * the cover and the disc behind the sleeve turns. Audio starts on the click, never before.
 */
export function TrackPlayer({ id, name, imageDataUri, pattern: patternProp, children, createEngine }: TrackPlayerProps) {
  const pattern = useMemo(() => decodePatternProp(patternProp), [patternProp]);
  const player = useTrackPlayer(createEngine ? { createEngine } : {});
  const reducedMotion = useReducedMotion();
  const playing = player.playingId === id;

  return (
    <div className="flex flex-col gap-6">
      <section aria-label="Pattern" className="relative">
        <div aria-hidden="true" className={cx('vinyl absolute right-[-9%] top-[6%] aspect-square w-[88%] rounded-full lg:right-[-11%]', playing && 'vinyl-spin')} />
        <div className="sleeve relative aspect-square w-[92%] rounded-[6px] p-[6%]">
          <div className="flex h-full flex-col justify-between">
            <CoverArt imageDataUri={imageDataUri} pattern={pattern} alt={`${name}: 16 steps by 8 tracks`} step={playing ? player.step : null} reducedMotion={reducedMotion} />
            {children}
          </div>
        </div>
      </section>

      <div className="flex w-[92%] flex-col gap-3">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <button
            type="button"
            data-testid="track-play"
            aria-pressed={playing}
            onClick={() => {
              // aria-disabled, not disabled: a disabled button drops the keyboard focus it just got.
              if (!player.starting) void player.toggle(id, pattern);
            }}
            aria-disabled={player.starting}
            className="transport-button inline-flex min-w-[15ch] items-center justify-center gap-3 rounded-full px-8 py-4 font-semibold aria-disabled:opacity-70"
            style={{ background: playing ? 'var(--surface-2)' : 'var(--ink)', color: playing ? 'var(--ink)' : 'var(--ink-on-track)', border: '1px solid var(--line-strong)', fontSize: 'var(--text-lg)' }}
          >
            <TransportIcon playing={playing} />
            {player.starting ? 'Starting…' : playing ? 'Stop' : 'Play the track'}
          </button>
          <label className="flex items-center gap-3" style={{ fontSize: 'var(--text-sm)', color: 'var(--ink-muted)' }}>
            Volume
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={player.volume}
              onChange={(e) => player.setVolume(Number(e.currentTarget.value))}
              className="w-36 accent-[var(--ink)]"
            />
          </label>
        </div>
        <p style={{ fontSize: 'var(--text-sm)', color: 'var(--ink-muted)', maxWidth: '52ch', textWrap: 'pretty' }}>
          Playback is rebuilt from chain state: the 16 step words stored with the token, looped at 100 BPM, one step every 300 ms like a Monad block.
        </p>
        {player.error && (
          <p role="alert" style={{ fontSize: 'var(--text-sm)', color: 'var(--danger)' }}>
            Audio did not start: {player.error}. Press Play again.
          </p>
        )}
      </div>
    </div>
  );
}
