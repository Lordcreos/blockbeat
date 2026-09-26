import { STEPS, TRACK_META } from '@blockbeat/shared';
import { DEMO_PATTERN } from './demo-pattern';

const stepIndexes = Array.from({ length: STEPS }, (_, i) => i);

/**
 * The landing page's one visual: a sequencer that loops a plain techno bar with a playhead
 * sweeping at the real block rate. CSS only, no JavaScript, no layout work per frame.
 */
export function HeroGrid() {
  return (
    <figure
      data-testid="hero-grid"
      className="relative w-full overflow-hidden rounded-[18px] p-3 sm:p-4"
      style={{ background: 'var(--surface-1)', border: '1px solid var(--line-strong)', boxShadow: '0 40px 90px -30px rgba(0,0,0,0.95)' }}
    >
      <div className="relative">
        <div aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-0 w-[6.25%]">
          <div
            className="hero-playhead h-full w-full rounded-[8px]"
            style={{ background: 'linear-gradient(to bottom, var(--playhead-core), var(--playhead-glow) 55%, var(--playhead-core))', boxShadow: '0 0 28px 4px var(--playhead-glow)' }}
          />
        </div>
        <div
          role="img"
          aria-label="A 16-step drum pattern with a playhead sweeping across it one block at a time"
          className="relative grid gap-[4px] sm:gap-[6px]"
          style={{ gridTemplateColumns: `repeat(${STEPS}, minmax(0, 1fr))` }}
        >
          {TRACK_META.map((track) => {
            const row = DEMO_PATTERN[track.id] ?? [];
            return stepIndexes.map((step) => {
              const on = row[step] === true;
              return (
                <span
                  key={`${track.id}-${step}`}
                  data-cell={`${step}:${track.id}`}
                  data-on={on || undefined}
                  className="hero-cell aspect-square rounded-[4px] sm:rounded-[6px]"
                  style={{
                    ['--step' as string]: step,
                    background: on ? track.colour : step % 4 === 0 ? 'var(--cell-off-beat)' : 'var(--cell-off)',
                    boxShadow: on ? `0 0 14px ${track.colour}88` : 'inset 0 0 0 1px var(--line)',
                  }}
                />
              );
            });
          })}
        </div>
      </div>
      <figcaption className="num mt-3 flex items-center justify-between gap-3 whitespace-nowrap" style={{ fontSize: 'var(--text-xs)', color: 'var(--ink-muted)' }}>
        <span>16 steps, one Monad block each</span>
        <span>300 ms, 100 BPM</span>
      </figcaption>
    </figure>
  );
}
