'use client';
import type { TrackMeta } from '@blockbeat/shared';
import { cx } from '@/components/cx';
import type { PadSpec } from '@/lib/join/pads';

interface PadGridProps {
  id: string;
  track: TrackMeta | undefined;
  pads: readonly PadSpec[];
  /** Aim mode: the pad picked for the next step tap (aria-pressed). Null in Tap now. */
  selected: number | null;
  aiming: boolean;
  enabled: boolean;
  warming: boolean;
  finalized: boolean;
  compact: boolean;
  flash: { index: number; seq: number } | null;
  labelledBy: string | undefined;
  onPad(index: number): void;
}

const longestWord = (label: string): number => Math.max(...label.split(' ').map((w) => w.length));

/**
 * W16: eight labelled pads, four across like a keyboard. Each pad is a little lighter than the
 * one before it (the melodic tracks climb in pitch from left to right, top row first), so a
 * player sees at a glance that different places make different sounds.
 */
export function PadGrid({ id, track, pads, selected, aiming, enabled, warming, finalized, compact, flash, labelledBy, onPad }: PadGridProps) {
  const accent = track?.colour ?? 'var(--surface-3)';
  return (
    <section
      id={id}
      data-testid="pads"
      data-tour="pads"
      role={labelledBy ? 'tabpanel' : undefined}
      aria-labelledby={labelledBy}
      aria-label={labelledBy ? undefined : 'Pads, warming up'}
      aria-busy={warming}
      className="grid min-h-0 flex-1 grid-cols-4 gap-2 px-3"
      style={{ gridTemplateRows: 'repeat(2, minmax(0, 1fr))', touchAction: 'manipulation' }}
    >
      {pads.map((pad, index) => {
        const isSelected = aiming && selected === index;
        const lift = index * 4;
        return (
          <button
            key={`pad-${index}`}
            type="button"
            aria-label={`Pad ${index + 1}, ${pad.label}`}
            aria-pressed={aiming ? isSelected : undefined}
            disabled={!enabled}
            onClick={() => onPad(index)}
            data-selected={isSelected ? 'true' : undefined}
            className={cx(
              'pad relative flex min-h-[44px] select-none flex-col justify-between overflow-hidden rounded-[var(--radius-pad)] p-3 text-left disabled:cursor-progress',
              warming && 'pad-warming',
            )}
            style={{
              ['--pad-colour' as string]: accent,
              background: enabled
                ? `color-mix(in srgb, ${accent}, white ${lift}%)`
                : finalized
                  ? `color-mix(in srgb, ${accent} 18%, var(--surface-2))`
                  : 'var(--surface-2)',
              color: enabled ? 'var(--ink-on-track)' : 'var(--ink-faint)',
              boxShadow: isSelected
                ? `inset 0 0 0 3px var(--ink-on-track), inset 0 0 0 6px var(--ink), 0 6px 24px -6px ${accent}`
                : enabled
                  ? 'inset 0 -6px 0 rgba(0,0,0,0.18)'
                  : 'inset 0 0 0 1px var(--line)',
            }}
          >
            {/* The flash replays on a keyed overlay, so the button itself never remounts and keeps focus. */}
            {flash?.index === index && <span key={flash.seq} aria-hidden="true" data-flash="true" className="pad-flash pointer-events-none absolute inset-0 rounded-[inherit]" />}
            <span aria-hidden="true" className="num" style={{ fontSize: 'var(--text-xs)', fontWeight: 600, opacity: 0.7 }}>
              {index + 1}
            </span>
            <span
              aria-hidden="true"
              style={{
                // Longest single word decides the size, so a label wraps only at its spaces ("Hall bright").
                fontSize: compact ? 'var(--text-sm)' : longestWord(pad.label) > 4 ? 'var(--text-md)' : 'var(--text-lg)',
                fontWeight: 800,
                letterSpacing: '-0.02em',
                lineHeight: 1.05,
                overflowWrap: 'normal',
                wordBreak: 'keep-all',
              }}
            >
              {warming ? '' : pad.label}
            </span>
            {warming && (
              <span aria-hidden="true" style={{ fontSize: 'var(--text-xs)', fontWeight: 500, color: 'var(--ink-muted)' }}>
                warming up
              </span>
            )}
          </button>
        );
      })}
    </section>
  );
}
