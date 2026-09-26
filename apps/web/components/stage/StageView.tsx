'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import type { HitEvent } from '@blockbeat/shared';
import { runtimeAddress, runtimeChain } from '@/lib/chain/clients';
import { explorerTokenLink, explorerTxLink } from '@/lib/chain/explorer';
import { HostClientError, clearHostSecret, finalizeSessionRequest, loadHostSecret, saveHostSecret, startSessionRequest, useHasHostSecret } from '@/lib/host/client';
import { useAgentDj } from '@/lib/host/useAgentDj';
import { crowdEnabled } from '@/lib/crowd/flag';
import { useCrowd } from '@/lib/crowd/useCrowd';
import type { CrowdMode } from '@/lib/crowd/client';
import { decayConfig, liveView, sameSteps } from '@/lib/decay';
import { useBlockClock, useEventFeed } from '@/lib/hooks';
import { formatMon } from '@/lib/funding';
import { markMockFinalized, useHostTips } from '@/lib/tips/claims';
import { useTipNotes } from '@/lib/tips/hooks';
import { mergeTips } from '@/lib/tips/tipList';
import { useOrigin } from '@/components/useOrigin';
import { useReducedMotion } from '@/components/useReducedMotion';
import { AudioControls } from './AudioControls';
import { AudioOverlay } from './AudioOverlay';
import { FinalizeOverlay, type FinalizeSummary } from './FinalizeOverlay';
import { Grid, type CellFlash } from './Grid';
import { CrowdPanel } from './CrowdPanel';
import { DjPanel } from './DjPanel';
import { HostControls } from './HostControls';
import { Hud } from './Hud';
import { Legend } from './Legend';
import { StageQrs } from './StageQrs';
import { TipsPanel } from './TipsPanel';
import { useJoinQrVisible } from './useJoinQrVisible';
import { agentLiveCells, cellFades, cellKey, trackCellCounts } from './grid-model';
import { linkStatus } from './link-status';
import { stageWarnings } from './join-url';
import { useStageAudio } from './useStageAudio';

const AGENT_ADDRESS = process.env.NEXT_PUBLIC_AGENT_ADDRESS;
/** W13: note lifetime and voice cap (NEXT_PUBLIC_NOTE_LIFETIME_BARS / NEXT_PUBLIC_MAX_LIVE_PER_TRACK). */
const DECAY = decayConfig();

/** Stable identity for a hit regardless of how the feed allocates objects. */
function hitKey(hit: HitEvent): string {
  return `${hit.txHash}:${hit.logIndex}`;
}

const JOIN_BASE_URL = process.env.NEXT_PUBLIC_JOIN_BASE_URL?.trim().replace(/\/+$/, '') ?? '';
const TIP_TOTALS = { tipTotals: true } as const;

interface StageViewProps {
  sessionId: bigint;
  /** W15: the URL had `?host=1` (the page reads it on the server). */
  hostRequested?: boolean;
}

