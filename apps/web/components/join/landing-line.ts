import { formatInt } from '@/components/format';
import type { HitReceipt } from '@/lib/types';

export type LandingLine =
  | { kind: 'idle' }
  | { kind: 'sending' }
  | { kind: 'landed'; receipt: HitReceipt }
  | { kind: 'failed'; message: string }
  /** W16: an aimed note landed; `text` is aimOutcome's "aimed step 7 · landed step 7". */
  | { kind: 'aimed'; text: string; blockNumber: bigint; latencyMs: number | null }
  /** W16: why an aim was refused, or what to do next. */
  | { kind: 'notice'; message: string };

export type PhoneMode = 'aim' | 'now';

/** The one line under the pads. Pure so the copy is unit tested. */
export function landingText(line: LandingLine, mode: PhoneMode = 'now'): string {
  switch (line.kind) {
    case 'idle':
      return mode === 'aim' ? 'Pick a sound, then tap a step. The chain confirms where it lands.' : 'Tap a pad. Your note lands on the next block.';
    case 'sending':
      return 'sending…';
    case 'landed': {
      const r = line.receipt;
      // W13: every hit is a note the room hears (it lives 8 bars), so there is no "off" wording.
      return `landed · block ${formatInt(r.blockNumber)} · step ${r.step} · ${Math.round(r.latencyMs)} ms`;
    }
    case 'failed':
      return `did not land · ${line.message} · tap again`;
    case 'aimed':
      return `${line.text} · block ${formatInt(line.blockNumber)}${line.latencyMs === null ? '' : ` · ${Math.round(line.latencyMs)} ms`}`;
    case 'notice':
      return line.message;
  }
}
