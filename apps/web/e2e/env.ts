/**
 * Loads apps/web/.env.local into process.env for the e2e runner (no dotenv dependency), so
 * specs can read HOST_SECRET, BLOCKBEAT_E2E_ANVIL and the chain settings the dev server uses.
 * Existing process.env values win.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** HOST_SECRET the mock e2e server runs with (playwright.config.ts pins it; not a real secret). */
export const E2E_HOST_SECRET = 'blockbeat-e2e-host';

export function loadDotEnvLocal(dir: string = resolve(__dirname, '..')): void {
  let text: string;
  try {
    text = readFileSync(resolve(dir, '.env.local'), 'utf8');
  } catch (error) {
    // The file is optional; any other read failure (permissions, a directory) must surface.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  for (const line of text.split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || !m[1] || m[2] === undefined) continue;
    if (process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
  }
}

/** True when the dev server runs against a real chain (anvil or testnet), not the simulator. */
export function isChainMode(): boolean {
  if (process.env.NEXT_PUBLIC_BLOCKBEAT_MOCK?.trim() === '1') return false;
  const address = process.env.NEXT_PUBLIC_BLOCKBEAT_ADDRESS?.trim();
  return Boolean(address) && !/^0x0{40}$/.test(address ?? '');
}
