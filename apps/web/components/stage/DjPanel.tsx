import type { AgentStatus } from '@/lib/host/client';

interface DjPanelProps {
  status: AgentStatus | null;
  error: string | null;
}

/** W12: the resident DJ, as the host sees it: on/off, hits sent, budget left, brain, last three lines. */
export function DjPanel({ status, error }: DjPanelProps) {
  const running = status?.running ?? false;
  const stats = [
    status?.hitsSent !== null && status?.hitsSent !== undefined ? `${status.hitsSent} hits sent` : null,
    status?.budgetLeft !== null && status?.budgetLeft !== undefined ? `${status.budgetLeft} left` : null,
    status?.brain ? `brain ${status.brain}` : null,
  ].filter((x): x is string => x !== null);
  // W14: "rules (gemini timeout)" means the LLM missed this bar and the rules played it.
  const brainFallback = status?.brain?.startsWith('rules (') ?? false;
  return (
    <section
      data-testid="dj-panel"
      data-running={running ? 'true' : 'false'}
      data-brain-fallback={brainFallback ? 'true' : 'false'}
      aria-label="Resident DJ"
      className="flex flex-col gap-0.5 rounded-[var(--radius-control)] px-3 py-1.5"
      style={{ background: 'var(--surface-2)', border: `1px solid ${running ? 'var(--agent-ring)' : 'var(--line)'}`, fontSize: 'var(--text-sm)' }}
    >
      <div className="flex items-center justify-between gap-3">
        <strong className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className="inline-block size-2.5 rounded-full"
            style={{ background: running ? 'var(--ok)' : 'var(--ink-faint)', boxShadow: running ? '0 0 8px var(--ok)' : 'none' }}
          />
          DJ
        </strong>
        {stats.length > 0 && (
          <span data-testid="dj-stats" className="num min-w-0 flex-1 truncate text-right" style={{ color: brainFallback ? 'var(--ink)' : 'var(--ink-muted)', fontSize: 'var(--text-xs)' }} title={stats.join(' · ')}>
            {stats.join(' · ')}
          </span>
        )}
        <span data-testid="dj-state" className="num shrink-0" style={{ color: running ? 'var(--ink)' : 'var(--ink-muted)' }}>
          {running ? `On · session ${status?.sessionId ?? '?'}` : 'Off'}
        </span>
      </div>
      {!running && status?.lastExit && (
        <span className="truncate" style={{ color: 'var(--ink-muted)', fontSize: 'var(--text-xs)' }} title={status.lastExit}>
          Last run: {status.lastExit}
        </span>
      )}
      {running && status && status.lines.length > 0 && (
        <ol data-testid="dj-lines" className="flex flex-col" style={{ fontFamily: 'var(--font-mono)', fontSize: '11px', lineHeight: 1.35, color: 'var(--ink-muted)' }}>
          {status.lines.map((line, i) => (
            <li key={`${i}:${line}`} className="truncate" title={line}>
              {line}
            </li>
          ))}
        </ol>
      )}
      {error && (
        <span role="alert" style={{ color: 'var(--danger)' }}>
          {error}
        </span>
      )}
    </section>
  );
}
