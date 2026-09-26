import type { Address } from 'viem';
import { formatInt, shortAddress } from '@/components/format';
import { formatMon } from '@/lib/funding';
import { trackSplit, type SplitContributor } from '@/lib/tips/split';
import type { TipLine } from '@/lib/tips/tipList';

export interface TrackTipsProps {
  /** Host share and players' pool (W21a hostTipsOf / getSession().tipPool); hostWei null when the contract has no split. */
  hostWei: bigint | null;
  hostClaimableWei: bigint | null;
  poolWei: bigint;
  contributors: readonly SplitContributor[];
  /** The contract's DJ (agent()): it keeps its notes and takes no tips. */
  agent: Address | null;
  /** Newest first. */
  lines: readonly TipLine[];
}

const label = { fontSize: 'var(--text-sm)', color: 'var(--ink-muted)', fontWeight: 500 } as const;

function clock(at: number | null): { text: string; iso: string | null } {
  if (at === null) return { text: '—', iso: null };
  const d = new Date(at);
  return { text: d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }), iso: d.toISOString() };
}

/**
 * W21b: what the room gave the track and who it goes to: the total, the host's 20 % (pulled by
 * the host), and the players' 80 % pro rata by notes. Each human's "Earned" is their share of
 * the pool (what claim pays after finalize, before any claim); the DJ's row keeps its notes.
 * Then every tip with its time, name and message, as plain text. Server-safe (no hooks).
 */
export function TrackTips({ hostWei, hostClaimableWei, poolWei, contributors, agent, lines }: TrackTipsProps) {
  const split = trackSplit({ hostWei: hostWei ?? 0n, poolWei, contributors, agent });
  return (
    <section aria-label="Tips and contributors" data-testid="track-tips" className="flex flex-col gap-5">
      <div className="flex flex-col gap-3">
        <h2 style={{ fontSize: 'var(--text-lg)', fontWeight: 700, letterSpacing: '-0.01em' }}>Tips</h2>
        <dl className="grid grid-cols-3 gap-4">
          <div className="flex flex-col gap-1">
            <dt style={label}>Raised</dt>
            <dd data-testid="track-raised" className="num font-bold leading-none" style={{ fontSize: 'var(--text-hud)', color: 'var(--track-hat)', fontFamily: 'var(--font-mono)' }}>
              {formatMon(split.raisedWei)}
              <span style={{ fontSize: 'var(--text-md)' }}> MON</span>
            </dd>
          </div>
          <div className="flex flex-col gap-1">
            <dt style={label}>Host, 20 %</dt>
            <dd data-testid="track-host-share" className="num font-semibold" style={{ fontSize: 'var(--text-lg)', fontFamily: 'var(--font-mono)' }}>
              {hostWei === null ? '—' : `${formatMon(hostWei)} MON`}
            </dd>
            {hostWei !== null && hostClaimableWei !== null && (
              <dd data-testid="track-host-claimable" style={{ fontSize: 'var(--text-xs)', color: 'var(--ink-muted)' }}>
                {hostClaimableWei > 0n ? `${formatMon(hostClaimableWei)} MON not claimed yet` : 'claimed'}
              </dd>
            )}
          </div>
          <div className="flex flex-col gap-1">
            <dt style={label}>Players, 80 %</dt>
            <dd data-testid="tip-pool" className="num font-semibold" style={{ fontSize: 'var(--text-lg)', fontFamily: 'var(--font-mono)' }}>
              {formatMon(poolWei)} MON
            </dd>
          </div>
        </dl>
      </div>

      <div className="flex flex-col gap-3">
        <h3 style={{ fontSize: 'var(--text-lg)', fontWeight: 700 }}>
          Contributors <span className="num" style={{ color: 'var(--ink-muted)', fontWeight: 500 }}>({formatInt(split.rows.length)})</span>
        </h3>
        {split.rows.length === 0 ? (
          <p style={{ fontSize: 'var(--text-md)', color: 'var(--ink-muted)' }}>Nobody played this session.</p>
        ) : (
          <table data-testid="contributors" className="w-full border-collapse" style={{ fontSize: 'var(--text-md)' }}>
            <thead>
              <tr style={{ color: 'var(--ink-muted)', textAlign: 'left', fontSize: 'var(--text-sm)' }}>
                <th className="pb-2 font-medium">Player</th>
                <th className="pb-2 text-right font-medium">Notes</th>
                <th className="pb-2 pl-4 text-right font-medium">Share</th>
                <th className="pb-2 pl-4 text-right font-medium">Earned</th>
              </tr>
            </thead>
            <tbody>
              {split.rows.map((r) => (
                <tr key={r.address} data-player={r.address} data-agent={r.isAgent ? 'true' : undefined} style={{ borderTop: '1px solid var(--line)' }}>
                  <td className="num py-3" title={r.address} style={{ fontFamily: 'var(--font-mono)' }}>
                    {shortAddress(r.address)}
                    {r.isAgent && <span style={{ fontFamily: 'var(--font-sans)', color: 'var(--ink-muted)' }}> · DJ</span>}
                  </td>
                  <td className="num py-3 text-right">{formatInt(r.hits)}</td>
                  {r.isAgent ? (
                    <td colSpan={2} className="py-3 pl-4 text-right" style={{ color: 'var(--ink-muted)', fontSize: 'var(--text-sm)' }}>
                      DJ takes no tips
                    </td>
                  ) : (
                    <>
                      <td className="num py-3 pl-4 text-right">{r.sharePct}%</td>
                      <td className="num py-3 pl-4 text-right" style={{ fontFamily: 'var(--font-mono)' }}>
                        {formatMon(r.earnedWei)} MON
                      </td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p style={{ fontSize: 'var(--text-sm)', color: 'var(--ink-muted)' }}>
          Earned is each player&apos;s share of the pool by notes. Players claim it from their phone after the track is minted.
        </p>
      </div>

      <div className="flex flex-col gap-3">
        <h3 style={{ fontSize: 'var(--text-lg)', fontWeight: 700 }}>
          Tips received <span className="num" style={{ color: 'var(--ink-muted)', fontWeight: 500 }}>({formatInt(lines.length)})</span>
        </h3>
        {lines.length === 0 ? (
          <p style={{ fontSize: 'var(--text-md)', color: 'var(--ink-muted)' }}>No tips for this track yet.</p>
        ) : (
          <ol data-testid="track-tip-list" className="flex flex-col">
            {lines.map((l) => {
              const t = clock(l.at);
              return (
                <li key={l.txHash} data-testid="track-tip" className="grid grid-cols-[4.5rem_minmax(0,1fr)_auto] items-baseline gap-x-4 py-3" style={{ borderTop: '1px solid var(--line)' }}>
                  <span className="num" style={{ fontSize: 'var(--text-sm)', color: 'var(--ink-muted)' }}>
                    {t.iso ? <time dateTime={t.iso}>{t.text}</time> : t.text}
                  </span>
                  <span className="flex min-w-0 flex-col">
                    <strong className="truncate" style={{ fontWeight: 600, fontFamily: l.name ? undefined : 'var(--font-mono)' }}>
                      {l.name ?? shortAddress(l.from)}
                    </strong>
                    {l.message && <span style={{ fontSize: 'var(--text-sm)', color: 'var(--ink-muted)', overflowWrap: 'anywhere' }}>{l.message}</span>}
                  </span>
                  <span className="num font-semibold" style={{ fontFamily: 'var(--font-mono)' }}>
                    {formatMon(l.amountWei)} MON
                  </span>
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </section>
  );
}
