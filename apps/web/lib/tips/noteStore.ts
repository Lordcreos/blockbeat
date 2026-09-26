/**
 * W21b: the off-chain tip notes, one per tip transaction, in a JSON file under
 * apps/web/.data/ (gitignored; TIP_NOTES_FILE overrides the path). Server only.
 *
 * File: { "version": 1, "notes": TipNote[] } in insertion order. Amounts and blocks are
 * decimal strings (bigint-safe), createdAt is epoch ms (server clock). Loaded once, then every
 * write goes through one queue as write-to-temp + rename, so a crash never leaves half a file.
 * An unreadable file is renamed aside (`.corrupt-<ms>`) and the store starts empty; records
 * that fail validation on load are dropped and counted in the log. Caps bound the disk use.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Hash } from 'viem';
import { isTipNote, type TipNote } from './noteShape';

export { isTipNote, type TipNote };

export type AddResult = 'added' | 'duplicate' | 'session-full' | 'full';

export interface TipNoteStore {
  has(txHash: Hash): Promise<boolean>;
  add(note: TipNote): Promise<AddResult>;
  /** Newest first. */
  list(sessionId: string, limit?: number): Promise<TipNote[]>;
}

export interface TipNoteStoreOptions {
  /** Path of the JSON file; null keeps the notes in memory (tests). */
  file: string | null;
  maxPerSession?: number;
  maxTotal?: number;
  log?: (message: string) => void;
}

export const DEFAULT_MAX_NOTES_PER_SESSION = 500;
export const DEFAULT_MAX_NOTES_TOTAL = 20_000;

export function createTipNoteStore(options: TipNoteStoreOptions): TipNoteStore {
  const { file } = options;
  const maxPerSession = options.maxPerSession ?? DEFAULT_MAX_NOTES_PER_SESSION;
  const maxTotal = options.maxTotal ?? DEFAULT_MAX_NOTES_TOTAL;
  const log = options.log ?? ((m: string) => console.error(m));

  let notes: TipNote[] = [];
  const byHash = new Set<string>();
  const perSession = new Map<string, number>();
  let loading: Promise<void> | null = null;
  let queue: Promise<unknown> = Promise.resolve();

  function index(n: TipNote): void {
    byHash.add(n.txHash);
    perSession.set(n.sessionId, (perSession.get(n.sessionId) ?? 0) + 1);
  }

  async function readFromDisk(): Promise<void> {
    if (!file) return;
    let raw: string;
    try {
      raw = await readFile(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as { notes?: unknown }).notes)) throw new Error('no notes array');
    } catch (error) {
      const aside = `${file}.corrupt-${Date.now()}`;
      log(`tip-notes: ${file} is unreadable (${error instanceof Error ? error.message : String(error)}); moved to ${aside}, starting empty`);
      await rename(file, aside);
      return;
    }
    let dropped = 0;
    for (const item of (parsed as { notes: unknown[] }).notes) {
      if (!isTipNote(item) || byHash.has(item.txHash)) {
        dropped += 1;
        continue;
      }
      notes.push(item);
      index(item);
    }
    if (dropped > 0) log(`tip-notes: dropped ${dropped} malformed or duplicate records from ${file}`);
  }

  function ready(): Promise<void> {
    // A failed read (permissions) is retried by the next call instead of poisoning the store.
    loading ??= readFromDisk().catch((error: unknown) => {
      loading = null;
      throw error;
    });
    return loading;
  }

  async function persist(): Promise<void> {
    if (!file) return;
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    await writeFile(tmp, JSON.stringify({ version: 1, notes }), 'utf8');
    await rename(tmp, file);
  }

  /** Runs `task` after every earlier write, whether it succeeded or failed. */
  function serial<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(task, task);
    queue = run.catch(() => undefined);
    return run;
  }

  return {
    async has(txHash) {
      await ready();
      return byHash.has(txHash.toLowerCase());
    },
    add(note) {
      return serial(async () => {
        await ready();
        const key = note.txHash.toLowerCase() as Hash;
        if (byHash.has(key)) return 'duplicate';
        if ((perSession.get(note.sessionId) ?? 0) >= maxPerSession) return 'session-full';
        if (notes.length >= maxTotal) return 'full';
        const stored = { ...note, txHash: key };
        notes = [...notes, stored];
        index(stored);
        try {
          await persist();
        } catch (error) {
          // Keep serving it from memory; the next successful write saves it too.
          log(`tip-notes: could not write ${file ?? '(memory)'}: ${error instanceof Error ? error.message : String(error)}`);
        }
        return 'added';
      });
    },
    async list(sessionId, limit) {
      await ready();
      const own: TipNote[] = [];
      for (let i = notes.length - 1; i >= 0; i--) {
        const n = notes[i];
        if (n && n.sessionId === sessionId) own.push(n);
        if (limit !== undefined && own.length >= limit) break;
      }
      return own;
    },
  };
}