export function StageView({ sessionId, hostRequested = false }: StageViewProps) {
  // W13: the feed keeps the Hit history of the live window; the live layer is derived from it.
  // W21b: the stage reads the chain's tip totals (totalTipsOf, TipSplit) for Raised by this song.
  const feed = useEventFeed(sessionId, 'window', TIP_TOTALS);
  const clock = useBlockClock(feed.session?.startBlock ?? null);
  const origin = useOrigin();
  const router = useRouter();
  const reducedMotion = useReducedMotion();
  // What the room sees (at the head) and hears. `feed.pattern` stays the RECORDED pattern (the NFT).
  const live = useMemo(() => liveView(feed.hits, feed.pattern, clock.currentBlock, DECAY), [feed.hits, feed.pattern, clock.currentBlock]);
  // The engine schedules a step just before its block arrives, so it plays the notes alive on the
  // next block: a note is heard exactly 8 times, never a ninth (architect review). Value-stable
  // between blocks so the engine is only handed a new pattern when a note appears or goes.
  const nextSteps = useMemo(() => liveView(feed.hits, feed.pattern, clock.currentBlock + 1n, DECAY).steps, [feed.hits, feed.pattern, clock.currentBlock]);
  // Adjusting state during render on purpose: one extra render when a note appears or goes, and
  // the engine never sees a stale pattern for a frame (an effect would lag one commit behind).
  const [audioPattern, setAudioPattern] = useState<bigint[]>(nextSteps);
  if (!sameSteps(audioPattern, nextSteps)) setAudioPattern(nextSteps);
  const audio = useStageAudio({ pattern: audioPattern, lastHit: feed.lastHit, everyHitSounds: live.decay });
  const audioStarted = audio.started;

  const [audioStarting, setAudioStarting] = useState(false);
  /** Once audio ran, a later overlay means the system suspended the context. */
  const [audioEverStarted, setAudioEverStarted] = useState(false);
  const [audioError, setAudioError] = useState<string | null>(null);
  const [hostStatus, setHostStatus] = useState<string | null>(null);
  const [hostBusy, setHostBusy] = useState(false);
  // External-store read: the server cannot see sessionStorage and the secret input's
  // presence changes the DOM, so a useState initializer would mismatch on hydration.
  const hasSecret = useHasHostSecret();
  // W12: the resident DJ runs as a child of the laptop's web server; polled only with a secret.
  const dj = useAgentDj(hasSecret);
  const djUnauthorized = dj.error?.status === 401 && hasSecret;
  useEffect(() => {
    // A 401 means the stored secret is wrong: drop it so the field comes back (and polling stops).
    if (djUnauthorized) clearHostSecret();
  }, [djUnauthorized]);
  // W19: simulated players, a child of the laptop's web server like the DJ; polled only with a secret.
  // The crowd simulator stays off unless NEXT_PUBLIC_CROWD_ENABLED=1 (no buttons, no panel, no polling).
  const crowdOn = crowdEnabled();
  const crowd = useCrowd(hasSecret && crowdOn);
  // Headed phone windows open on the machine that runs the server: offer them only when the stage is opened there.
  const crowdVisibleAvailable = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin);
  // W15: the host bar shows for the presenter only (a stored secret or ?host=1); the projector stays clean.
  const showHostBar = hasSecret || hostRequested;
  /** Sticky after the overlay closes, so the bar can offer "Play the track". */
  const [mintedTokenId, setMintedTokenId] = useState<bigint | null>(null);
  const [finalizeResult, setFinalizeResult] = useState<FinalizeSummary | null>(null);
  /** Sticky: closing the overlay must not re-enable the finalize button before the feed catches up. */
  const [hasFinalized, setHasFinalized] = useState(false);

  // Per-hit bookkeeping without effects: when a new hit arrives we adjust state during
  // render (React's "storing information from previous renders" pattern). The flash
  // sequence remounts the hit cell so its CSS animation replays even on the same cell.
  const [seenHitKey, setSeenHitKey] = useState<string | null>(null);
  const [flash, setFlash] = useState<CellFlash | null>(null);
  // W12: one flash per Tipped event, same render-time pattern as hits.
  const [seenTipKey, setSeenTipKey] = useState<string | null>(null);
  const [tipFlash, setTipFlash] = useState(0);
  const incomingTipKey = feed.lastTip ? `${feed.lastTip.txHash}:${feed.lastTip.logIndex}` : null;
  if (incomingTipKey !== null && incomingTipKey !== seenTipKey) {
    setSeenTipKey(incomingTipKey);
    setTipFlash((n) => n + 1);
  }
  // W21b: the latest tips (live Tipped events merged with the notes the tip page posted), the
  // join code's visibility (host bar, per tab) and the host share of tips (pulled by claimHost).
  const notes = useTipNotes(sessionId);
  const tipLines = useMemo(() => mergeTips(feed.tips, notes.notes, 3), [feed.tips, notes.notes]);
  const [joinQrVisible, setJoinQrVisible] = useJoinQrVisible();
  const hostTips = useHostTips(sessionId, showHostBar, feed.tips.length);
  const incomingKey = feed.lastHit ? hitKey(feed.lastHit) : null;
  if (feed.lastHit && incomingKey !== seenHitKey) {
    const hit = feed.lastHit;
    setSeenHitKey(incomingKey);
    setFlash({ key: cellKey(hit.step, hit.track), seq: (flash?.seq ?? 0) + 1 });
  }

  const cells = useMemo(() => trackCellCounts(live.steps), [live.steps]);
  // The agent's cells are the live ones it hit last (W13: from the history, not per-event bookkeeping).
  const agentCells = useMemo(() => agentLiveCells(live.cells, AGENT_ADDRESS), [live.cells]);
  const { fade: fades, ghost: ghosts } = useMemo(() => cellFades(live, DECAY.lifetimeBars, reducedMotion), [live, reducedMotion]);

  const chainName = runtimeChain().name;
  const qrSize = 168; // W21b: two codes side by side (play, tip) in the 500 px rail
  const joinBase = JOIN_BASE_URL || origin;
  const joinUrl = joinBase ? `${joinBase}/join/${sessionId}` : '';
  const tipUrl = joinBase ? `${joinBase}/tip/${sessionId}` : '';
  const finalized = (feed.session?.finalized ?? false) || hasFinalized;
  const knownTokenId = mintedTokenId ?? (feed.session?.finalized && feed.session.tokenId > 0n ? feed.session.tokenId : null);
  const uiLocked = !audioStarted || finalizeResult !== null;

  // The overlay only leaves once the engine confirms; a rejection keeps it up with a retry.
  const startAudio = async () => {
    setAudioStarting(true);
    setAudioError(null);
    try {
      await audio.start();
      setAudioEverStarted(true);
    } catch (err) {
      setAudioError(err instanceof Error ? err.message : 'unknown error');
    } finally {
      setAudioStarting(false);
    }
  };

  const onSecretCommit = (secret: string) => saveHostSecret(secret);
  /** A 401 means the stored secret is wrong: drop it so the field comes back. */
  const hostFailure = (what: string, err: unknown): string => {
    if (err instanceof HostClientError && err.status === 401) {
      clearHostSecret();
      return `${what} failed: wrong host secret. Type it again.`;
    }
    return `${what} failed: ${err instanceof Error ? err.message : 'unknown error'}`;
  };

  // A new round is a new session: start it with the host key and move the stage there.
  const startRound = async () => {
    setHostBusy(true);
    setHostStatus('Starting a new session…');
    try {
      const { sessionId: next } = await startSessionRequest(loadHostSecret());
      setHostStatus(`Session ${next.toString()} started`);
      router.push(`/stage/${next.toString()}`);
    } catch (err) {
      setHostStatus(hostFailure('New session', err));
    } finally {
      setHostBusy(false);
    }
  };
  const finalize = async () => {
    setHostBusy(true);
    setHostStatus('Ending the session and minting…');
    try {
      const result = await finalizeSessionRequest(loadHostSecret(), sessionId);
      setHasFinalized(true);
      setMintedTokenId(result.tokenId);
      // W21b: mock mode has no chain; the simulator (and the phones, over the bus) learn it here.
      if (result.txHash === null) markMockFinalized(sessionId, result.tokenId);
      setFinalizeResult({
        ...result,
        // Mock mode: the host route cannot count players; the stage's feed can.
        ...(result.txHash === null ? { contributors: BigInt(feed.uniquePlayers) } : {}),
        raisedWei: feed.raisedWei,
        explorerTokenUrl: result.txHash ? explorerTokenLink(runtimeAddress(), result.tokenId) : null,
        explorerTxUrl: result.txHash ? explorerTxLink(result.txHash) : null,
      });
      setHostStatus(`Minted track #${result.tokenId.toString()}`);
    } catch (err) {
      setHostStatus(hostFailure('End session and mint', err));
    } finally {
      setHostBusy(false);
    }
  };

  const claimHostTips = async () => {
    setHostStatus('Claiming the host tips…');
    try {
      const { amountWei } = await hostTips.claim(loadHostSecret());
      setHostStatus(`Host tips claimed: ${formatMon(amountWei)} MON`);
    } catch (err) {
      setHostStatus(hostFailure('Claim host tips', err));
    }
  };

  const toggleDj = async () => {
    if (dj.status?.running) {
      setHostStatus('Stopping the DJ…');
      await dj.stop();
      setHostStatus('DJ stopped');
    } else {
      setHostStatus('Starting the DJ…');
      await dj.start(sessionId);
      setHostStatus(null);
    }
  };
  const djError = dj.error ? (dj.error.status === 401 ? 'DJ: wrong host secret. Type it again.' : `DJ: ${dj.error.message}`) : null;

  const addCrowd = async (mode: CrowdMode) => {
    setHostStatus(mode === 'visible' ? 'Opening 5 simulated phones…' : 'Adding 10 simulated players…');
    await crowd.start(sessionId, mode);
    setHostStatus(null);
  };
  const stopCrowd = async () => {
    setHostStatus('Stopping the simulated players; their MON goes back to the drip');
    await crowd.stop();
    setHostStatus(null);
  };
  const crowdError = crowd.error ? (crowd.error.status === 401 ? 'Crowd: wrong host secret. Type it again.' : `Crowd: ${crowd.error.message}`) : null;

  const waiting = feed.hitCount === 0;
  const warnings = stageWarnings({ source: clock.source, joinBase, joinBaseFromEnv: JOIN_BASE_URL !== '' });
  const link = linkStatus({ source: clock.source, connected: feed.connected, msSinceHead: clock.msSinceHead, error: feed.error, chainName });
  const linkColour = link.level === 'ok' ? 'var(--ok)' : link.level === 'stale' ? 'var(--track-snare)' : 'var(--danger)';

  return (
    <main className="stage-layout relative w-full" data-host-bar={showHostBar ? 'true' : undefined} style={{ background: 'var(--stage)' }}>
      <div className="stage-ambient" aria-hidden="true" />
      {showHostBar && (
        <HostControls
          sessionId={sessionId}
          finalized={finalized}
          mintedTokenId={knownTokenId}
          busy={hostBusy}
          status={hostStatus}
          hasSecret={hasSecret}
          onSecretCommit={onSecretCommit}
          onNewSession={() => void startRound()}
          onEndAndMint={() => void finalize()}
          djRunning={dj.status?.running ?? false}
          djBusy={dj.busy}
          onToggleDj={() => void toggleDj()}
          inert={uiLocked}
          joinQrVisible={joinQrVisible}
          onToggleJoinQr={() => setJoinQrVisible(!joinQrVisible)}
          hostClaimableWei={hostTips.claimableWei}
          onClaimHost={() => void claimHostTips()}
          claimBusy={hostTips.busy}
          {...(crowdOn
            ? {
                crowd: {
                  running: crowd.status?.running ?? false,
                  stopping: crowd.status?.stopping ?? false,
                  busy: crowd.busy,
                  visibleAvailable: crowdVisibleAvailable,
                  onAdd: (mode: CrowdMode) => void addCrowd(mode),
                  onStop: () => void stopCrowd(),
                },
              }
            : {})}
        />
      )}
      <section inert={uiLocked} className="relative z-[1] flex min-w-0 flex-col gap-5 px-5 pb-6 pt-6 lg:px-10 lg:pb-8 lg:pt-7" aria-label="Sequencer">
        {warnings.map((w) => (
          <div
            key={w.id}
            role="alert"
            data-testid={`stage-warning-${w.id}`}
            className="flex flex-wrap items-baseline gap-x-4 gap-y-1 rounded-xl px-5 py-3"
            style={{ background: 'var(--danger)', color: '#fff', fontSize: 'var(--text-md)' }}
          >
            <strong style={{ fontSize: 'var(--text-lg)' }}>{w.title}</strong>
            <span>{w.detail}</span>
          </div>
        ))}
        <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
          <div className="flex items-baseline gap-5">
            <span style={{ fontSize: 'var(--text-lg)', color: 'var(--ink-muted)', fontWeight: 500 }}>Blockbeat</span>
            <h1 className="num stage-title" style={{ fontSize: 'var(--text-title)', fontWeight: 700, letterSpacing: '-0.03em', lineHeight: 1 }}>
              Session {sessionId.toString()}
            </h1>
          </div>
          <p
            data-testid="link-status"
            data-level={link.level}
            role="status"
            className="num flex items-center gap-3 rounded-full px-4 py-2"
            style={{
              fontSize: 'var(--text-md)',
              color: link.level === 'ok' ? 'var(--ink-muted)' : 'var(--ink)',
              background: 'rgba(255,255,255,0.04)',
              border: `1px solid ${link.level === 'ok' ? 'var(--line)' : linkColour}`,
            }}
          >
            <span aria-hidden="true" className="inline-block size-3 rounded-full" style={{ background: linkColour, boxShadow: `0 0 10px ${linkColour}` }} />
            {link.label}
          </p>
        </header>
        <div className="stage-grid-wrap relative min-h-0 flex-1">
          <Grid cells={cells} currentStep={clock.currentStep} flash={flash} agentCells={agentCells} fades={fades} ghosts={ghosts} />
          {waiting && (
            <div className="pointer-events-none absolute inset-x-0 bottom-[14%] flex justify-center">
              <p
                data-testid="grid-empty"
                role="status"
                className="grid-hint stage-hint flex flex-col items-center gap-2 rounded-[24px] px-10 py-6 text-center"
                style={{
                  fontSize: 'var(--text-hud-lg)',
                  fontWeight: 600,
                  letterSpacing: '-0.02em',
                  background: 'rgba(5, 5, 7, 0.78)',
                  border: '1px solid var(--line-strong)',
                  backdropFilter: 'blur(6px)',
                  boxShadow: '0 30px 80px -20px rgba(0,0,0,0.9)',
                }}
              >
                Waiting for the first note…
                <span style={{ fontSize: 'var(--text-lg)', fontWeight: 400, color: 'var(--ink-muted)' }}>
                  Scan the code, tap a pad. Your note lands on the next block.
                </span>
              </p>
            </div>
          )}
        </div>
      </section>

      <aside
        inert={uiLocked}
        className="stage-rail relative z-[1] flex flex-col justify-between gap-3 px-5 pb-4 pt-4 lg:px-8 lg:pt-5"
        style={{ background: 'color-mix(in srgb, var(--surface-1) 88%, transparent)', borderLeft: '1px solid var(--line)', backdropFilter: 'blur(10px)' }}
        aria-label="Join and statistics"
      >
        <StageQrs sessionId={sessionId} joinUrl={joinUrl} tipUrl={tipUrl} joinVisible={joinQrVisible} size={qrSize} />
        <TipsPanel raisedWei={feed.raisedWei} lines={tipLines} flash={tipFlash} />

        <Hud
          currentBlock={clock.currentBlock}
          hitCount={feed.hitCount}
          liveNotes={live.decay ? live.count : null}
          hitsPerMinute={feed.hitsPerMinute}
          avgLatencyMs={feed.avgLatencyMs}
          uniquePlayers={feed.uniquePlayers}
          measuredBlockMs={clock.measuredBlockMs}
        />

        <div className="flex flex-col gap-3">
          <Legend />
          <div className="flex flex-col gap-2">
            <div className="self-end">
              <AudioControls muted={audio.muted} onMutedChange={audio.setMuted} volume={audio.volume} onVolumeChange={audio.setVolume} />
            </div>
            {/* The room sees the DJ at work; W15 moved its controls to the host bar. */}
            <DjPanel status={dj.status} error={djError} />
            {/* W19: host only; the projector never shows the simulator's controls or numbers. */}
            {showHostBar && crowdOn && <CrowdPanel status={crowd.status} error={crowdError} />}
          </div>
        </div>
      </aside>

      {!audioStarted && <AudioOverlay onStart={() => void startAudio()} error={audioError} starting={audioStarting} resume={audioEverStarted} />}
      {audioStarted && finalizeResult && <FinalizeOverlay result={finalizeResult} onClose={() => setFinalizeResult(null)} />}
    </main>
  );
}
