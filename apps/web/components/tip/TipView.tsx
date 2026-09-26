'use client';
import { useState } from 'react';
import { parseEther, type Hash } from 'viem';
import { formatInt } from '@/components/format';
import { useBalance, useEventFeed } from '@/lib/hooks';
import { formatMon } from '@/lib/funding';
import { TipError } from '@/lib/tipSender';
import { isMockRuntime } from '@/lib/tips/claims';
import { DEFAULT_TIP_MON, NOTE_MESSAGE_MAX, NOTE_NAME_MAX, TIP_AMOUNTS_MON, tipRequiredWei, type TipAmountMon } from '@/lib/tips/constants';
import { postTipNote, useSendTip, useTipper, useTipperFunding } from '@/lib/tips/hooks';

interface TipViewProps {
  sessionId: bigint;
}

type NoteState = 'posting' | 'posted' | 'failed' | 'skipped';
type Status =
  | { kind: 'idle' }
  | { kind: 'sending'; amount: TipAmountMon }
  | { kind: 'confirmed'; amountWei: bigint; blockNumber: bigint; txHash: Hash; note: NoteState }
  | { kind: 'error'; message: string };

/** The page needs the session and the live streams, never the Hit history (lib/eventFeed.ts). */
const TIP_FEED = { tipTotals: true } as const;
const METER_BARS = [0, 1, 2, 3, 4] as const;

function tipFailure(error: unknown, amount: TipAmountMon): string {
  if (error instanceof TipError) {
    if (error.code === 'NO_HITS') return 'Tips open with the first note. Wait for the music, then send it again.';
    if (error.code === 'TIMEOUT') return 'No receipt yet. The tip may still land: check the big screen before you send another.';
  }
  const text = error instanceof Error ? error.message : String(error);
  if (/insufficient funds/i.test(text)) return `This phone does not hold enough MON for a ${amount} MON tip.`;
  return `The tip did not go through: ${text}`;
}

function trimmed(value: string): string | null {
  const t = value.trim();
  return t === '' ? null : t;
}

/**
 * W21b: /tip/[session], the stage's second code. Its own burner (funded once by the drip in
 * tipper mode), five fixed amounts, an optional name and message. Before the session's first
 * note the contract refuses tips (NoHits), so the page waits with the music. After the tip's
 * receipt the note goes to /api/tip-note, which checks the receipt before the stage shows it.
 */
