'use client';
import { useMemo } from 'react';
import { BLOCK_MS, STEPS, TRACK_META, fadeOf, type HitEvent, type Pattern, type TrackId } from '@blockbeat/shared';
import { cx } from '@/components/cx';
import { useNow } from '@/components/useNow';
import { useReducedMotion } from '@/components/useReducedMotion';
import { decayConfig, estimateBlock, liveView } from '@/lib/decay';
import type { AimClock, AimItem } from '@/lib/join/aimQueue';
import { padIndexOf, padsFor } from '@/lib/join/pads';
import { useClockHead } from '@/lib/join/usePhone';
import type { EventFeedState } from '@/lib/types';

const STEP_INDEXES = Array.from({ length: STEPS }, (_, i) => i);
/** W13: note lifetime and voice cap, the same knobs the stage reads. */
const DECAY = decayConfig();
const MAX_DOTS = 3;

/** A note's name on the phone: its pad label on that track, or the track name for a variant no pad plays. */
export function noteLabel(track: TrackId, note: number): string {
  const i = padIndexOf(track, note);
  return i === null ? (TRACK_META[track]?.label ?? 'note') : (padsFor(track)[i]?.label ?? 'note');
}

interface OwnCell {
  fade: number;
  colour: string;
  label: string;
}

interface StepGridProps {
  clock: AimClock | null;
  startBlock: bigint | null;
  hits: readonly HitEvent[];
  pattern: Pattern;
  headHint: EventFeedState['headHint'];
  player: `0x${string}` | null;
  /** The instrument on screen: its live notes are drawn as dots. */
  track: TrackId | null;
  queued: readonly AimItem[];
  armed: ReadonlySet<number>;
  landed: number | null;
  /** Your earlier landings (decay off: the grid remembers them). */
  history: ReadonlySet<number>;
  landSeq: number;
  accent: string;
  /** Aim mode with a funded wallet: steps are buttons that aim. */
  aiming: boolean;
  onStep(step: number): void;
}

/**
 * W16: the 16 steps of the loop as two rows of eight 44 px buttons. It shows the block-clock
 * playhead, the live layer (dots for the selected instrument's notes, a fill where your own
 * notes still play), your queued and armed steps, and where your last note landed. Only this
 * component re-renders once a block.
 */
