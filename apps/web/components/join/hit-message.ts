import { HitError } from '@/lib/hitSender';

/** Node wording for a sender that cannot pay: geth-style, viem's, and Monad testnet's ("Signer had insufficient balance"). */
const OUT_OF_FUNDS_RE = /insufficient funds|insufficient balance|exceeds balance/i;

export const OUT_OF_MON = 'Out of MON';

/** True when the node refused the hit because the burner cannot pay for it (W12). */
export function isOutOfFunds(err: unknown): boolean {
  return err instanceof HitError && err.code === 'SEND_FAILED' && OUT_OF_FUNDS_RE.test(err.message);
}

export interface HitMessageContext {
  /** Notes the last known balance still buys; 0 turns an unexplained failure into "Out of MON". */
  notesLeft?: number | null;
}

/**
 * The phone gets six short reasons, never the raw viem text (which embeds the RPC URL and
 * the request body). Order matters: the most specific match wins.
 */
export function hitMessage(err: unknown, context: HitMessageContext = {}): string {
  if (isOutOfFunds(err)) return OUT_OF_MON;
  if (err instanceof HitError) {
    if (err.code === 'INVALID_ARGS') return 'bad note, tap another pad';
    const m = err.message;
    if (err.code === 'SEND_FAILED' && /SessionFinalized|SessionNotFound|may be finalized/i.test(m)) return 'session finished';
    // W12: a dry burner's hit may be accepted and never land; with no MON left that is the reason.
    if (context.notesLeft === 0) return OUT_OF_MON;
    if (err.code === 'TIMEOUT') return 'network busy, tap again';
    if (/\b429\b|rate limit|too many requests/i.test(m)) return 'network busy, tap again';
  }
  return 'send failed, tap again';
}
