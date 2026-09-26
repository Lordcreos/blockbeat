import { shortAddress } from '@/components/format';
import { formatMon } from '@/lib/funding';
import type { TipLine } from '@/lib/tips/tipList';

interface TipsPanelProps {
  /** Host share + players' pool (the feed's raisedWei). */
  raisedWei: bigint;
  /** Newest first (lib/tips/tipList.ts). */
  lines: readonly TipLine[];
  /** Bumped once per tip that lands; replays the figure's pop and the newest line's entrance. */
  flash: number;
  /** Lines shown; the rail fits three at 1080 px. */
  max?: number;
}

/**
 * W21b: what the room gave this song. One bold figure in the tip colour (the rail's only use
 * of it, with the tips code above), the newest tips under it, plain text: React escapes the
 * names and messages people typed. Each landed tip pops the figure and slides its line in.
 */
export function TipsPanel({ raisedWei, lines, flash, max = 3 }: TipsPanelProps) {
  const shown = lines.slice(0, max);
  return (
    <section aria-label="Tips" data-testid="tips-panel" className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <h2 style={{ fontSize: 'var(--text-md)', color: 'var(--ink-muted)', fontWeight: 500 }}>Raised by this song</h2>
        {/* The live region stays mounted (screen readers announce the text change); only the decorative pop remounts. */}
        <p
          data-testid="raised"
          role="status"
          aria-live="polite"
          className="num whitespace-nowrap font-bold leading-none"
          style={{ fontSize: 'var(--text-hud)', letterSpacing: '-0.02em', fontFamily: 'var(--font-mono)', color: 'var(--track-hat)' }}
        >
          <span key={`raised-${flash}`} data-testid="raised-figure" className={flash > 0 ? 'raised-pop' : undefined}>
            {formatMon(raisedWei)} MON
          </span>
        </p>
      </div>
      {shown.length === 0 ? (
        <p data-testid="tip-list-empty" style={{ fontSize: 'var(--text-sm)', color: 'var(--ink-muted)' }}>
          The first tip shows up here. Scan the tip code to send one.
        </p>
      ) : (
        <ol data-testid="tip-list" aria-label="Latest tips" className="flex flex-col gap-1">
          {shown.map((l, i) => (
            <li
              key={l.txHash}
              data-testid="tip-item"
              className={`flex min-w-0 items-baseline gap-2 rounded-[var(--radius-control)] px-3 py-1.5${i === 0 && flash > 0 ? ' tip-in' : ''}`}
              style={{ background: 'var(--surface-2)', borderLeft: '3px solid var(--track-hat)', fontSize: 'var(--text-md)' }}
              title={l.message ?? undefined}
            >
              {/* One line per tip so three fit the 1080 px rail; the full message is on /track. */}
              <strong className="max-w-[45%] shrink-0 truncate" style={{ fontWeight: 600, fontFamily: l.name ? undefined : 'var(--font-mono)' }}>
                {l.name ?? shortAddress(l.from)}
              </strong>
              <span className="min-w-0 flex-1 truncate" style={{ fontSize: 'var(--text-sm)', color: 'var(--ink-muted)' }}>
                {l.message ?? ''}
              </span>
              <span className="num shrink-0 font-semibold" style={{ fontFamily: 'var(--font-mono)' }}>
                {formatMon(l.amountWei)} MON
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
