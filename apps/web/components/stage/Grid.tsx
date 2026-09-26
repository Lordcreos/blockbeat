'use client';
import { memo } from 'react';
import { STEPS, TRACK_META, TRACKS, type TrackMeta } from '@blockbeat/shared';
import { cx } from '@/components/cx';
import { cellKey } from './grid-model';
import { trailOf } from './playhead';

export interface CellFlash {
  key: string;
  seq: number;
}

interface GridProps {
  /** [step][track] note counts. */
  cells: number[][];
  currentStep: number;
  /** Cell to flash; a new seq remounts the cell so the animation replays. */
  flash: CellFlash | null;
  /** cell keys (step:track) that hold at least one agent note. */
  agentCells: ReadonlySet<string>;
  /** W13: [step][track] brightness 0..1 of the live note (fades over its last 2 bars); absent = 1. */
  fades?: number[][];
  /** W13: [step][track] brightness of a note the voice cap just evicted (silent, fading out). */
  ghosts?: number[][];
}

const stepNumbers = Array.from({ length: STEPS }, (_, i) => i + 1);
const rowTemplate = { gridTemplateColumns: `var(--grid-label-col, 104px) repeat(${STEPS}, minmax(0, 1fr))` };
const isBeat = (step: number) => step % 4 === 0;

interface CellProps {
  label: string;
  colour: string;
  count: number;
  step: number;
  isPlayhead: boolean;
  isAgent: boolean;
  isFlashing: boolean;
  cellId: string;
  /** W13: 0..1, the note's remaining brightness. */
  fade: number;
  /** W13: 0..1, an evicted note's fading light on an otherwise dark cell. */
  ghost: number;
}

/** Hex alpha suffix for a 0..1 factor applied to a base alpha byte. */
function alpha(base: number, factor: number): string {
  return Math.round(Math.max(0, Math.min(1, factor)) * base)
    .toString(16)
    .padStart(2, '0');
}

function cellStyle({ colour, count, step, isPlayhead, isAgent, fade, ghost }: CellProps): React.CSSProperties {
  const on = count > 0;
  if (!on && ghost > 0) {
    // W13: evicted by the voice cap: silent now, its colour fading out like an expiring note.
    return {
      background: `color-mix(in srgb, ${colour} ${Math.round(ghost * 100)}%, var(--cell-off))`,
      boxShadow: isPlayhead ? 'inset 0 0 0 2px rgba(255, 255, 255, 0.55)' : 'inset 0 0 0 1px var(--line)',
    };
  }
  if (!on) {
    return {
      background: isPlayhead ? 'rgba(255, 255, 255, 0.10)' : isBeat(step) ? 'var(--cell-off-beat)' : 'var(--cell-off)',
      boxShadow: isPlayhead ? 'inset 0 0 0 2px rgba(255, 255, 255, 0.55)' : 'inset 0 0 0 1px var(--line)',
    };
  }
  if (isAgent) {
    // Hollow: the track colour as an outline around a dark core, so the DJ reads as a guest.
    return {
      background: `color-mix(in srgb, ${colour} 22%, var(--stage))`,
      outline: `3px solid ${colour}`,
      outlineOffset: '-3px',
      boxShadow: isPlayhead ? `0 0 0 3px var(--playhead-edge), 0 0 30px ${colour}` : `0 0 16px ${colour}${alpha(0x66, fade)}`,
      opacity: 0.25 + 0.75 * fade,
      ['--agent-glow' as string]: colour,
    };
  }
  // W13: a note in its last 2 bars loses glow and opacity together; it never drops below 15 %
  // until it is gone, so the room can still see which note is about to go.
  return {
    background: colour,
    boxShadow: isPlayhead
      ? `0 0 0 3px var(--playhead-edge), 0 0 36px ${colour}, 0 0 80px ${colour}${alpha(0x88, fade)}`
      : `0 0 22px ${colour}${alpha(0xff, fade)}, 0 0 56px ${colour}${alpha(0x55, fade)}`,
    opacity: Math.min(1, 0.8 + count * 0.1) * (0.15 + 0.85 * fade),
  };
}