export function StepGrid({ clock, startBlock, hits, pattern, headHint, player, track, queued, armed, landed, history, landSeq, accent, aiming, onStep }: StepGridProps) {
  const reducedMotion = useReducedMotion();
  const { head: clockHead, step: playhead } = useClockHead(clock, startBlock);
  // Before the clock has a head, estimate it from the feed (W13) so the live notes still fade.
  const now = useNow(clockHead === null && hits.length > 0, BLOCK_MS);
  const head = clockHead ?? estimateBlock(headHint, now);
  const decay = DECAY.lifetimeBars > 0;

  const { own, dots } = useMemo(() => {
    const ownMap = new Map<number, OwnCell>();
    const dotMap = new Map<number, { own: number; others: number }>();
    if (head === null) return { own: ownMap, dots: dotMap };
    const me = player?.toLowerCase() ?? null;
    for (const cell of liveView(hits, pattern, head, DECAY).cells) {
      const mine = me !== null && cell.player.toLowerCase() === me;
      if (cell.track === track) {
        const d = dotMap.get(cell.step) ?? { own: 0, others: 0 };
        if (mine) d.own += 1;
        else d.others += 1;
        dotMap.set(cell.step, d);
      }
      if (!mine || !decay) continue;
      const fade = fadeOf(cell.remainingBlocks, DECAY.lifetimeBars, { reducedMotion });
      const prev = ownMap.get(cell.step);
      if (!prev || fade > prev.fade) ownMap.set(cell.step, { fade, colour: TRACK_META[cell.track]?.colour ?? accent, label: noteLabel(cell.track, cell.note) });
    }
    return { own: ownMap, dots: dotMap };
  }, [head, hits, pattern, player, track, decay, reducedMotion, accent]);

  const queuedBySteps = useMemo(() => {
    const m = new Map<number, AimItem[]>();
    for (const q of queued) m.set(q.step, [...(m.get(q.step) ?? []), q]);
    return m;
  }, [queued]);

  return (
    <ol
      data-testid="step-strip"
      data-tour="steps"
      aria-label={decay ? 'The 16-step loop: aim a note, and see your notes still playing' : 'The 16-step loop: aim a note, and see where your notes landed'}
      className="grid gap-[2px] px-3"
      style={{ gridTemplateColumns: `repeat(${STEPS / 2}, minmax(0, 1fr))` }}
    >
      {STEP_INDEXES.map((step) => {
        const mine = decay ? own.get(step) : history.has(step) ? { fade: 1, colour: accent, label: 'note' } : undefined;
        const isLanded = landed === step && (!decay || mine !== undefined);
        const isPlayhead = playhead === step;
        const q = queuedBySteps.get(step) ?? [];
        const isArmed = armed.has(step);
        const d = dots.get(step) ?? { own: 0, others: 0 };
        const label = [
          `Step ${step}`,
          isPlayhead ? 'playing now' : null,
          mine ? (decay ? `your ${mine.label}, still playing` : 'one of your notes') : null,
          d.others > 0 ? `${d.others} other ${d.others === 1 ? 'note' : 'notes'}` : null,
          ...q.map((item) => `aimed ${noteLabel(item.track, item.note)}${item.status === 'sending' ? ', sending' : ''}`),
          isArmed ? 'armed' : null,
          isLanded ? 'your last note' : null,
        ]
          .filter(Boolean)
          .join(', ');
        const fill = mine ? `color-mix(in srgb, ${mine.colour} ${Math.round(18 + 42 * mine.fade)}%, var(--surface-2))` : step % 4 === 0 ? 'var(--surface-3)' : 'var(--surface-2)';
        const ring = q.length > 0 ? `inset 0 0 0 2px ${accent}` : isArmed ? 'inset 0 0 0 2px var(--ink)' : 'inset 0 0 0 1px var(--line)';
        // The playhead is the stage's column of light, in miniature: a white edge on top and a lift.
        const lit = isPlayhead ? `inset 0 3px 0 var(--playhead-edge), inset 0 0 0 999px var(--playhead-glow), ${ring}` : ring;
        return (
          <li key={step} className="flex">
            <button
              type="button"
              data-step={step}
              data-playhead={isPlayhead ? 'true' : undefined}
              data-live={decay && mine ? 'true' : undefined}
              data-landed={isLanded ? 'true' : undefined}
              data-queued={q.length > 0 ? 'true' : undefined}
              data-armed={isArmed ? 'true' : undefined}
              aria-label={label}
              aria-pressed={aiming ? isArmed || q.length > 0 : undefined}
              disabled={!aiming}
              onClick={() => onStep(step)}
              className={cx(
                'step-cell num relative flex min-h-[44px] w-full select-none flex-col items-start justify-between overflow-hidden rounded-[8px] px-[5px] py-[4px] disabled:cursor-default',
              )}
              style={{
                background: fill,
                boxShadow: isLanded ? `${lit}, 0 0 14px ${mine?.colour ?? accent}` : lit,
                outline: q.length > 0 ? `2px dashed ${accent}` : undefined,
                outlineOffset: q.length > 0 ? '-5px' : undefined,
                color: mine && mine.fade > 0.6 ? 'var(--ink)' : 'var(--ink-muted)',
                fontSize: 11,
                lineHeight: 1,
              }}
            >
              {/* The landing pulse replays on a keyed overlay; the button keeps its identity and focus. */}
              {isLanded && (
                <span
                  key={landSeq}
                  aria-hidden="true"
                  data-pulse="true"
                  className="strip-landed pointer-events-none absolute inset-0 rounded-[inherit]"
                  style={{ background: `color-mix(in srgb, ${mine?.colour ?? accent} 45%, transparent)`, transformOrigin: 'center' }}
                />
              )}
              <span aria-hidden="true" style={{ fontWeight: step % 4 === 0 ? 700 : 500 }}>
                {step}
              </span>
              <span aria-hidden="true" className="flex gap-[3px]">
                {Array.from({ length: Math.min(MAX_DOTS, d.own + d.others) }, (_, i) => (
                  <span
                    key={i}
                    className="block h-[6px] w-[6px] rounded-full"
                    style={{ background: i < d.own ? accent : `color-mix(in srgb, ${accent} 45%, transparent)`, boxShadow: i < d.own ? '0 0 0 1px var(--ink)' : undefined }}
                  />
                ))}
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}
