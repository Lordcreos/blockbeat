/** Shared CLI plumbing: env loading, redacting logger, error exit. */
import { readFileSync, existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseKeysEnv, redactSecrets, urlSecrets } from './env';

export const KEYS_ENV_PATH = join(homedir(), '.blockbeat', 'keys.env');

/** process.env first, then ~/.blockbeat/keys.env for anything unset. Values are never logged. */
export function loadEnv(): Record<string, string | undefined> {
  const merged: Record<string, string | undefined> = { ...process.env };
  if (existsSync(KEYS_ENV_PATH)) {
    const mode = statSync(KEYS_ENV_PATH).mode & 0o777;
    if ((mode & 0o077) !== 0) console.warn(`warning: ${KEYS_ENV_PATH} is readable by other users (mode ${mode.toString(8)}); run chmod 600 on it`);
    const fromFile = parseKeysEnv(readFileSync(KEYS_ENV_PATH, 'utf8'));
    for (const [k, v] of Object.entries(fromFile)) if (merged[k] === undefined || merged[k] === '') merged[k] = v;
  }
  return merged;
}

/** Every *_PRIVATE_KEY value plus any credential inside a *_URL value, so logs and reports can scrub them. */
export function secretsOf(env: Record<string, string | undefined>): string[] {
  return Object.entries(env).flatMap(([k, v]) => {
    if (!v) return [];
    if (k.endsWith('PRIVATE_KEY')) return [v];
    if (k.endsWith('_URL')) return urlSecrets(v);
    return [];
  });
}

export function createLogger(secrets: readonly string[]): (line: string) => void {
  return (line) => console.log(redactSecrets(line, secrets));
}

export function runMain(main: () => Promise<number>, secrets: () => readonly string[]): void {
  main()
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
      console.error(redactSecrets(message, secrets()));
      process.exit(1);
    });
}
