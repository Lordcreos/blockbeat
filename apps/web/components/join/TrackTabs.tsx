'use client';
import { useRef, type KeyboardEvent } from 'react';
import { TRACK_META, TRACKS, type TrackId } from '@blockbeat/shared';
import { cx } from '@/components/cx';

interface TrackTabsProps {
  selected: TrackId;
  onSelect(track: TrackId): void;
  /** id of the panel the tabs control (the pads). */
  panelId: string;
  disabled?: boolean;
}

export const trackTabId = (track: TrackId): string => `track-tab-${track}`;

/**
 * W16: the eight instruments as one row of tabs. The drip picks the starting one; the player
 * can switch freely. Each tab carries its track colour (the text when idle, the fill when chosen).
 * Arrow keys, Home and End move between tabs (WAI-ARIA tabs, automatic activation).
 */
export function TrackTabs({ selected, onSelect, panelId, disabled = false }: TrackTabsProps) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  const onKey = (event: KeyboardEvent<HTMLButtonElement>, track: TrackId): void => {
    const moves: Record<string, number> = { ArrowRight: track + 1, ArrowLeft: track - 1, Home: 0, End: TRACKS - 1 };
    const target = moves[event.key];
    if (target === undefined) return;
    event.preventDefault();
    const next = TRACK_META[(target + TRACKS) % TRACKS];
    if (!next) return;
    onSelect(next.id);
    refs.current[next.id]?.focus();
  };

  return (
    <div role="tablist" aria-label="Instrument" className="grid gap-[2px] px-3" style={{ gridTemplateColumns: `repeat(${TRACKS}, minmax(0, 1fr))` }}>
      {TRACK_META.map((meta) => {
        const on = meta.id === selected;
        return (
          <button
            key={meta.id}
            ref={(el) => {
              refs.current[meta.id] = el;
            }}
            id={trackTabId(meta.id)}
            type="button"
            role="tab"
            aria-selected={on}
            aria-controls={panelId}
            tabIndex={on ? 0 : -1}
            disabled={disabled}
            onClick={() => onSelect(meta.id)}
            onKeyDown={(e) => onKey(e, meta.id)}
            className={cx('track-tab min-h-[44px] select-none rounded-[8px] font-semibold disabled:opacity-50', on && 'track-tab-on')}
            style={{
              fontSize: 'var(--text-xs)',
              letterSpacing: '-0.01em',
              background: on ? meta.colour : 'var(--surface-1)',
              color: on ? 'var(--ink-on-track)' : meta.colour,
              boxShadow: on ? `0 4px 16px -6px ${meta.colour}` : 'inset 0 0 0 1px var(--line)',
            }}
          >
            {meta.label}
          </button>
        );
      })}
    </div>
  );
}
