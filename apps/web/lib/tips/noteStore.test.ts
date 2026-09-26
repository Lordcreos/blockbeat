import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Address, Hash } from 'viem';
import { createTipNoteStore, type TipNote } from './noteStore';

const FROM = '0x1111111111111111111111111111111111111111' as Address;
const hash = (n: number): Hash => `0x${n.toString(16).padStart(64, '0')}` as Hash;

function note(n: number, overrides: Partial<TipNote> = {}): TipNote {
  return {
    sessionId: '7',
    txHash: hash(n),
    from: FROM,
    amountWei: '10000000000000000',
    hostWei: null,
    poolWei: null,
    blockNumber: String(100 + n),
    name: `n${n}`,
    message: null,
    createdAt: 1_790_000_000_000 + n,
    ...overrides,
  };
}

describe('createTipNoteStore (W21b, JSON file under .data/)', () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'tip-notes-'));
    file = path.join(dir, 'nested', 'tip-notes.json');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('adds a note, lists it newest first and persists it to the file', async () => {
    const store = createTipNoteStore({ file });
    expect(await store.add(note(1))).toBe('added');
    expect(await store.add(note(2))).toBe('added');
    expect((await store.list('7')).map((n) => n.txHash)).toEqual([hash(2), hash(1)]);
    const saved = JSON.parse(await readFile(file, 'utf8')) as { version: number; notes: TipNote[] };
    expect(saved.version).toBe(1);
    expect(saved.notes).toHaveLength(2);
    // A second store on the same file (a server restart) reads them back.
    expect((await createTipNoteStore({ file }).list('7')).map((n) => n.name)).toEqual(['n2', 'n1']);
  });

  it('keeps one note per tx hash', async () => {
    const store = createTipNoteStore({ file });
    await store.add(note(1));
    expect(await store.add(note(1, { name: 'again' }))).toBe('duplicate');
    expect(await store.has(hash(1))).toBe(true);
    expect((await store.list('7'))[0]?.name).toBe('n1');
  });

  it('lists one session only and honours the limit', async () => {
    const store = createTipNoteStore({ file });
    await store.add(note(1));
    await store.add(note(2, { sessionId: '8' }));
    await store.add(note(3));
    expect((await store.list('7', 1)).map((n) => n.txHash)).toEqual([hash(3)]);
    expect((await store.list('8')).map((n) => n.txHash)).toEqual([hash(2)]);
    expect(await store.list('9')).toEqual([]);
  });

  it('refuses new notes past the per-session and total caps', async () => {
    const store = createTipNoteStore({ file, maxPerSession: 2, maxTotal: 3 });
    await store.add(note(1));
    await store.add(note(2));
    expect(await store.add(note(3))).toBe('session-full');
    await store.add(note(4, { sessionId: '8' }));
    expect(await store.add(note(5, { sessionId: '9' }))).toBe('full');
  });

  it('serialises concurrent writes so no note is lost', async () => {
    const store = createTipNoteStore({ file });
    await Promise.all(Array.from({ length: 20 }, (_, i) => store.add(note(i + 1))));
    const saved = JSON.parse(await readFile(file, 'utf8')) as { notes: TipNote[] };
    expect(saved.notes).toHaveLength(20);
    expect((await readdir(path.dirname(file))).filter((f) => f.includes('.tmp'))).toEqual([]);
  });

  it('sets a corrupt file aside and starts empty instead of crashing', async () => {
    const log = vi.fn();
    await createTipNoteStore({ file }).add(note(1));
    await writeFile(file, '{ not json');
    const store = createTipNoteStore({ file, log });
    expect(await store.list('7')).toEqual([]);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/unreadable/));
    expect((await readdir(path.dirname(file))).some((f) => f.includes('.corrupt-'))).toBe(true);
    expect(await store.add(note(2))).toBe('added');
  });

  it('drops malformed records from the file and keeps the good ones', async () => {
    const log = vi.fn();
    await createTipNoteStore({ file }).add(note(1));
    const saved = JSON.parse(await readFile(file, 'utf8')) as { version: number; notes: unknown[] };
    saved.notes.push({ sessionId: 7, txHash: 'x' }, { ...note(2), name: '<b>'.repeat(100) });
    await writeFile(file, JSON.stringify(saved));
    const store = createTipNoteStore({ file, log });
    expect((await store.list('7')).map((n) => n.txHash)).toEqual([hash(1)]);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/dropped 2/));
  });

  it('runs in memory when no file is given', async () => {
    const store = createTipNoteStore({ file: null });
    await store.add(note(1));
    expect(await store.list('7')).toHaveLength(1);
  });
});
