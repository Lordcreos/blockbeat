/**
 * W19 visible mode (`crowd -- --ui`): up to 6 HEADED phone windows on the laptop that play
 * through the real join page, so the room (and the presenter) can watch simulated players tap.
 * The real drip funds each phone (it exercises /api/drip and its room cap); every window skips
 * the tour, waits for "Wallet ready", picks its persona's instrument tab and aims pads on steps
 * in Aim mode on the persona's schedule, one bar ahead (the phone times the send itself).
 *
 * Independent of Playwright (the `Phone` driver is injected), so the schedule, the stops and the
 * key handling are unit tested. Each phone's burner key is read from its page as soon as it is
 * funded and saved to the keystore; at the end the windows close and the burners are swept back
 * to the drip wallet (a fresh browser profile would lose them otherwise).
 */
import { formatEther, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { BAR_MS, HIT_GAS_LIMIT, HIT_GAS_LIMIT_FIRST, TRACK_META } from '@blockbeat/shared';
import { classifyRpcError } from '../../stats';
import { CHARGED_GAS_PRICE_WEI, notesPerPlayerFor, projectCost } from '../budget';
import { assertPlayable, CrowdAbortError, formatMon, type CrowdChain, type StopReason, type SweepResult } from '../engine';
import type { Keystore } from '../keystore';
import { planCrowd, type Persona, type PlannedNote } from '../persona';

export const MAX_VISIBLE_PHONES = 6;
/** The drip gives a phone 0.3 MON, about 28 notes; keep a margin for the first-note tier. */
export const MAX_VISIBLE_NOTES_PER_PLAYER = 24;
export const PADS_PER_TRACK = 8;

/** How the phones play: Tap now (default, what most people do) or Aim. */
export type PlayMode = 'tap' | 'aim';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One headed phone on the join page (Playwright in production, a fake in tests). */
export interface Phone {
  /** Resolves once the drip funded the wallet (the pads are live) or the room turned it away. */
  waitReady(timeoutMs: number): Promise<'ready' | 'room-full'>;
  /** Clicks "Skip tour" when the first-visit tour opens; false when it did not show. */
  skipTour(timeoutMs: number): Promise<boolean>;
  pickInstrument(label: string): Promise<void>;
  /** The phone's mode bar: "Tap now" (the next block decides the step) or "Aim". */
  setMode(mode: PlayMode): Promise<void>;
  /** Tap now: one tap on pad `padIndex` sends at once. */
  tap(padIndex: number): Promise<void>;
  /** Aim mode: pick pad `padIndex`, then tap step `step`. */
  aim(padIndex: number, step: number): Promise<void>;
  /** The page's burner key, as soon as the page has made it (before any drip). */
  burnerKey(): Promise<Hex | null>;
  close(): Promise<void>;
  /** Optional: a PNG of the page (evidence). */
  screenshot?(path: string): Promise<void>;
}

export interface VisibleDeps {
  openPhone(url: string, rect: Rect, index: number): Promise<Phone>;
  chain: Pick<CrowdChain, 'getSession' | 'watchHits' | 'watchFinalized'>;
  /** Sweeps the burners saved in the keystore back to the drip wallet. */
  sweep(): Promise<SweepResult>;
}

export interface VisibleOptions {
  chainId: number;
  contract: Address;
  sessionId: bigint;
  players: number;
  minutes: number;
  /** The phones open `${baseUrl}/join/<session>`. */
  baseUrl: string;
  seed: number;
  maxWei: bigint;
  /** The drip wallet: where the burners are swept back to. */
  funder: Address;
  keystore: Keystore;
  log: (line: string) => void;
  signal?: AbortSignal;
  onSecret?: (key: Hex) => void;
  barMs?: number;
  joinWindowMs?: number;
  readyTimeoutMs?: number;
  /** Wait after the stop for notes already aimed to land (default 3 s). */
  settleMs?: number;
  sessionCheckMs?: number;
  screen?: { width: number; height: number };
  /** Evidence: every ready phone saves `${snapshotDir}/phone-<n>.png` when this bar starts. */
  snapshotAtBar?: number;
  snapshotDir?: string;
  /** Default 'tap'. */
  playMode?: PlayMode;
}

export interface VisibleResult {
  startedAt: string;
  durationMs: number;
  stopReason: StopReason;
  playMode: PlayMode;
  personas: Persona[];
  opened: number;
  ready: number;
  roomFull: number;
  aimed: number;
  landed: number;
  onStep: number;
  spentWeiEstimate: bigint;
  statusLines: string[];
  keystoreFile: string;
  sweep: SweepResult;
}

/** A 3-column grid for up to 6 windows (2 rows), each as tall as the screen allows. */
export function tileWindows(n: number, screen: { width: number; height: number }): Rect[] {
  if (!Number.isInteger(n) || n < 1 || n > MAX_VISIBLE_PHONES) throw new RangeError(`visible phones must be 1..${MAX_VISIBLE_PHONES}, got ${n}`);
  const cols = Math.min(3, n);
  const rows = Math.ceil(n / cols);
  const width = Math.floor(screen.width / cols);
  const height = Math.floor(screen.height / rows);
  return Array.from({ length: n }, (_, i) => ({ x: (i % cols) * width, y: Math.floor(i / cols) * height, width, height }));
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

export async function runVisibleCrowd(opts: VisibleOptions, deps: VisibleDeps): Promise<VisibleResult> {
  const { log } = opts;
  const startedAtMs = Date.now();
  const barMs = opts.barMs ?? BAR_MS;
  const playMode: PlayMode = opts.playMode ?? 'tap';
  const rects = tileWindows(opts.players, opts.screen ?? { width: 1512, height: 982 });
  assertPlayable(opts.sessionId, await deps.chain.getSession(opts.sessionId));

  const bars = Math.max(1, Math.round((opts.minutes * 60_000) / barMs));
  const notesPerPlayer = Math.min(MAX_VISIBLE_NOTES_PER_PLAYER, notesPerPlayerFor(opts.maxWei, opts.players));
  const plan = planCrowd({ seed: opts.seed, players: opts.players, bars, notesPerPlayer, ...(opts.joinWindowMs !== undefined ? { joinWindowMs: opts.joinWindowMs } : {}), barMs });
  const projection = projectCost(plan);
  log(`crowd --ui: session ${opts.sessionId.toString()}, ${opts.players} visible phones for ${bars} bars, up to ${notesPerPlayer} notes each; the drip funds each phone`);
  log(`projected: ${projection.notes} notes ≤ ${formatEther(projection.hitsWei)} MON of hits (budget ${formatEther(opts.maxWei)}); the drip parks its usual amount on each phone and the sweep returns what is left`);
  if (projection.notes === 0) throw new CrowdAbortError('the plan has no notes: raise --max-mon or --minutes');
  if (projection.hitsWei > opts.maxWei) throw new CrowdAbortError(`projected cost ${formatEther(projection.hitsWei)} MON exceeds --max-mon ${formatEther(opts.maxWei)}`);

  const keystoreFile = opts.keystore.create({ chainId: opts.chainId, contract: opts.contract, sessionId: opts.sessionId, funder: opts.funder, players: [] });
  log(`keys: each phone's burner is saved to ${keystoreFile} (mode 600) once funded; if anything fails, run: pnpm --filter scripts crowd -- --sweep-only`);

  let stopReason: StopReason | null = null;
  const stop = (why: StopReason): void => {
    if (stopReason !== null) return;
    stopReason = why;
    log(`crowd --ui: stopping (${why === 'finalized' ? 'the session was finalized' : why === 'stopped' ? 'stop requested' : 'time is up'})`);
  };
  const onAbort = (): void => stop('stopped');
  if (opts.signal?.aborted) stop('stopped');
  opts.signal?.addEventListener('abort', onAbort);
  const stopFinalized = deps.chain.watchFinalized(opts.sessionId, () => stop('finalized'));

  // Landings of our phones, from the session's Hit logs: aimed steps per player, oldest first.
  const byAddress = new Map<string, { persona: Persona; aimedSteps: number[]; landed: number }>();
  let aimed = 0;
  let landed = 0;
  let onStep = 0;
  let spentWeiEstimate = 0n;
  const stopHits = deps.chain.watchHits(opts.sessionId, (hit) => {
    const mine = byAddress.get(hit.player.toLowerCase());
    if (!mine) return;
    landed += 1;
    spentWeiEstimate += (mine.landed === 0 ? HIT_GAS_LIMIT_FIRST : HIT_GAS_LIMIT) * CHARGED_GAS_PRICE_WEI;
    mine.landed += 1;
    const at = mine.aimedSteps.indexOf(hit.step);
    if (at >= 0) {
      onStep += 1;
      mine.aimedSteps.splice(at, 1);
    } else {
      mine.aimedSteps.shift();
    }
  });

  const phones: Phone[] = [];
  const readyPhones: Array<{ phone: Phone; index: number }> = [];
  let opened = 0;
  let ready = 0;
  let roomFull = 0;
  let playStart: number | null = null;
  const barNow = (): number => (playStart === null ? -1 : Math.floor((Date.now() - playStart) / barMs));
  const url = `${opts.baseUrl.replace(/\/+$/, '')}/join/${opts.sessionId.toString()}`;

  const playPhone = async (persona: Persona, index: number): Promise<void> => {
    await sleep(startedAtMs + persona.joinAtMs - Date.now());
    if (stopReason !== null) return;
    const rect = rects[index];
    if (!rect) return;
    const phone = await deps.openPhone(url, rect, index);
    phones.push(phone);
    opened += 1;
    // The page makes its burner on load. Save it BEFORE the drip funds it: a phone that is funded
    // but never seen ready (or a crash) must still be swept (0.6 MON were lost to this on testnet).
    const key = await phone.burnerKey();
    if (key !== null) {
      opts.onSecret?.(key);
      const address = privateKeyToAccount(key).address;
      opts.keystore.append(keystoreFile, { address, privateKey: key });
      byAddress.set(address.toLowerCase(), { persona, aimedSteps: [], landed: 0 });
    } else {
      log(`phone ${index + 1}: no burner key in its page; its MON cannot be swept, so it will not ask the drip`);
      await phone.close();
      return;
    }
    const outcome = await phone.waitReady(opts.readyTimeoutMs ?? 90_000);
    if (outcome === 'room-full') {
      roomFull += 1;
      log(`phone ${index + 1}: the room is full; closing it`);
      await phone.close();
      return;
    }
    await phone.skipTour(5_000);
    const label = TRACK_META[persona.track]?.label ?? 'Kick';
    await phone.pickInstrument(label);
    await phone.setMode(playMode);
    ready += 1;
    readyPhones.push({ phone, index });
    if (playStart === null) playStart = Date.now();
    log(`phone ${index + 1}: ${label}, ${persona.style}, ready`);
    const notes = plan.notes.filter((n) => n.player === persona.id);
    const entry = byAddress.get(privateKeyToAccount(key).address.toLowerCase());
    for (const bar of [...new Set(notes.map((n) => n.bar))]) {
      if (bar < barNow()) continue;
      if (playMode === 'aim') {
        // One bar ahead: the phone aims each note at the next time its step comes round.
        await sleep((playStart ?? Date.now()) + (bar - 1) * barMs - Date.now());
        for (const note of notes.filter((n: PlannedNote) => n.bar === bar)) {
          if (stopReason !== null) return;
          await phone.aim(note.note % PADS_PER_TRACK, note.step);
          aimed += 1;
          entry?.aimedSteps.push(note.step);
        }
        continue;
      }
      // Tap now: tap at the note's place in the bar, like a person keeping the rhythm; the next
      // block decides the step (the phone's clock is not the chain's, so no on-step claim).
      for (const note of notes.filter((n: PlannedNote) => n.bar === bar)) {
        await sleep((playStart ?? Date.now()) + bar * barMs + (note.step * barMs) / 16 - Date.now());
        if (stopReason !== null) return;
        await phone.tap(note.note % PADS_PER_TRACK);
        aimed += 1;
      }
      if (stopReason !== null) return;
    }
  };

  const statusLines: string[] = [];
  const statusLine = (bar: number): string => {
    const active = plan.personas.filter((p) => bar >= p.joinBar && bar < (p.leaveBar ?? bars)).length;
    const ratio = landed === 0 ? 0 : Math.round((100 * onStep) / landed);
    return `crowd | bar ${bar + 1}/${bars} | players ${Math.min(active, ready)}/${opts.players} | sent ${aimed} | confirmed ${landed} | on-step ${ratio}% | spent ${formatMon(spentWeiEstimate)} MON`;
  };

  let sweep: SweepResult = { sweptWei: 0n, failed: [], skippedRuns: 0 };
  try {
    let tasksLeft = plan.personas.length;
    const tasks = plan.personas.map((persona, i) =>
      playPhone(persona, i)
        .catch((error: unknown) => {
          log(`phone ${i + 1}: ${classifyRpcError(error).message}`);
        })
        .finally(() => {
          tasksLeft -= 1;
        }),
    );
    // Hard end: the join window, one ready wait and the whole set, even if no phone ever played.
    const deadline = startedAtMs + (opts.joinWindowMs ?? 20_000) + (opts.readyTimeoutMs ?? 90_000) + (bars + 1) * barMs;
    const sessionCheckMs = opts.sessionCheckMs ?? 5_000;
    let lastCheck = Date.now();
    let lastBar = -1;
    while (stopReason === null) {
      const bar = barNow();
      if (bar > lastBar) {
        if (bar === opts.snapshotAtBar && opts.snapshotDir) {
          const dir = opts.snapshotDir;
          await Promise.all(
            readyPhones.map(({ phone, index }) =>
              phone.screenshot?.(`${dir}/phone-${index + 1}.png`).catch((error: unknown) => {
                log(`phone ${index + 1}: snapshot failed (${classifyRpcError(error).message})`);
              }),
            ),
          );
        }
        if (lastBar >= 0) {
          const line = statusLine(lastBar);
          statusLines.push(line);
          log(line);
        }
        lastBar = bar;
      }
      if (bar >= bars || Date.now() > deadline || (tasksLeft === 0 && (playStart === null || ready === 0))) stop('done');
      if (Date.now() - lastCheck >= sessionCheckMs) {
        lastCheck = Date.now();
        try {
          if ((await deps.chain.getSession(opts.sessionId)).finalized) stop('finalized');
        } catch (error) {
          log(`session check failed (${classifyRpcError(error).message})`);
        }
      }
      await sleep(Math.min(250, barMs / 4));
    }
    await sleep(opts.settleMs ?? Math.min(3_000, barMs));
    await Promise.all(tasks);
    const line = statusLine(Math.max(0, Math.min(lastBar, bars - 1)));
    statusLines.push(line);
    log(line);
  } finally {
    stopFinalized();
    stopHits();
    opts.signal?.removeEventListener('abort', onAbort);
    await Promise.all(
      phones.map((p) =>
        p.close().catch((error: unknown) => {
          log(`closing a phone window failed (${classifyRpcError(error).message})`);
        }),
      ),
    );
  }
  sweep = await deps.sweep();
  return {
    startedAt: new Date(startedAtMs).toISOString(),
    durationMs: Date.now() - startedAtMs,
    stopReason: stopReason ?? 'done',
    playMode,
    personas: plan.personas,
    opened,
    ready,
    roomFull,
    aimed,
    landed,
    onStep,
    spentWeiEstimate,
    statusLines,
    keystoreFile,
    sweep,
  };
}
