'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TRACK_META, type TrackId } from '@blockbeat/shared';
import Link from 'next/link';
import { createPreviewVoice, type PreviewVoice } from '@/lib/audio/preview';
import { isTopUpEligibleBalance } from '@/lib/funding';
import { useBalance, useBurner, useDrip, useEventFeed, useHitSender, useTopUp } from '@/lib/hooks';
import { MAX_AIMED, type AimRejection, type AimResult } from '@/lib/join/aimQueue';
import { padsFor } from '@/lib/join/pads';
import { tourSteps } from '@/lib/join/tour';
import { useAimQueue, usePhoneClock, usePhonePref, useSeenFlag } from '@/lib/join/usePhone';
import { useNow } from '@/components/useNow';
import { fundingLine, topUpMessage } from './funding-line';
import { fundsPill, type PillTone } from './funds-pill';
import { hitMessage, isOutOfFunds } from './hit-message';
import { landingText, type LandingLine, type PhoneMode } from './landing-line';
import { ClaimShare } from './ClaimShare';
import { ModeBar } from './ModeBar';
import { PadGrid } from './PadGrid';
import { StepGrid, noteLabel } from './StepGrid';
import { Tour } from './Tour';
import { TrackTabs, trackTabId } from './TrackTabs';

const PILL_COLOUR: Record<PillTone, string> = {
  ok: 'var(--ink)',
  muted: 'var(--ink-muted)',
  warn: 'var(--track-snare)',
  danger: 'var(--danger)',
};
const PADS_ID = 'phone-pads';
const MODES: readonly PhoneMode[] = ['aim', 'now'];
const PREVIEW_PREF = ['on', 'off'] as const;
const NO_STEPS: ReadonlySet<number> = new Set();

/** W16: why an aimed note was refused, in the player's words (null: nothing to say). */
function rejectionText(reason: AimRejection): string | null {
  switch (reason) {
    case 'full':
      return `${MAX_AIMED} notes aimed · wait for one to land`;
    case 'no-funds':
      return 'Not enough MON for another aimed note';
    case 'no-clock':
      return 'Waiting for the block clock · try again in a second';
    case 'duplicate':
      return 'That sound is already aimed at this step';
    case 'disposed':
      return null;
  }
}

interface JoinViewProps {
  sessionId: bigint;
}

/** Short haptic tick on browsers that expose one (Android Chrome); silent elsewhere. */
function haptic(): void {
  try {
    if (typeof navigator !== 'undefined' && 'vibrate' in navigator) navigator.vibrate(12);
  } catch {
    // Vibration is a nicety; never let it break a tap.
  }
}

