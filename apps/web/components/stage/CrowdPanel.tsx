import type { CrowdStatus } from '@/lib/crowd/client';

interface CrowdPanelProps {
  status: CrowdStatus | null;
  error: string | null;
}

/**
 * W19: the simulated players, as the host sees them: on / stopping / off, players active, notes
 * sent and landed, on-step ratio, MON spent. Rendered only with the host bar, and it always says
 * "Simulated players": on stage the presenter says so too.
 */
export function CrowdPanel({ status, error }: CrowdPanelProps) {
  const running = status?.running ?? false;
  const stopping = status?.stopping ?? false;
  if (!running && !status?.lastExit && !error) return null;
  const stats = [
    status?.playersActive !== null && status?.playersActive !== undefined ? `${status.playersActive}/${status.playersTotal ?? status.players ?? '?'} active` : null,
    status?.notesSent !== null && status?.notesSent !== undefined ? `${status.notesSent} notes (${status.notesConfirmed ?? 0} landed)` : null,
    status?.onStepPct !== null && status?.onStepPct !== undefined ? `${status.onStepPct}% on step` : null,
    status?.monSpent !== null && status?.monSpent !== undefined ? `${status.monSpent} MON` : null,
  ].filter((x): x is string => x !== null);
  const bar = status?.bar !== null && status?.bar !== undefined && status.bars !== null ? ` · bar ${status.bar}/${status.bars}` : '';
  const state = stopping ? 'Stopping · sweeping MON back' : running ? `On · session ${status?.sessionId ?? '?'}${bar}${status?.mode === 'visible' ? ' · visible phones' : ''}` : 'Off';
  return (
    <section
      data-testid="crowd-panel"
      data-running={running ? 'true' : 'false'}
      aria-label="Simulated players"
      className="flex flex-col gap-0.5 rounded-[var(--radius-control)] px-3 py-1.5"
      style={{ background: 'var(--surface-2)', border: `1px solid ${running ? 'var(--line-strong)' : 'var(--line)'}`, fontSize: 'var(--text-sm)' }}
    >
      <div className="flex items-center justify-between gap-3">
        <strong className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className="inline-block size-2.5 rounded-full"
            style={{ background: running ? (stopping ? 'var(--track-snare)' : 'var(--ok)') : 'var(--ink-faint)', boxShadow: running ? '0 0 8px var(--ok)' : 'none' }}
          />
          Simulated players
        </strong>
        <span data-testid="crowd-state" className="num shrink-0" style={{ color: running ? 'var(--ink)' : 'var(--ink-muted)' }}>
          {state}
        </span>
      </div>
      {stats.length > 0 && (
        <span data-testid="crowd-stats" className="num truncate" style={{ color: 'var(--ink-muted)', fontSize: 'var(--text-xs)' }} title={stats.join(' · ')}>
          {stats.join(' · ')}
        </span>
      )}
      {!running && status?.lastExit && (
        <span className="truncate" style={{ color: 'var(--ink-muted)', fontSize: 'var(--text-xs)' }} title={status.lastExit}>
          Last run: {status.lastExit}
        </span>
      )}
      {error && (
        <span role="alert" style={{ color: 'var(--danger)' }}>
          {error}
        </span>
      )}
    </section>
  );
}
