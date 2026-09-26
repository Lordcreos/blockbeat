import { describe, expect, it } from 'vitest';
import { NOTE_MESSAGE_MAX, NOTE_NAME_MAX } from './constants';
import { cleanNoteText, parseTipNoteBody } from './note';

const TX = `0x${'ab'.repeat(32)}`;
const FROM = '0x1111111111111111111111111111111111111111';

describe('cleanNoteText (W21b: plain text, trimmed, length-limited)', () => {
  it('trims, collapses whitespace and newlines into single spaces', () => {
    expect(cleanNoteText('  big \n\n up\tberlin  ', 140)).toBe('big up berlin');
  });

  it('returns null for missing or blank text', () => {
    expect(cleanNoteText(undefined, 24)).toBeNull();
    expect(cleanNoteText(null, 24)).toBeNull();
    expect(cleanNoteText('   \n ', 24)).toBeNull();
  });

  it('strips control characters and bidi or invisible formatting marks', () => {
    expect(cleanNoteText('a\u0000b\u0007c\u009f', 24)).toBe('abc');
    expect(cleanNoteText('‮evil‬ name⁦x⁩', 24)).toBe('evil namex');
    expect(cleanNoteText('zero​width﻿', 24)).toBe('zerowidth');
  });

  it('keeps markup as literal text (React escapes it on render)', () => {
    expect(cleanNoteText('<b>hi</b> & <script>', 140)).toBe('<b>hi</b> & <script>');
  });

  it('cuts at the limit in characters, never in the middle of an emoji', () => {
    expect(cleanNoteText('x'.repeat(30), NOTE_NAME_MAX)).toHaveLength(NOTE_NAME_MAX);
    const emoji = '🎉'.repeat(30);
    const cut = cleanNoteText(emoji, NOTE_NAME_MAX);
    expect([...(cut ?? '')]).toHaveLength(NOTE_NAME_MAX);
    expect(cut?.endsWith('🎉')).toBe(true);
  });
});

describe('parseTipNoteBody', () => {
  it('accepts a session id, a tx hash and optional name and message', () => {
    const parsed = parseTipNoteBody({ sessionId: '12', txHash: TX, name: ' Ana ', message: 'more kick' });
    expect(parsed).toEqual({ ok: true, value: { sessionId: 12n, txHash: TX, name: 'Ana', message: 'more kick', mock: null } });
  });

  it('accepts a numeric session id and no note text at all', () => {
    expect(parseTipNoteBody({ sessionId: 3, txHash: TX })).toEqual({ ok: true, value: { sessionId: 3n, txHash: TX, name: null, message: null, mock: null } });
  });

  it('lower-cases the tx hash so one tx can never get two notes', () => {
    const parsed = parseTipNoteBody({ sessionId: '1', txHash: TX.toUpperCase().replace('0X', '0x') });
    expect(parsed.ok && parsed.value.txHash).toBe(TX);
  });

  it.each([
    [{ txHash: TX }, 'INVALID_SESSION'],
    [{ sessionId: '0', txHash: TX }, 'INVALID_SESSION'],
    [{ sessionId: -1, txHash: TX }, 'INVALID_SESSION'],
    [{ sessionId: '1e3', txHash: TX }, 'INVALID_SESSION'],
    [{ sessionId: '1', txHash: '0x1234' }, 'INVALID_TX_HASH'],
    [{ sessionId: '1' }, 'INVALID_TX_HASH'],
    [{ sessionId: '1', txHash: TX, name: 42 }, 'INVALID_NAME'],
    [{ sessionId: '1', txHash: TX, message: ['x'] }, 'INVALID_MESSAGE'],
    [{ sessionId: '1', txHash: TX, message: 'x'.repeat(NOTE_MESSAGE_MAX * 8) }, 'INVALID_MESSAGE'],
    [null, 'INVALID_BODY'],
    ['text', 'INVALID_BODY'],
  ])('refuses %j with %s', (body, code) => {
    const parsed = parseTipNoteBody(body);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.code).toBe(code);
  });

  it('reads the mock tip fields only when asked to (mock mode has no receipt to check)', () => {
    const body = { sessionId: '1', txHash: TX, mock: { from: FROM, amountWei: '20000000000000000' } };
    const strict = parseTipNoteBody(body);
    expect(strict.ok && strict.value.mock).toBeNull();
    const parsed = parseTipNoteBody(body, { allowMock: true });
    expect(parsed.ok && parsed.value.mock).toEqual({ from: FROM, amountWei: 20_000_000_000_000_000n });
  });

  it('refuses malformed mock tip fields', () => {
    const bad = parseTipNoteBody({ sessionId: '1', txHash: TX, mock: { from: 'nope', amountWei: '1' } }, { allowMock: true });
    expect(bad.ok).toBe(false);
    const huge = parseTipNoteBody({ sessionId: '1', txHash: TX, mock: { from: FROM, amountWei: '9'.repeat(20) } }, { allowMock: true });
    expect(huge.ok).toBe(false);
  });
});