export function TipView({ sessionId }: TipViewProps) {
  const tipper = useTipper();
  const funding = useTipperFunding(tipper?.address ?? null, sessionId);
  const feed = useEventFeed(sessionId, 'none', TIP_FEED);
  const balance = useBalance(tipper?.address ?? null, sessionId, funding.ready);
  const { send } = useSendTip(sessionId);
  const [amount, setAmount] = useState<TipAmountMon>(DEFAULT_TIP_MON);
  const [name, setName] = useState('');
  const [message, setMessage] = useState('');
  const [status, setStatus] = useState<Status>({ kind: 'idle' });

  const open = feed.hitCount > 0 || (feed.session?.hitCount ?? 0n) > 0n;
  const finalized = feed.session?.finalized ?? false;
  const known = balance.balanceWei;
  const affordable = (a: TipAmountMon): boolean => known === null || known >= tipRequiredWei(parseEther(a));
  const canPay = affordable(amount);
  const sending = status.kind === 'sending';
  const sendDisabled = !funding.ready || sending || !canPay;

  const sendTip = async (): Promise<void> => {
    setStatus({ kind: 'sending', amount });
    const tipName = trimmed(name);
    const tipMessage = trimmed(message);
    let receipt: Awaited<ReturnType<typeof send>>;
    try {
      receipt = await send(parseEther(amount));
    } catch (error) {
      balance.refresh();
      setStatus({ kind: 'error', message: tipFailure(error, amount) });
      return;
    }
    balance.refresh();
    setStatus({ kind: 'confirmed', amountWei: receipt.amountWei, blockNumber: receipt.blockNumber, txHash: receipt.txHash, note: 'posting' });
    // Every tip posts a note (text or not), so the stage and the track list it with its time.
    const posted = await postTipNote({
      sessionId,
      txHash: receipt.txHash,
      name: tipName,
      message: tipMessage,
      ...(isMockRuntime() && tipper ? { mock: { from: tipper.address, amountWei: receipt.amountWei } } : {}),
    });
    setStatus((s) => (s.kind === 'confirmed' && s.txHash === receipt.txHash ? { ...s, note: posted.ok ? 'posted' : 'failed' } : s));
  };

  const again = (): void => {
    setMessage('');
    setStatus({ kind: 'idle' });
  };

  const fundsLine = funding.error
    ? `We could not fund this tip wallet: ${funding.error}`
    : funding.retryInSeconds !== null
      ? `The drip is busy. Trying again in ${funding.retryInSeconds} s.`
      : !funding.ready
        ? 'Getting your tip wallet ready…'
        : !canPay
          ? known !== null && !affordable(TIP_AMOUNTS_MON[0])
            ? 'This phone has not enough MON left to tip.'
            : `Not enough MON for ${amount} MON. Pick a smaller amount.`
          : known !== null
            ? `Wallet: ${formatMon(known)} MON`
            : '';

  return (
    <main
      className="flex min-h-dvh w-full flex-col"
      style={{
        background: 'linear-gradient(to bottom, color-mix(in srgb, var(--track-hat) 12%, var(--stage)), var(--stage) 42%)',
        paddingTop: 'env(safe-area-inset-top)',
        paddingBottom: 'env(safe-area-inset-bottom)',
      }}
    >
      <div aria-hidden="true" className="h-[6px] w-full" style={{ background: 'var(--track-hat)', boxShadow: '0 0 18px var(--track-hat)' }} />
      <header className="flex flex-col gap-1 px-5 pb-3 pt-4">
        <span className="num" style={{ fontSize: 'var(--text-sm)', color: 'var(--ink-muted)' }}>
          Blockbeat · session {sessionId.toString()}
        </span>
        <h1 style={{ fontSize: 'clamp(36px, 11vw, 48px)', fontWeight: 800, letterSpacing: '-0.035em', lineHeight: 1 }}>Tip the room</h1>
        <p data-testid="tip-raised" className="num" style={{ fontSize: 'var(--text-md)' }}>
          Raised by this song: <strong style={{ color: 'var(--track-hat)', fontFamily: 'var(--font-mono)' }}>{formatMon(feed.raisedWei)} MON</strong>
        </p>
      </header>

      {!open ? (
        <section
          data-testid="tip-waiting"
          role="status"
          aria-live="polite"
          className="mx-5 my-4 flex flex-1 flex-col items-center justify-center gap-6 rounded-[var(--radius-pad)] px-6 py-10 text-center"
          style={{ background: 'var(--surface-1)', border: '1px solid var(--line-strong)' }}
        >
          <span aria-hidden="true" className="flex h-16 items-end gap-2">
            {METER_BARS.map((i) => (
              <span
                key={i}
                className="meter-bar block h-full w-3 rounded-full"
                style={{ background: 'var(--track-hat)', animationDelay: `${i * 140}ms`, opacity: 0.55 + i * 0.09 }}
              />
            ))}
          </span>
          <span className="flex flex-col gap-2">
            <strong style={{ fontSize: 'var(--text-lg)', fontWeight: 700 }}>Waiting for the music…</strong>
            <span style={{ fontSize: 'var(--text-md)', color: 'var(--ink-muted)' }}>Tips open with the first note.</span>
          </span>
        </section>
      ) : status.kind === 'confirmed' ? (
        <section data-testid="tip-confirmed" role="status" aria-live="polite" className="mx-5 my-4 flex flex-1 flex-col justify-center gap-4">
          <h2 style={{ fontSize: 'var(--text-hud)', fontWeight: 800, letterSpacing: '-0.03em', lineHeight: 1.05 }}>Thank you.</h2>
          <p className="num" style={{ fontSize: 'var(--text-lg)' }}>
            {formatMon(status.amountWei)} MON landed in block {formatInt(status.blockNumber)}.
          </p>
          <p data-testid="note-status" style={{ fontSize: 'var(--text-md)', color: status.note === 'failed' ? 'var(--danger)' : 'var(--ink-muted)' }}>
            {status.note === 'posting'
              ? 'Sending your note to the big screen…'
              : status.note === 'posted'
                ? 'Your tip is on the big screen.'
                : 'Your tip landed, but its note could not reach the big screen.'}
          </p>
          <p style={{ fontSize: 'var(--text-sm)', color: 'var(--ink-muted)' }}>20 % goes to the host, 80 % to the players by their notes.</p>
          <button
            type="button"
            onClick={again}
            className="min-h-[52px] self-start rounded-full px-7 py-3 font-semibold"
            style={{ fontSize: 'var(--text-md)', background: 'var(--surface-2)', border: '1px solid var(--line-strong)' }}
          >
            Send another tip
          </button>
        </section>
      ) : (
        <form
          className="mx-5 my-2 flex flex-1 flex-col gap-5"
          onSubmit={(e) => {
            e.preventDefault();
            if (!sendDisabled) void sendTip();
          }}
        >
          <fieldset className="flex flex-col gap-2" disabled={sending}>
            <legend className="mb-2" style={{ fontSize: 'var(--text-md)', fontWeight: 600 }}>
              Amount
            </legend>
            <div className="grid grid-cols-5 gap-2">
              {TIP_AMOUNTS_MON.map((a) => {
                const checked = a === amount;
                const disabled = !affordable(a);
                return (
                  <label
                    key={a}
                    className="flex min-h-[56px] cursor-pointer flex-col items-center justify-center rounded-[var(--radius-control)] text-center has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-40 has-[:focus-visible]:outline has-[:focus-visible]:outline-[3px] has-[:focus-visible]:outline-offset-2"
                    style={{
                      background: checked ? 'var(--track-hat)' : 'var(--surface-2)',
                      color: checked ? 'var(--ink-on-track)' : 'var(--ink)',
                      border: `1px solid ${checked ? 'var(--track-hat)' : 'var(--line-strong)'}`,
                    }}
                  >
                    <input type="radio" name="amount" value={a} checked={checked} disabled={disabled} onChange={() => setAmount(a)} className="sr-only" aria-label={`${a} MON`} />
                    <span className="num font-bold" style={{ fontSize: 'var(--text-md)', fontFamily: 'var(--font-mono)' }}>
                      {a}
                    </span>
                    <span aria-hidden="true" style={{ fontSize: 'var(--text-xs)' }}>
                      MON
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>

          <label className="flex flex-col gap-1.5" style={{ fontSize: 'var(--text-md)', fontWeight: 600 }}>
            Your name <span style={{ fontSize: 'var(--text-sm)', color: 'var(--ink-muted)', fontWeight: 400 }}>optional, shown on the big screen</span>
            <input
              type="text"
              value={name}
              maxLength={NOTE_NAME_MAX}
              autoComplete="nickname"
              enterKeyHint="next"
              disabled={sending}
              onChange={(e) => setName(e.currentTarget.value)}
              className="min-h-[48px] rounded-[var(--radius-control)] px-4"
              style={{ fontSize: 'var(--text-md)', fontWeight: 400, background: 'var(--surface-2)', border: '1px solid var(--line-strong)', color: 'var(--ink)' }}
            />
          </label>

          <label className="flex flex-col gap-1.5" style={{ fontSize: 'var(--text-md)', fontWeight: 600 }}>
            <span className="flex items-baseline justify-between gap-3">
              <span>
                Message <span style={{ fontSize: 'var(--text-sm)', color: 'var(--ink-muted)', fontWeight: 400 }}>optional</span>
              </span>
              <span data-testid="message-count" className="num" style={{ fontSize: 'var(--text-xs)', color: 'var(--ink-muted)', fontWeight: 400 }}>
                {[...message].length} / {NOTE_MESSAGE_MAX}
              </span>
            </span>
            <textarea
              value={message}
              maxLength={NOTE_MESSAGE_MAX}
              rows={3}
              disabled={sending}
              onChange={(e) => setMessage(e.currentTarget.value)}
              className="rounded-[var(--radius-control)] px-4 py-3"
              style={{ fontSize: 'var(--text-md)', fontWeight: 400, background: 'var(--surface-2)', border: '1px solid var(--line-strong)', color: 'var(--ink)', resize: 'none' }}
            />
          </label>

          <div className="mt-auto flex flex-col gap-2 pb-4">
            {status.kind === 'error' && (
              <p role="alert" style={{ fontSize: 'var(--text-md)', color: 'var(--danger)' }}>
                {status.message}
              </p>
            )}
            {finalized && (
              <p style={{ fontSize: 'var(--text-sm)', color: 'var(--ink-muted)' }}>The track is minted. Tips still reach the players.</p>
            )}
            <p data-testid="tip-funds" className="num min-h-[20px]" style={{ fontSize: 'var(--text-sm)', color: funding.error || !canPay ? 'var(--danger)' : 'var(--ink-muted)' }}>
              {fundsLine}
            </p>
            <button
              type="submit"
              disabled={sendDisabled}
              className="min-h-[60px] rounded-full px-7 py-3 font-bold disabled:opacity-50"
              style={{ fontSize: 'var(--text-lg)', background: 'var(--track-hat)', color: 'var(--ink-on-track)' }}
            >
              {sending ? `Sending ${status.amount} MON…` : 'Send tip'}
            </button>
            <p style={{ fontSize: 'var(--text-xs)', color: 'var(--ink-muted)' }}>20 % to the host, 80 % to the players by their notes. The DJ takes no tips.</p>
          </div>
        </form>
      )}
    </main>
  );
}
