/**
 * AudioEngine implementation (see lib/types.ts for the contract).
 *
 * Nothing touches WebAudio until start() runs, and start() must come from a user gesture:
 * browsers keep the context suspended otherwise, and Chrome's resume() promise then never
 * settles, so we race it against a short timeout and report isStarted() from the real state.
 */
import type { Pattern, TrackId } from '@blockbeat/shared';
import type { AudioEngine, BlockClock } from '../types';
import { createKit, type Kit } from './kit';
import { assertTrackNote } from './kitSpec';
import { createMasterChain, type MasterChain } from './master';
import { PatternPlayer } from './patternPlayer';
import { createToneAdapter } from './toneAdapter';

export type { Kit } from './kit';
export type { MasterChain } from './master';

export interface AudioContextAdapter {
  resume(): Promise<void>;
  getState(): AudioContextState;
  /** Audio-context currentTime, seconds. */
  now(): number;
  /** The underlying context object, handed to BlockClock.setAudioClock. */
  rawContext(): Pick<BaseAudioContext, 'currentTime'>;
  /** Offline contexts report 'suspended' until rendering; treat them as ready once resumed. */
  isOffline(): boolean;
}

export interface EngineDeps {
  createAdapter(): AudioContextAdapter;
  createKit(): Kit;
  createMaster(): MasterChain;
  /** How long start() waits for the context before giving up (it can be retried). */
  resumeTimeoutMs: number;
}

export const DEFAULT_RESUME_TIMEOUT_MS = 1500;

/** start() could not get the context running; `cause` is the resume() rejection when there was one (review L5). */
export class AudioStartError extends Error {
  override readonly cause: unknown;
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message);
    this.name = 'AudioStartError';
    this.cause = options.cause;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function createAudioEngine(overrides: Partial<EngineDeps> = {}): AudioEngine {
  return new ToneAudioEngine({
    createAdapter: createToneAdapter,
    createKit,
    createMaster: createMasterChain,
    resumeTimeoutMs: DEFAULT_RESUME_TIMEOUT_MS,
    ...overrides,
  });
}

class ToneAudioEngine implements AudioEngine {
  private adapter: AudioContextAdapter | null = null;
  private kit: Kit | null = null;
  private master: MasterChain | null = null;
  private started = false;
  private disposed = false;
  private starting: Promise<void> | null = null;
  private volumeDb = 0;
  private clock: BlockClock | null = null;
  private readonly player: PatternPlayer;

  constructor(private readonly deps: EngineDeps) {
    this.player = new PatternPlayer(
      {
        trigger: (track, note, at) => {
          if (this.started) this.kit?.trigger(track, note, at);
        },
      },
      { now: () => this.adapter?.now() ?? 0 },
    );
  }

  async start(): Promise<void> {
    if (this.disposed) throw new Error('AudioEngine is disposed');
    if (this.isStarted()) return;
    // The browser may have suspended the context behind our back (tab in background, iOS
    // screen lock); a fresh gesture must be able to resume it.
    this.started = false;
    if (!this.starting) {
      this.starting = this.doStart().finally(() => {
        this.starting = null;
      });
    }
    return this.starting;
  }

  isStarted(): boolean {
    if (!this.started || !this.adapter) return false;
    return this.adapter.isOffline() || this.adapter.getState() === 'running';
  }

  setPattern(pattern: Pattern): void {
    this.player.setPattern(pattern);
  }

  attachClock(clock: BlockClock): () => void {
    this.clock = clock;
    if (this.isStarted()) this.shareAudioClock();
    const off = this.player.attachClock(clock);
    return () => {
      if (this.clock === clock) this.clock = null;
      off();
    };
  }

  playImmediate(track: TrackId, note: number): void {
    assertTrackNote(track, note);
    if (!this.started) return;
    this.player.triggerNow(track, note);
  }

  setMasterVolumeDb(db: number): void {
    this.volumeDb = db;
    this.master?.setVolumeDb(db);
  }

  dispose(): void {
    this.disposed = true;
    this.started = false;
    this.clock = null;
    this.player.detach();
    this.kit?.dispose();
    this.master?.dispose();
    this.kit = null;
    this.master = null;
  }

  private async doStart(): Promise<void> {
    this.adapter ??= this.deps.createAdapter();
    if (!this.master) {
      this.master = this.deps.createMaster();
      this.master.setVolumeDb(this.volumeDb);
    }
    if (!this.kit) {
      this.kit = this.deps.createKit();
      this.kit.connect(this.master.input);
    }
    const [outcome] = await Promise.all([resumeWithTimeout(this.adapter, this.deps.resumeTimeoutMs), this.kit.ready]);
    if (this.disposed) return;
    this.started = this.adapter.isOffline() ? outcome.kind === 'resumed' : this.adapter.getState() === 'running';
    if (this.started) {
      this.shareAudioClock();
      return;
    }
    const state = this.adapter.getState();
    if (outcome.kind === 'rejected') {
      const reason = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
      throw new AudioStartError(`audio context did not start (state ${state}): resume() rejected: ${reason}`, { cause: outcome.reason });
    }
    if (outcome.kind === 'timeout') {
      throw new AudioStartError(`audio context did not start: still ${state} after ${this.deps.resumeTimeoutMs} ms (click again; a user gesture is required)`);
    }
    throw new AudioStartError(`audio context did not start: resume() settled but the state is ${state}`);
  }

  /** Let the block clock express step times on our AudioContext time base. */
  private shareAudioClock(): void {
    if (this.adapter && this.clock?.setAudioClock) this.clock.setAudioClock(this.adapter.rawContext());
  }
}

type ResumeOutcome = { kind: 'resumed' } | { kind: 'rejected'; reason: unknown } | { kind: 'timeout' };

/** Chrome's resume() never settles without a gesture, so race it; a rejection keeps its reason. */
async function resumeWithTimeout(adapter: AudioContextAdapter, timeoutMs: number): Promise<ResumeOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<ResumeOutcome>((resolve) => {
    timer = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs);
  });
  try {
    return await Promise.race([
      adapter.resume().then(
        (): ResumeOutcome => ({ kind: 'resumed' }),
        (reason: unknown): ResumeOutcome => ({ kind: 'rejected', reason }),
      ),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}
