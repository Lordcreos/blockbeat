import { describe, expect, it } from 'vitest';
import { HitError } from '@/lib/hitSender';
import { hitMessage, isOutOfFunds } from './hit-message';

describe('hitMessage', () => {
  it('maps a timeout to a short retry hint', () => {
    expect(hitMessage(new HitError('TIMEOUT', 'no Hit log for 0xabc within 15000 ms'))).toBe('network busy, tap again');
  });
  it('recognises a finalized session revert', () => {
    expect(hitMessage(new HitError('SEND_FAILED', 'hit send failed: hit reverted (SessionFinalized); the session may be finalized or unknown'))).toBe('session finished');
    expect(hitMessage(new HitError('SEND_FAILED', 'hit reverted (0x1234abcd); the session may be finalized or unknown'))).toBe('session finished');
  });
  it('recognises an empty wallet, including Monad testnet wording (W12)', () => {
    expect(hitMessage(new HitError('SEND_FAILED', 'hit send failed: insufficient funds for gas * price + value'))).toBe('Out of MON');
    expect(hitMessage(new HitError('SEND_FAILED', 'total cost exceeds balance'))).toBe('Out of MON');
    expect(hitMessage(new HitError('SEND_FAILED', 'hit send failed: Signer had insufficient balance'))).toBe('Out of MON');
  });
  it('flags out-of-funds failures so the page can switch to the top-up state (W12)', () => {
    expect(isOutOfFunds(new HitError('SEND_FAILED', 'hit send failed: Signer had insufficient balance'))).toBe(true);
    expect(isOutOfFunds(new HitError('SEND_FAILED', 'hit send failed: insufficient funds for gas'))).toBe(true);
    expect(isOutOfFunds(new HitError('TIMEOUT', 'no Hit log within 15000 ms'))).toBe(false);
    expect(isOutOfFunds(new Error('insufficient funds'))).toBe(false);
  });
  it('explains a timeout as out of MON when the known balance buys no note (W12)', () => {
    expect(hitMessage(new HitError('TIMEOUT', 'no Hit log within 15000 ms'), { notesLeft: 0 })).toBe('Out of MON');
    expect(hitMessage(new HitError('TIMEOUT', 'no Hit log within 15000 ms'), { notesLeft: 3 })).toBe('network busy, tap again');
    expect(hitMessage(new HitError('SEND_FAILED', 'send failed'), { notesLeft: 0 })).toBe('Out of MON');
  });
  it('recognises rate limiting', () => {
    expect(hitMessage(new HitError('SEND_FAILED', 'HTTP request failed. Status: 429 Too Many Requests. URL: https://testnet-rpc.monad.xyz Request body: {...}'))).toBe('network busy, tap again');
  });
  it('never leaks a long message or a URL', () => {
    const wall = new HitError('SEND_FAILED', `hit send failed: ${'x'.repeat(400)} URL: https://testnet-rpc.monad.xyz`);
    const out = hitMessage(wall);
    expect(out.length).toBeLessThanOrEqual(40);
    expect(out).not.toMatch(/https?:/);
    expect(hitMessage(new Error('boom'))).toBe('send failed, tap again');
    expect(hitMessage('weird')).toBe('send failed, tap again');
  });
});
