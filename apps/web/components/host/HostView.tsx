'use client';
import Link from 'next/link';
import { useState } from 'react';
import { isMockMode } from '@/lib/chain/clients';
import { explorerTxLink } from '@/lib/chain/explorer';
import { loadHostSecret, saveHostSecret, startSessionRequest } from '@/lib/host/client';
import { QrCode } from '@/components/QrCode';
import { formatInt, shortUrl } from '@/components/format';
import { useOrigin } from '@/components/useOrigin';

/** One session as plain JSON for the recent list (bigints as decimal strings). */
export interface RecentSession {
  sessionId: string;
  finalized: boolean;
  /** "0" until minted. */
  tokenId: string;
  hits: string;
}

interface HostViewProps {
  /** Newest first; null when the chain could not be read (or on the simulator). */
  recent: RecentSession[] | null;
  recentError: string | null;
}

interface LinkCardProps {
  testId: string;
  title: string;
  body: string;
  href: string;
  absolute: string;
  linkLabel: string;
}

function LinkCard({ testId, title, body, href, absolute, linkLabel }: LinkCardProps) {
  return (
    <section className="flex flex-col gap-4 rounded-[20px] p-6" style={{ background: 'var(--surface-1)', border: '1px solid var(--line)' }}>
      <h2 style={{ fontSize: 'var(--text-lg)', fontWeight: 600 }}>{title}</h2>
      <p style={{ fontSize: 'var(--text-md)', color: 'var(--ink-muted)' }}>{body}</p>
      <div data-testid={testId} className="self-start rounded-[12px] p-2" style={{ background: '#fff' }}>
        <QrCode value={absolute} size={200} label={`QR code for ${title}`} />
      </div>
      <p className="num break-all" style={{ fontSize: 'var(--text-md)' }}>{absolute ? shortUrl(absolute) : href}</p>
      <Link href={href} className="self-start rounded-full px-5 py-3 font-semibold" style={{ background: 'var(--ink)', color: 'var(--ink-on-track)', fontSize: 'var(--text-md)' }}>
        {linkLabel}
      </Link>
    </section>
  );
}

const muted = { fontSize: 'var(--text-sm)', color: 'var(--ink-muted)' } as const;
/** The stage opens with the host bar on: the presenter lands on New session / End session and mint. */
const stageHref = (id: string): string => `/stage/${id}?host=1`;