/** One step of one track. Memoized: per tick only the 16 cells leaving and entering the playhead column re-render. */
const Cell = memo(function Cell(props: CellProps) {
  const { label, count, isPlayhead, isAgent, isFlashing, cellId, fade, ghost } = props;
  const on = count > 0;
  const fading = on && fade < 1;
  const ghosted = !on && ghost > 0;
  return (
    <div
      role="cell"
      data-cell={cellId}
      data-on={on || undefined}
      data-fade={fading ? fade.toFixed(2) : undefined}
      data-ghost={ghosted ? 'true' : undefined}
      data-playhead={isPlayhead ? 'true' : undefined}
      data-agent={isAgent || undefined}
      aria-label={`${label}${on ? `, ${count} on` : ghosted ? ', off, making room for newer notes' : ', off'}${fading ? ', fading' : ''}${isAgent ? ', agent' : ''}${isPlayhead ? ', playing' : ''}`}
      className={cx(
        'relative rounded-[var(--radius-cell)] transition-[background-color,box-shadow,opacity] duration-300 ease-linear',
        isFlashing && 'cell-flash',
        isAgent && on && 'cell-agent',
      )}
      style={cellStyle(props)}
    >
      {isAgent && on && (
        <span
          aria-hidden="true"
          className="absolute left-1/2 top-1/2 size-[22%] -translate-x-1/2 -translate-y-1/2 rounded-full"
          style={{ background: 'var(--agent-core)', boxShadow: '0 0 12px var(--agent-ring)' }}
        />
      )}
    </div>
  );
});

interface RowProps {
  track: TrackMeta;
  counts: number[];
  currentStep: number;
  flash: CellFlash | null;
  agentCells: ReadonlySet<string>;
  fades: number[] | null;
  ghosts: number[] | null;
}

function Row({ track, counts, currentStep, flash, agentCells, fades, ghosts }: RowProps) {
  return (
    <div role="row" className="grid min-h-0 flex-1 gap-[6px]" style={rowTemplate}>
      <div
        role="rowheader"
        className="flex items-center justify-end pr-4 text-right"
        style={{ fontSize: 'var(--grid-label-size, var(--text-lg))', color: track.colour, fontWeight: 700, letterSpacing: '-0.01em' }}
      >
        {track.label}
      </div>
      {stepNumbers.map((n) => {
        const step = n - 1;
        const key = cellKey(step, track.id);
        const isFlashing = flash?.key === key;
        return (
          <Cell
            key={isFlashing ? `${key}#${flash.seq}` : key}
            cellId={key}
            label={`${track.label} step ${n}`}
            colour={track.colour}
            count={counts[step] ?? 0}
            step={step}
            isPlayhead={step === currentStep}
            isAgent={agentCells.has(key)}
            isFlashing={isFlashing}
            fade={fades ? (fades[step] ?? 0) : 1}
            ghost={ghosts?.[step] ?? 0}
          />
        );
      })}
    </div>
  );
}

/** The light behind the cells: one column per step, the current one bright, two fading behind it. */
function PlayheadColumns({ currentStep }: { currentStep: number }) {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 grid gap-[6px]" style={rowTemplate}>
      <div />
      {stepNumbers.map((n) => {
        const step = n - 1;
        const trail = trailOf(step, currentStep);
        return (
          <div
            key={`ph-${n}`}
            data-playhead-col={step}
            data-active={trail === 0 ? 'true' : undefined}
            data-trail={trail !== null && trail > 0 ? String(trail) : undefined}
            className="ph-col"
          />
        );
      })}
    </div>
  );
}

/** 16 × 8 sequencer display. Rows are tracks, columns are steps (blocks). Read-only. */
export function Grid({ cells, currentStep, flash, agentCells, fades, ghosts }: GridProps) {
  return (
    <div
      data-testid="stage-grid"
      data-playhead-step={currentStep}
      className="flex h-full w-full flex-col gap-[6px]"
    >
      <div className="relative min-h-0 flex-1">
        <PlayheadColumns currentStep={currentStep} />
        <div
          role="table"
          aria-label="Sequencer pattern, 16 steps by 8 tracks"
          aria-rowcount={TRACKS}
          aria-colcount={STEPS + 1}
          className="relative flex h-full min-h-0 flex-col gap-[6px]"
        >
          {TRACK_META.map((track) => (
            <Row
              key={track.id}
              track={track}
              counts={cells.map((row) => row[track.id] ?? 0)}
              currentStep={currentStep}
              flash={flash}
              agentCells={agentCells}
              fades={fades ? fades.map((row) => row[track.id] ?? 0) : null}
              ghosts={ghosts ? ghosts.map((row) => row[track.id] ?? 0) : null}
            />
          ))}
        </div>
      </div>
      <div aria-hidden="true" className="grid h-9 gap-[6px]" style={rowTemplate}>
        <div />
        {stepNumbers.map((n) => {
          const isPlayhead = n - 1 === currentStep;
          return (
            <div
              key={`ruler-${n}`}
              className={cx('num flex items-start justify-center pt-1', isPlayhead && 'playhead-edge')}
              style={{
                fontSize: 'var(--grid-ruler-size, var(--text-md))',
                color: isPlayhead ? 'var(--playhead-edge)' : isBeat(n - 1) ? 'var(--ink-muted)' : 'var(--ink-faint)',
                fontWeight: isPlayhead ? 700 : 500,
                borderTop: isPlayhead ? '4px solid var(--playhead-edge)' : '4px solid transparent',
                borderRadius: 2,
              }}
            >
              {n}
            </div>
          );
        })}
      </div>
    </div>
  );
}
