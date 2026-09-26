/**
 * W16: the runtime block clock seen as an AimClock. The clock free-runs one step per measured
 * block and phase-locks to newHeads, so a tick fires even between heads; its lock also
 * re-emits the head as a step, hence the de-duplication by block number.
 */
import { BLOCK_MS } from '@blockbeat/shared';
import type { BlockClock } from '@/lib/types';
import type { AimClock } from './aimQueue';

/** Beyond this many blocks without a head the position stops growing (a dead socket must not run away). */
const MAX_HEAD_AGE_BLOCKS = 3;

export function aimClockFrom(clock: BlockClock, now: () => number = () => Date.now()): AimClock & { dispose(): void } {
  let head: bigint | null = null;
  /** Wall time the current block's tick was seen (fallback base of the position). */
  let tickAt = 0;
  /** The last real head and when it arrived: the base of the sub-block position (W16 anvil probe). */
  let lastHead: bigint | null = null;
  let headAt = 0;
  const listeners = new Set<(block: bigint) => void>();
  const blockMs = (): number => clock.getState().measuredBlockMs;
  const see = (): void => {
    const block = clock.getState().currentBlock;
    if (head !== null && block <= head) return;
    head = block;
    tickAt = now();
    for (const cb of [...listeners]) cb(block);
  };
  const offStep = clock.onStep(see);
  const offHead = clock.onHead((block) => {
    if (lastHead === null || block > lastHead) {
      lastHead = block;
      headAt = now();
    }
    see();
  });
  return {
    head: () => head,
    /**
     * The last real head plus the time since it arrived. The free-running tick is phase-nudged
     * and re-locks, which moved the position 1.6-3.8 blocks during a steady 610 ms send on anvil;
     * a newHeads stream with a constant latency is the steadier ruler. Before any head, the tick.
     */
    position: () => {
      if (lastHead !== null) return Number(lastHead) + Math.min(MAX_HEAD_AGE_BLOCKS, Math.max(0, now() - headAt) / blockMs());
      return head === null ? null : Number(head) + Math.min(0.999, Math.max(0, now() - tickAt) / blockMs());
    },
    blockMs,
    onBlock(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    dispose() {
      offStep();
      offHead();
      listeners.clear();
    },
  };
}

export interface ClockProxy extends AimClock {
  /** Forwards `clock` until the returned detach is called (a later attach replaces it). */
  attach(clock: AimClock): () => void;
}

/**
 * A stable AimClock for React: created once per component, attached to the runtime clock in an
 * effect. Consumers subscribe to it without ever holding a clock that changes identity.
 */
export function createClockProxy(): ClockProxy {
  let current: AimClock | null = null;
  let offCurrent: (() => void) | null = null;
  const listeners = new Set<(block: bigint) => void>();
  return {
    head: () => current?.head() ?? null,
    position: () => current?.position?.() ?? null,
    blockMs: () => current?.blockMs?.() ?? BLOCK_MS,
    onBlock(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    attach(clock) {
      offCurrent?.();
      current = clock;
      offCurrent = clock.onBlock((block) => {
        for (const cb of [...listeners]) cb(block);
      });
      return () => {
        if (current !== clock) return;
        offCurrent?.();
        offCurrent = null;
        current = null;
      };
    },
  };
}
