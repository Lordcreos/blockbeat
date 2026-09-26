import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { IdentityStore } from './identity';

/** .agent.json on disk (gitignored). */
export function createFileStore(path: string): IdentityStore {
  return {
    read: () => (existsSync(path) ? readFileSync(path, 'utf8') : null),
    write(contents) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, contents, { mode: 0o600 });
    },
  };
}