function RecentSessions({ sessions, error }: { sessions: RecentSession[] | null; error: string | null }) {
  return (
    <section aria-labelledby="recent-title" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-4">
        <h2 id="recent-title" style={{ fontSize: 'var(--text-lg)', fontWeight: 700 }}>
          Recent sessions
        </h2>
        <Link href="/tracks" className="font-semibold underline-offset-4 hover:underline" style={{ fontSize: 'var(--text-md)' }}>
          Open the gallery
        </Link>
      </div>
      {error && (
        <p role="alert" style={{ fontSize: 'var(--text-md)', color: 'var(--danger)' }}>
          Could not read recent sessions from the chain: {error}. Reload in a moment.
        </p>
      )}
      {sessions && sessions.length === 0 && <p style={{ fontSize: 'var(--text-md)', color: 'var(--ink-muted)' }}>No sessions yet. Create one above.</p>}
      {sessions && sessions.length > 0 && (
        <ol className="flex flex-col" style={{ borderBottom: '1px solid var(--line)' }}>
          {sessions.map((s) => (
            <li key={s.sessionId} data-testid="recent-session" className="flex flex-wrap items-center gap-x-6 gap-y-2 py-3" style={{ borderTop: '1px solid var(--line)', fontSize: 'var(--text-md)' }}>
              <span className="num min-w-[11ch] font-semibold">Session {s.sessionId}</span>
              <span
                className="num rounded-full px-3 py-1"
                style={{ fontSize: 'var(--text-sm)', background: 'var(--surface-2)', border: `1px solid ${s.finalized ? 'var(--line-strong)' : 'var(--ok)'}` }}
              >
                {s.finalized ? 'Minted' : 'Live'}
              </span>
              <span className="num" style={muted}>
                {formatInt(BigInt(s.hits))} hits
              </span>
              <span className="ml-auto flex flex-wrap gap-4">
                {s.finalized && s.tokenId !== '0' && (
                  <Link href={`/track/${s.tokenId}`} className="font-semibold underline-offset-4 hover:underline">
                    Track #{s.tokenId}
                  </Link>
                )}
                <Link href={stageHref(s.sessionId)} className="underline-offset-4 hover:underline" style={{ color: 'var(--ink-muted)' }}>
                  Stage
                </Link>
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

export function HostView({ recent, recentError }: HostViewProps) {
  const origin = useOrigin();
  const [sessionId, setSessionId] = useState<bigint | null>(null);
  const [created, setCreated] = useState<RecentSession[]>([]);
  const [txUrl, setTxUrl] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState(() => loadHostSecret() ?? '');
  const mock = isMockMode();

  // Typed or pasted, committed on Enter or blur (the stage reads it from this tab's storage).
  const commit = () => {
    const secret = draft.trim();
    if (secret) saveHostSecret(secret);
  };

  const create = async () => {
    setCreating(true);
    setError(null);
    commit();
    try {
      const result = await startSessionRequest(draft.trim() || null);
      setSessionId(result.sessionId);
      setTxUrl(result.txHash ? explorerTxLink(result.txHash) : null);
      setCreated((prev) => [{ sessionId: result.sessionId.toString(), finalized: false, tokenId: '0', hits: '0' }, ...prev]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'unknown error');
    } finally {
      setCreating(false);
    }
  };

  const known = new Set(created.map((s) => s.sessionId));
  const sessions = recent === null && created.length === 0 ? null : [...created, ...(recent ?? []).filter((s) => !known.has(s.sessionId))];
  const stage = sessionId !== null ? stageHref(sessionId.toString()) : '';
  const joinHref = sessionId !== null ? `/join/${sessionId}` : '';

  return (
    <main className="mx-auto flex w-full max-w-[1100px] flex-1 flex-col gap-10 px-5 py-10 sm:px-10">
      <header className="flex flex-col gap-3">
        <h1 style={{ fontSize: 'clamp(40px, 6vw, var(--text-title))', fontWeight: 650, letterSpacing: '-0.025em', lineHeight: 1 }}>Host a session</h1>
        <p style={{ fontSize: 'var(--text-md)', color: 'var(--ink-muted)', maxWidth: '56ch' }}>
          A session is a loop the room fills together. Create one, put the stage on the big screen, let people scan the join code, then end the session and mint the track from the host bar on the stage.
        </p>
      </header>

      <section aria-label="Create a session" className="flex flex-col gap-5">
        <div className="flex flex-wrap items-end gap-5">
          <label className="flex w-full max-w-[36ch] flex-col gap-2" style={{ fontSize: 'var(--text-md)' }}>
            <span className="flex flex-col gap-1">
              <span style={{ color: 'var(--ink)', fontWeight: 600 }}>Host secret</span>
              <span style={{ fontSize: 'var(--text-sm)', color: 'var(--ink-muted)' }}>
                {mock ? 'Only needed if the server sets HOST_SECRET.' : 'The HOST_SECRET set on the server. Kept in this tab only.'}
              </span>
            </span>
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
              className="rounded-full px-5 py-4"
              style={{ background: 'var(--surface-1)', border: '1px solid var(--line-strong)', color: 'var(--ink)', fontSize: 'var(--text-md)' }}
            />
          </label>
          <button
            type="button"
            data-primary="true"
            onClick={() => void create()}
            disabled={creating}
            className="transport-button min-w-[16ch] rounded-full px-10 py-4 font-semibold disabled:opacity-60"
            style={{ background: 'var(--ink)', color: 'var(--ink-on-track)', fontSize: 'var(--text-lg)' }}
          >
            {creating ? 'Creating…' : 'Create session'}
          </button>
        </div>
        {error && (
          <p role="alert" style={{ fontSize: 'var(--text-md)', color: 'var(--danger)' }}>
            Could not create the session: {error}
          </p>
        )}
      </section>

      {sessionId !== null && (
        <section aria-label="New session links" className="flex flex-col gap-5">
          <p role="status" aria-live="polite" className="num" style={{ fontSize: 'var(--text-lg)' }}>
            Session {sessionId.toString()} is ready.
            {txUrl && (
              <>
                {' '}
                <a href={txUrl} target="_blank" rel="noreferrer noopener" style={{ color: 'var(--ink-muted)', fontSize: 'var(--text-md)' }}>
                  View the transaction on Monadscan
                </a>
              </>
            )}
          </p>
          <div className="grid gap-6 sm:grid-cols-2">
            <LinkCard
              testId="qr-stage"
              title="Stage"
              body="Open this on the laptop connected to the big screen and the speaker. The host bar at the top has New session and End session and mint."
              href={stage}
              absolute={origin ? `${origin}${stage}` : ''}
              linkLabel="Open stage"
            />
            <LinkCard
              testId="qr-join"
              title="Join"
              body="This is the code the stage shows. Anyone who scans it gets a wallet and a track."
              href={joinHref}
              absolute={origin ? `${origin}${joinHref}` : ''}
              linkLabel="Open join page"
            />
          </div>
        </section>
      )}

      <RecentSessions sessions={sessions} error={recentError} />
    </main>
  );
}
