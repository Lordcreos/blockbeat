'use client';
import Link from 'next/link';
import { useState } from 'react';
import type { CrowdMode } from '@/lib/crowd/client';

interface HostControlsProps {
  sessionId: bigint;
  finalized: boolean;
  /** Token minted from this session, when known. */
  mintedTokenId: bigint | null;
  busy: boolean;
  status: string | null;
  /** False until the presenter has committed the host secret (chain mode). */
  hasSecret: boolean;
  /** Called with the typed secret on Enter or blur, never per keystroke. */
  onSecretCommit: (secret: string) => void;
  onNewSession: () => void;
  onEndAndMint: () => void;
  /** W12: the resident DJ started from the stage (its panel stays in the rail for the room). */
  djRunning: boolean;
  djBusy: boolean;
  onToggleDj: () => void;
  /** True while the audio overlay or the finalize dialog owns the page. */
  inert?: boolean;
  /** W19: simulated players (the crowd simulator on the laptop); no buttons when absent. */
  crowd?: {
    running: boolean;
    /** Stopped, still sweeping its burners back to the drip wallet. */
    stopping: boolean;
    busy: boolean;
    /** Headed phone windows open on the machine running the server: offered only there. */
    visibleAvailable: boolean;
    onAdd: (mode: CrowdMode) => void;
    onStop: () => void;
  };
}

const quiet = { fontSize: 'var(--text-md)', background: 'var(--surface-2)', border: '1px solid var(--line-strong)', color: 'var(--ink)' } as const;
const primary = { fontSize: 'var(--text-md)', background: 'var(--ink)', color: 'var(--ink-on-track)', border: '1px solid var(--ink)' } as const;
const button = 'inline-flex items-center justify-center rounded-full px-6 py-3 font-semibold whitespace-nowrap disabled:opacity-50';

/**
 * W15: the host bar. A full-width strip across the top of the stage (the rehearsal missed the
 * old small controls in the corner), shown only to the presenter: when a host secret is stored
 * or the page is opened with `?host=1`, so the projector's audience view stays clean.
 * "New session" strands every phone on the old code, so it still asks first. After minting,
 * the mint button gives way to "Play the track" and "Open the gallery".
 */
export function HostControls({ sessionId, finalized, mintedTokenId, busy, status, hasSecret, onSecretCommit, onNewSession, onEndAndMint, djRunning, djBusy, onToggleDj, inert = false, crowd }: HostControlsProps) {
  const [draft, setDraft] = useState('');
  const [confirmNew, setConfirmNew] = useState(false);

  const commit = () => {
    const secret = draft.trim();
    if (secret) onSecretCommit(secret);
  };

  const state = finalized ? (mintedTokenId !== null ? `Minted as Track #${mintedTokenId.toString()}` : 'Minted') : 'Live';

  return (
    <section
      aria-label="Host controls"
      inert={inert}
      data-testid="host-bar"
      className="host-bar relative z-[2] flex flex-wrap items-center gap-x-6 gap-y-3 px-5 py-3 lg:px-10"
      style={{ background: 'var(--surface-1)', borderBottom: '1px solid var(--line-strong)', boxShadow: '0 12px 30px -18px rgba(0,0,0,0.9)' }}
    >
      <div className="flex items-center gap-4">
        <span style={{ fontSize: 'var(--text-md)', color: 'var(--ink-muted)', fontWeight: 600 }}>Host</span>
        <span className="num" style={{ fontSize: 'var(--text-lg)', fontWeight: 700 }}>
          Session {sessionId.toString()}
        </span>
        <span
          data-testid="host-session-state"
          className="num inline-flex items-center gap-2 rounded-full px-3 py-1"
          style={{ fontSize: 'var(--text-sm)', background: 'var(--surface-2)', border: `1px solid ${finalized ? 'var(--line-strong)' : 'var(--ok)'}` }}
        >
          {state}
        </span>
      </div>

      <span role="status" aria-live="polite" className="min-w-0 flex-1 truncate" style={{ fontSize: 'var(--text-sm)', color: 'var(--ink-muted)' }}>
        {status ?? ''}
      </span>

      {confirmNew ? (
        <div role="group" aria-label="Confirm a new session" className="flex flex-wrap items-center gap-3">
          <span style={{ fontSize: 'var(--text-md)' }}>Start a new session? Phones must re-scan the new code.</span>
          <button
            type="button"
            onClick={() => {
              setConfirmNew(false);
              onNewSession();
            }}
            disabled={busy}
            className={button}
            style={{ ...primary, background: 'var(--danger)', border: '1px solid var(--danger)', color: '#fff' }}
          >
            Start new session
          </button>
          <button type="button" onClick={() => setConfirmNew(false)} className={button} style={quiet}>
            Keep this session
          </button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          {!hasSecret && (
            <label className="flex items-center gap-2" style={{ fontSize: 'var(--text-sm)', color: 'var(--ink-muted)' }}>
              Host secret
              <input
                type="password"
                autoComplete="off"
                value={draft}
                onChange={(e) => setDraft(e.currentTarget.value)}
                onBlur={commit}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    commit();
                  }
                }}
                className="w-40 rounded-full px-4 py-3"
                style={quiet}
              />
            </label>
          )}
          <button type="button" onClick={() => setConfirmNew(true)} disabled={busy} className={button} style={quiet}>
            New session
          </button>
          <button
            type="button"
            onClick={onToggleDj}
            disabled={djBusy || (!djRunning && finalized)}
            aria-pressed={djRunning}
            className={button}
            style={{ ...quiet, border: `1px solid ${djRunning ? 'var(--agent-ring)' : 'var(--line-strong)'}` }}
          >
            {djRunning ? 'Stop DJ' : 'Start DJ'}
          </button>
          {crowd &&
            (crowd.running ? (
              <button type="button" onClick={crowd.onStop} disabled={crowd.busy || crowd.stopping} className={button} style={{ ...quiet, border: '1px solid var(--ok)' }}>
                {crowd.stopping ? 'Sweeping…' : 'Stop crowd'}
              </button>
            ) : (
              <>
                <button type="button" onClick={() => crowd.onAdd('headless')} disabled={crowd.busy || finalized} className={button} style={quiet}>
                  Add 10 players
                </button>
                {crowd.visibleAvailable && (
                  <button type="button" onClick={() => crowd.onAdd('visible')} disabled={crowd.busy || finalized} className={button} style={quiet}>
                    Add 5 visible
                  </button>
                )}
              </>
            ))}
          {finalized ? (
            <>
              {mintedTokenId !== null && (
                <Link href={`/track/${mintedTokenId.toString()}`} className={button} style={primary}>
                  Play the track
                </Link>
              )}
              <Link href="/tracks" className={button} style={quiet}>
                Open the gallery
              </Link>
            </>
          ) : (
            <button type="button" onClick={onEndAndMint} disabled={busy} className={button} style={primary}>
              End session and mint
            </button>
          )}
        </div>
      )}
    </section>
  );
}
