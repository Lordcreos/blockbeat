/**
 * W19: the crowd's burner keys on disk, written BEFORE any funding, so MON parked in a burner
 * is never lost to a crash, a SIGKILL or a failed sweep: `crowd -- --sweep-only` reads these
 * files and returns what is left. One JSON file per run under scripts/.crowd/ (gitignored),
 * mode 600 in a 700 directory, replaced atomically (write a temp file, then rename). Keys are
 * never printed.
 */
import { isAddress, isHex, type Address, type Hex } from 'viem';

export interface KeystoreFs {
  mkdir(path: string, mode: number): void;
  writeFile(path: string, text: string, mode: number): void;
  readFile(path: string): string;
  /** File names (not paths) in a directory; [] when it does not exist. */
  list(dir: string): string[];
  rename(from: string, to: string): void;
}

export interface StoredPlayer {
  address: Address;
  privateKey: Hex;
  swept: boolean;
}

export interface CrowdRunFile {
  version: 1;
  chainId: number;
  contract: Address;
  sessionId: string;
  funder: Address;
  createdAt: string;
  players: StoredPlayer[];
}

export interface PendingRun {
  file: string;
  run: CrowdRunFile;
}

export interface NewRun {
  chainId: number;
  contract: Address;
  sessionId: bigint;
  funder: Address;
  players: ReadonlyArray<{ address: Address; privateKey: Hex }>;
}

export interface Keystore {
  /** Writes the run file and returns its path. */
  create(run: NewRun): string;
  markSwept(file: string, address: Address): void;
  /** Adds a player to a run file (no-op when it is already there). */
  append(file: string, player: { address: Address; privateKey: Hex }): void;
  /** Runs with at least one unswept player, oldest first. Throws on a malformed file. */
  pending(): PendingRun[];
}

const FILE_RE = /^crowd-.+-s\d+\.json$/;
const KEY_RE = /^0x[0-9a-fA-F]{64}$/;

function parseRun(text: string, file: string): CrowdRunFile {
  const bad = (why: string): Error => new Error(`${file}: ${why}; fix or move the file by hand, its keys may hold MON`);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw bad(`not JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  if (typeof raw !== 'object' || raw === null) throw bad('not an object');
  const r = raw as Record<string, unknown>;
  if (r.version !== 1) throw bad('unknown version');
  if (typeof r.chainId !== 'number' || typeof r.sessionId !== 'string' || typeof r.createdAt !== 'string') throw bad('missing chainId, sessionId or createdAt');
  if (typeof r.contract !== 'string' || !isAddress(r.contract) || typeof r.funder !== 'string' || !isAddress(r.funder)) throw bad('bad contract or funder address');
  if (!Array.isArray(r.players)) throw bad('players is not a list');
  const players = r.players.map((p: unknown, i): StoredPlayer => {
    const q = (typeof p === 'object' && p !== null ? p : {}) as Record<string, unknown>;
    if (typeof q.address !== 'string' || !isAddress(q.address)) throw bad(`player ${i} has a bad address`);
    if (typeof q.privateKey !== 'string' || !isHex(q.privateKey) || !KEY_RE.test(q.privateKey)) throw bad(`player ${i} has a bad key`);
    if (typeof q.swept !== 'boolean') throw bad(`player ${i} has no swept flag`);
    return { address: q.address, privateKey: q.privateKey, swept: q.swept };
  });
  return { version: 1, chainId: r.chainId, contract: r.contract, sessionId: r.sessionId, funder: r.funder, createdAt: r.createdAt, players };
}

export function createKeystore(dir: string, fs: KeystoreFs, now: () => number = Date.now): Keystore {
  const write = (file: string, run: CrowdRunFile): void => {
    fs.mkdir(dir, 0o700);
    const tmp = `${file}.tmp`;
    fs.writeFile(tmp, `${JSON.stringify(run, null, 2)}\n`, 0o600);
    fs.rename(tmp, file);
  };

  return {
    create(run) {
      const createdAt = new Date(now()).toISOString();
      const file = `${dir}/crowd-${createdAt.replace(/[:.]/g, '-')}-s${run.sessionId.toString()}.json`;
      write(file, {
        version: 1,
        chainId: run.chainId,
        contract: run.contract,
        sessionId: run.sessionId.toString(),
        funder: run.funder,
        createdAt,
        players: run.players.map((p) => ({ address: p.address, privateKey: p.privateKey, swept: false })),
      });
      return file;
    },

    markSwept(file, address) {
      const run = parseRun(fs.readFile(file), file);
      write(file, { ...run, players: run.players.map((p) => (p.address.toLowerCase() === address.toLowerCase() ? { ...p, swept: true } : p)) });
    },

    append(file, player) {
      const run = parseRun(fs.readFile(file), file);
      if (run.players.some((p) => p.address.toLowerCase() === player.address.toLowerCase())) return;
      write(file, { ...run, players: [...run.players, { address: player.address, privateKey: player.privateKey, swept: false }] });
    },

    pending() {
      return fs
        .list(dir)
        .filter((name) => FILE_RE.test(name))
        .sort()
        .map((name) => {
          const file = `${dir}/${name}`;
          return { file, run: parseRun(fs.readFile(file), file) };
        })
        .filter(({ run }) => run.players.some((p) => !p.swept));
    },
  };
}
