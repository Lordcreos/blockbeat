import { describe, expect, it } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createKeystore, type KeystoreFs } from '../../src/lib/crowd/keystore';

function memoryFs(): KeystoreFs & { files: Map<string, { text: string; mode: number }>; dirs: Map<string, number> } {
  const files = new Map<string, { text: string; mode: number }>();
  const dirs = new Map<string, number>();
  return {
    files,
    dirs,
    mkdir: (p, mode) => void dirs.set(p, mode),
    writeFile: (p, text, mode) => void files.set(p, { text, mode }),
    readFile: (p) => {
      const f = files.get(p);
      if (!f) throw new Error(`ENOENT ${p}`);
      return f.text;
    },
    list: (dir) => [...files.keys()].filter((k) => k.startsWith(`${dir}/`)).map((k) => k.slice(dir.length + 1)),
    rename: (from, to) => {
      const f = files.get(from);
      if (!f) throw new Error(`ENOENT ${from}`);
      files.delete(from);
      files.set(to, f);
    },
  };
}

const key = generatePrivateKey();
const player = { address: privateKeyToAccount(key).address, privateKey: key };

describe('crowd keystore (W19): burner keys on disk so a failed sweep can be retried', () => {
  it('writes the run file with mode 600 in a 700 directory, atomically, before funding', () => {
    const fs = memoryFs();
    const store = createKeystore('/repo/scripts/.crowd', fs, () => 1_700_000_000_000);
    const file = store.create({ chainId: 10143, contract: '0x1111111111111111111111111111111111111111', sessionId: 9n, funder: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', players: [player] });
    expect(fs.dirs.get('/repo/scripts/.crowd')).toBe(0o700);
    expect(file).toMatch(/^\/repo\/scripts\/\.crowd\/crowd-.*-s9\.json$/);
    const saved = fs.files.get(file);
    expect(saved?.mode).toBe(0o600);
    expect(JSON.parse(saved?.text ?? '{}')).toMatchObject({ version: 1, chainId: 10143, sessionId: '9', players: [{ address: player.address, privateKey: key, swept: false }] });
  });

  it('marks players swept and lists only runs with unswept players, oldest first', () => {
    const fs = memoryFs();
    let t = 1_700_000_000_000;
    const store = createKeystore('/k', fs, () => (t += 1000));
    const a = store.create({ chainId: 10143, contract: '0x1111111111111111111111111111111111111111', sessionId: 1n, funder: player.address, players: [player] });
    const b = store.create({ chainId: 10143, contract: '0x1111111111111111111111111111111111111111', sessionId: 2n, funder: player.address, players: [player] });
    expect(store.pending().map((r) => r.file)).toEqual([a, b]);
    store.markSwept(a, player.address);
    expect(store.pending().map((r) => r.file)).toEqual([b]);
    expect(JSON.parse(fs.files.get(a)?.text ?? '{}').players[0].swept).toBe(true);
    expect(fs.files.get(a)?.mode).toBe(0o600);
  });

  it('refuses a malformed file instead of guessing (never loses a key silently)', () => {
    const fs = memoryFs();
    const store = createKeystore('/k', fs, () => 1);
    fs.files.set('/k/crowd-bad-s1.json', { text: '{"version":1,"players":[{"address":"0x1"}]}', mode: 0o600 });
    expect(() => store.pending()).toThrow(/crowd-bad-s1\.json/);
  });

  it('appends a player to an existing run (visible phones are saved one by one, as each gets funded)', () => {
    const fs = memoryFs();
    const store = createKeystore('/k', fs, () => 1);
    const file = store.create({ chainId: 10143, contract: '0x1111111111111111111111111111111111111111', sessionId: 3n, funder: player.address, players: [] });
    expect(store.pending()).toEqual([]);
    store.append(file, player);
    store.append(file, player);
    const run = JSON.parse(fs.files.get(file)?.text ?? '{}') as { players: unknown[] };
    expect(run.players).toHaveLength(1);
    expect(store.pending().map((r) => r.file)).toEqual([file]);
    expect(fs.files.get(file)?.mode).toBe(0o600);
  });

  it('ignores files that are not crowd runs', () => {
    const fs = memoryFs();
    const store = createKeystore('/k', fs, () => 1);
    fs.files.set('/k/README', { text: 'x', mode: 0o600 });
    expect(store.pending()).toEqual([]);
  });
});