export function JoinView({ sessionId }: JoinViewProps) {
  const burner = useBurner();
  const { drip, loading, error, phase: dripPhase, roomFull } = useDrip(burner?.address ?? null, sessionId);
  const topUp = useTopUp(burner?.address ?? null);
  const { send } = useHitSender(sessionId);
  // One feed per phone: the live notes on the step grid, and when the host finalizes (a tap
  // after that would revert and still cost the player the full gas limit).
  const feed = useEventFeed(sessionId);
  const finalized = feed.session?.finalized ?? false;
  const tokenId = feed.session?.tokenId ?? 0n;
  const startBlock = feed.session?.startBlock ?? null;

  const [line, setLine] = useState<LandingLine>({ kind: 'idle' });
  const [lineSeq, setLineSeq] = useState(0);
  const [flash, setFlash] = useState<{ index: number; seq: number } | null>(null);
  const [inflight, setInflight] = useState(0);
  const [landedStep, setLandedStep] = useState<number | null>(null);
  /** Bumped only when a note really lands, so the grid never replays for a failed tap. */
  const [landSeq, setLandSeq] = useState(0);
  const [landedHistory, setLandedHistory] = useState<ReadonlySet<number>>(() => new Set());

  // W16: the instrument on screen (the drip's until the player picks another), the pad picked
  // for aiming, the steps armed before a pad, the mode and the preview switch.
  const [chosenTrack, setChosenTrack] = useState<TrackId | null>(null);
  const [selectedPad, setSelectedPad] = useState<number | null>(null);
  const [armed, setArmed] = useState<ReadonlySet<number>>(NO_STEPS);
  const [mode, setMode] = usePhonePref<PhoneMode>('mode', MODES, 'now');
  const [previewPref, setPreviewPref] = usePhonePref('preview', PREVIEW_PREF, 'on');
  const preview = previewPref === 'on';

  const assigned = drip ? TRACK_META[drip.track] : undefined;
  const track = assigned ? TRACK_META[chosenTrack ?? assigned.id] : undefined;
  const pads = padsFor(track?.id ?? 0);
  const ready = Boolean(track) && !loading && !error;
  const warming = !error && !ready;
  const padsEnabled = ready && !finalized;
  const aiming = mode === 'aim';
  // W12: the balance is read once the drip is spendable and again after every landed hit.
  // W19: a phone turned away by a full room still reads its balance.
  const balance = useBalance(burner?.address ?? null, sessionId, ready || roomFull, landSeq > 0);
  /** Set when the node refused a hit for funds; cleared when a later hit lands. */
  const [forcedOut, setForcedOut] = useState(false);
  const funds = forcedOut ? 'out' : balance.level;
  const countdownActive = dripPhase?.kind === 'settling' || topUp.phase?.kind === 'settling';
  const now = useNow(countdownActive, 100);
  const fundingText = warming ? fundingLine(dripPhase, 'drip', now) : fundingLine(topUp.phase, 'topUp', now);
  const toppingUp = topUp.phase !== null;
  const noTopUpsLeft = topUp.topUpsLeft === 0 || topUp.error?.code === 'TOPUP_LIMIT_REACHED';
  const topUpOpen = balance.balanceWei !== null && isTopUpEligibleBalance(balance.balanceWei);

  const clock = usePhoneClock(startBlock);

  // W16 follow-up: the first-visit tour opens by itself once the phone can play (pads live), and
  // again from How to play. Closing it (Skip or the last step) is remembered on this phone.
  const tour = useSeenFlag('tour');
  const [tourReplay, setTourReplay] = useState(false);
  const helpRef = useRef<HTMLButtonElement | null>(null);
  const tourOpen = tourReplay || (padsEnabled && tour.seen === false);
  const closeTour = (): void => {
    tour.markSeen();
    // Opened from How to play: give focus back to it (Safari never focused it on the tap).
    if (tourReplay) helpRef.current?.focus();
    setTourReplay(false);
  };
  const steps = useMemo(() => tourSteps({ startTrack: assigned?.label ?? 'your instrument' }), [assigned?.label]);

  const say = useCallback((next: LandingLine) => {
    setLine(next);
    setLineSeq((n) => n + 1);
  }, []);

  const landedAt = useCallback((step: number) => {
    setForcedOut(false);
    setLandedStep(step);
    setLandSeq((n) => n + 1);
    setLandedHistory((prev) => (prev.has(step) ? prev : new Set(prev).add(step)));
  }, []);

  // The queue settles notes from its own event; read the balance through a ref so the callback stays stable.
  const balanceRef = useRef(balance);
  useEffect(() => {
    balanceRef.current = balance;
  }, [balance]);
  const onAimResult = useCallback(
    (result: AimResult) => {
      balanceRef.current.refresh();
      if (result.ok) {
        landedAt(result.landedStep);
        say({ kind: 'aimed', text: result.text, blockNumber: result.landedBlock, latencyMs: result.latencyMs });
      } else {
        if (isOutOfFunds(result.error)) setForcedOut(true);
        say({ kind: 'failed', message: hitMessage(result.error, { notesLeft: balanceRef.current.notesLeft }) });
      }
    },
    [landedAt, say],
  );
  const budget = balance.notesLeft === null ? null : Math.max(0, balance.notesLeft - inflight);
  const aimQ = useAimQueue({ clock, send, startBlock, budget, onResult: onAimResult });

  // W16: the preview voice is created on the first pad tap (a user gesture) and closed on unmount.
  const voice = useRef<PreviewVoice | null>(null);
  useEffect(
    () => () => {
      voice.current?.dispose();
      voice.current = null;
    },
    [],
  );
  const playPreview = (t: TrackId, note: number): void => {
    if (!preview) return;
    voice.current ??= createPreviewVoice();
    voice.current.play(t, note);
  };

  const tapNow = async (t: TrackId, note: number) => {
    setInflight((n) => n + 1);
    setLine({ kind: 'sending' });
    const sentAt = clock.position?.() ?? null;
    try {
      const receipt = await send(t, note);
      // A Tap now landing teaches the aim lead too.
      if (sentAt !== null) aimQ.recordInclusion(sentAt, receipt.blockNumber);
      balance.refresh();
      landedAt(receipt.step);
      say({ kind: 'landed', receipt });
    } catch (err) {
      if (isOutOfFunds(err)) setForcedOut(true);
      balance.refresh();
      say({ kind: 'failed', message: hitMessage(err, { notesLeft: balance.notesLeft }) });
    } finally {
      setInflight((n) => n - 1);
    }
  };

  /** Aims the pad at each step; stops at the first refusal and says why. */
  const aimAt = (steps: readonly number[], padIndex: number): void => {
    const pad = pads[padIndex];
    if (!track || !pad) return;
    for (const step of steps) {
      const r = aimQ.aim({ track: track.id, note: pad.note, step });
      if (!r.ok) {
        const text = rejectionText(r.reason);
        if (text) say({ kind: 'notice', message: text });
        return;
      }
    }
  };

  const onPad = (index: number) => {
    const pad = pads[index];
    if (!track || !pad) return;
    haptic();
    playPreview(track.id, pad.note);
    setFlash((f) => ({ index, seq: (f?.seq ?? 0) + 1 }));
    if (!aiming) {
      void tapNow(track.id, pad.note);
      return;
    }
    if (armed.size > 0) {
      aimAt([...armed].sort((a, b) => a - b), index);
      setArmed(NO_STEPS);
      setSelectedPad(index);
      return;
    }
    setSelectedPad((p) => (p === index ? null : index));
  };

  const onStep = (step: number) => {
    if (!track) return;
    const pad = selectedPad === null ? undefined : pads[selectedPad];
    if (selectedPad === null || !pad) {
      if (!armed.has(step) && armed.size + aimQ.state.items.length >= MAX_AIMED) {
        say({ kind: 'notice', message: rejectionText('full') ?? '' });
        return;
      }
      setArmed((prev) => {
        const next = new Set(prev);
        if (next.has(step)) next.delete(step);
        else next.add(step);
        return next;
      });
      return;
    }
    // The same sound on a step it is already aimed at: tapping again takes it back.
    const waiting = aimQ.state.items.find((i) => i.step === step && i.track === track.id && i.note === pad.note && i.status === 'waiting');
    if (waiting) {
      aimQ.cancel(waiting.id);
      return;
    }
    aimAt([step], selectedPad);
  };

  const chooseMode = (next: PhoneMode) => {
    setMode(next);
    setArmed(NO_STEPS);
  };

  const requestTopUp = async () => {
    const ok = await topUp.topUp();
    if (ok) setForcedOut(false);
    balance.refresh();
  };

  const accent = track?.colour ?? 'var(--surface-3)';
  const pill = fundsPill({
    error: Boolean(error),
    finalized,
    warming,
    restored: burner?.restored ?? false,
    funding: fundingText,
    balanceWei: balance.balanceWei,
    notesLeft: balance.notesLeft,
    forcedOut,
  });
  const showFundsBanner = ready && !finalized && (funds === 'low' || funds === 'out' || toppingUp);
  const topUpNote = topUp.error ? topUpMessage(topUp.error.code) : !topUpOpen && !noTopUpsLeft ? topUpMessage('BALANCE_NOT_LOW') : null;
  const queued = aimQ.state.items;

  return (
    <main
      className="flex h-dvh w-full flex-col"
      style={{
        background: track ? `linear-gradient(to bottom, color-mix(in srgb, ${accent} 16%, var(--stage)), var(--stage) 38%)` : 'var(--stage)',
        paddingTop: 'env(safe-area-inset-top)',
        paddingBottom: 'env(safe-area-inset-bottom)',
      }}
    >
      <div aria-hidden="true" className="h-[6px] w-full" style={{ background: track ? accent : 'var(--surface-3)', boxShadow: track ? `0 0 18px ${accent}` : 'none' }} />
      <header className="flex flex-col px-4 pb-2 pt-2">
        <div className="flex items-center justify-between gap-3">
          <span className="num" style={{ fontSize: 'var(--text-sm)', color: 'var(--ink-muted)' }}>
            Blockbeat · session {sessionId.toString()}
          </span>
          <span
            data-testid="funds-pill"
            data-tone={pill.tone}
            role="status"
            aria-live="polite"
            className="num shrink-0 rounded-full px-3 py-1"
            style={{
              fontSize: 'var(--text-xs)',
              fontWeight: pill.tone === 'muted' ? 400 : 600,
              background: 'var(--surface-2)',
              color: PILL_COLOUR[pill.tone],
              border: `1px solid ${pill.tone === 'warn' || pill.tone === 'danger' ? PILL_COLOUR[pill.tone] : 'var(--line)'}`,
            }}
          >
            {pill.text}
          </span>
        </div>
        <div className="mt-1 flex items-baseline gap-3">
          <h1
            data-testid="track-name"
            style={{
              fontSize: 'var(--text-hud-lg)',
              fontWeight: 800,
              letterSpacing: '-0.035em',
              lineHeight: 1,
              color: track ? accent : 'var(--ink-muted)',
              overflowWrap: 'anywhere',
            }}
          >
            {track ? track.label : roomFull ? 'Watching' : error ? 'Not funded' : 'Warming up'}
          </h1>
          <span style={{ fontSize: 'var(--text-sm)', color: 'var(--ink-muted)' }}>
            {track ? (finalized ? 'you played' : assigned && track.id !== assigned.id ? `you started on ${assigned.label}` : 'your instrument') : roomFull ? 'the room is full' : error ? 'No instrument yet' : 'Assigning your instrument'}
          </span>
        </div>
      </header>

      {showFundsBanner && (
        <section
          data-testid="funds-banner"
          data-level={funds}
          role="alert"
          className="mx-3 mb-2 flex items-center justify-between gap-3 rounded-[var(--radius-control)] px-3 py-2"
          style={{ background: 'var(--surface-1)', border: `1px solid ${funds === 'out' ? 'var(--danger)' : 'var(--track-snare)'}` }}
        >
          {/* W12: one compact row, so the pads keep their height on a small phone. */}
          <div className="flex min-w-0 flex-col" style={{ lineHeight: 1.25 }}>
            <strong style={{ fontSize: 'var(--text-sm)', color: funds === 'out' ? 'var(--danger)' : 'var(--track-snare)' }}>
              {funds === 'out' ? 'Out of MON' : 'Almost out of MON'}
            </strong>
            <span data-testid="top-up-note" style={{ fontSize: 'var(--text-xs)', color: 'var(--ink-muted)' }}>
              {topUpNote ?? (funds === 'out' ? 'No MON left for another note.' : 'A note costs about 0.01 MON.')}
            </span>
          </div>
          {!noTopUpsLeft && (
            <button
              type="button"
              onClick={() => void requestTopUp()}
              disabled={toppingUp || !topUpOpen}
              className="min-h-[44px] shrink-0 rounded-full px-4 py-2 font-semibold disabled:opacity-60"
              style={{ fontSize: 'var(--text-sm)', background: 'var(--ink)', color: 'var(--ink-on-track)' }}
            >
              {toppingUp ? 'Topping up…' : 'Top up'}
            </button>
          )}
        </section>
      )}

      {roomFull ? (
        <section
          role="status"
          aria-label="The room is full"
          data-testid="room-full"
          className="mx-5 my-4 flex flex-1 flex-col justify-center gap-3 rounded-[var(--radius-pad)] p-6"
          style={{ background: 'var(--surface-1)', border: '1px solid var(--line-strong)' }}
        >
          <h2 style={{ fontSize: 'var(--text-lg)', fontWeight: 600 }}>The room is full: watch the big screen</h2>
          <p style={{ fontSize: 'var(--text-md)', color: 'var(--ink-muted)' }}>
            Every seat in this session has a wallet already. The music on the big screen is the room playing; the next session has room again.
          </p>
          <p style={{ fontSize: 'var(--text-md)' }}>You can still tip the song: scan the Tips code on the big screen.</p>
        </section>
      ) : error ? (
        <section
          role="alert"
          className="mx-5 my-4 flex flex-1 flex-col justify-center gap-3 rounded-[var(--radius-pad)] p-6"
          style={{ background: 'var(--surface-1)', border: '1px solid var(--danger)' }}
        >
          <h2 style={{ fontSize: 'var(--text-lg)', fontWeight: 600 }}>Your wallet did not get funded</h2>
          <p className="break-words" style={{ fontSize: 'var(--text-md)', color: 'var(--ink-muted)' }}>{error}</p>
          <p style={{ fontSize: 'var(--text-md)' }}>
            Check your connection and try again. If it keeps failing, the drip wallet may be empty: ask the host.
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-2 self-start rounded-full px-5 py-3 font-semibold"
            style={{ background: 'var(--ink)', color: 'var(--ink-on-track)', fontSize: 'var(--text-md)' }}
          >
            Try again
          </button>
        </section>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-2">
          {track && (
            <div data-tour="tabs">
              <TrackTabs selected={track.id} onSelect={setChosenTrack} panelId={PADS_ID} disabled={finalized} />
            </div>
          )}
          {track && !finalized && (
            <div data-tour="mode">
              <ModeBar mode={mode} onMode={chooseMode} preview={preview} onPreview={(on) => setPreviewPref(on ? 'on' : 'off')} accent={accent} />
            </div>
          )}
          <PadGrid
            id={PADS_ID}
            track={track}
            pads={pads}
            selected={selectedPad}
            aiming={aiming && padsEnabled}
            enabled={padsEnabled}
            warming={warming}
            finalized={finalized}
            compact={showFundsBanner}
            flash={flash}
            labelledBy={track ? trackTabId(track.id) : undefined}
            onPad={onPad}
          />
          <StepGrid
            clock={clock}
            startBlock={startBlock}
            hits={feed.hits}
            pattern={feed.pattern}
            headHint={feed.headHint}
            player={burner?.address ?? null}
            track={track?.id ?? null}
            queued={queued}
            armed={armed}
            landed={landedStep}
            history={landedHistory}
            landSeq={landSeq}
            accent={accent}
            aiming={aiming && padsEnabled}
            onStep={onStep}
          />
        </div>
      )}

      <footer className="flex flex-col gap-2 px-4 pb-3 pt-2">
        {/* W21b: after the mint, a human player's share of the tips, claimed with this burner. */}
        {finalized && burner && <ClaimShare sessionId={sessionId} address={burner.address} />}
        {error ? null : (
          <p
            data-testid="landing-line"
            data-tour="result"
            role="status"
            aria-live="polite"
            aria-atomic="true"
            className="num min-h-[24px]"
            style={{
              fontSize: 'var(--text-sm)',
              fontWeight: line.kind === 'landed' || line.kind === 'aimed' ? 600 : 400,
              color: line.kind === 'failed' ? 'var(--danger)' : line.kind === 'landed' || line.kind === 'aimed' ? 'var(--ink)' : 'var(--ink-muted)',
            }}
          >
            {finalized ? (
              <span className="line-pop">
                Track minted · thanks for playing{' '}
                {tokenId > 0n && (
                  <Link href={`/track/${tokenId.toString()}`} style={{ color: accent, textDecoration: 'underline', textUnderlineOffset: 4 }}>
                    Open the track
                  </Link>
                )}
              </span>
            ) : (
              <span key={lineSeq} className={line.kind === 'idle' || line.kind === 'sending' ? undefined : 'line-pop'}>
                {landingText(line, mode)}
              </span>
            )}
            {!finalized && inflight > 1 && <span style={{ color: 'var(--ink-muted)', fontWeight: 400 }}> · {inflight} in flight</span>}
          </p>
        )}
        {!error && aiming && !finalized && (
          <div className="min-h-[44px]">
            {queued.length > 0 && (
              <ol data-testid="aim-queue" aria-label="Aimed notes, in the order they go out" className="flex flex-wrap gap-[6px]">
                {queued.map((item) => {
                  const meta = TRACK_META[item.track];
                  const name = noteLabel(item.track, item.note);
                  const body = (
                    <>
                      <span className="num" style={{ fontWeight: 700 }}>
                        step {item.step}
                      </span>{' '}
                      <span>{name}</span>
                      <span className="block" style={{ fontSize: 11, color: 'var(--ink-muted)' }}>
                        {item.status === 'waiting' ? 'waiting · tap to cancel' : 'sending'}
                      </span>
                    </>
                  );
                  const chipStyle = { fontSize: 'var(--text-xs)', lineHeight: 1.15, background: 'var(--surface-1)', boxShadow: `inset 0 0 0 1px ${meta?.colour ?? 'var(--line)'}` };
                  return (
                    <li key={item.id}>
                      {item.status === 'waiting' ? (
                        <button type="button" onClick={() => aimQ.cancel(item.id)} className="min-h-[44px] rounded-[10px] px-3 py-1 text-left" style={chipStyle} aria-label={`Cancel ${name} aimed at step ${item.step}`}>
                          {body}
                        </button>
                      ) : (
                        <span className="block min-h-[44px] rounded-[10px] px-3 py-1" style={chipStyle}>
                          {body}
                        </span>
                      )}
                    </li>
                  );
                })}
              </ol>
            )}
          </div>
        )}
        {/* W21b: tips moved to their own page (/tip/[session], the stage's second QR). */}
        <div className="flex items-center justify-end gap-3">
          {/* W16: replays the first-visit tour; a labelled button, where the thumb already is. */}
          {track && !finalized && (
            <button
              ref={helpRef}
              type="button"
              onClick={() => setTourReplay(true)}
              className="flex min-h-[44px] items-center gap-2 rounded-full py-2 pl-2 pr-4 font-semibold"
              style={{ fontSize: 'var(--text-md)', color: 'var(--ink)', background: 'transparent', border: '1px solid var(--line-strong)' }}
            >
              <span
                aria-hidden="true"
                className="flex h-[26px] w-[26px] items-center justify-center rounded-full font-bold"
                style={{ fontSize: 'var(--text-sm)', background: 'var(--ink)', color: 'var(--ink-on-track)' }}
              >
                ?
              </span>
              How to play
            </button>
          )}
        </div>
      </footer>
      <Tour steps={steps} open={tourOpen} onClose={closeTour} />
    </main>
  );
}
