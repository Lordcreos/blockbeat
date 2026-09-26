/**
 * Drives a `--no-mining` anvil at a Monad-like cadence: one evm_mine every --block-ms
 * (default 300). anvil's own --block-time only takes whole seconds.
 *
 *   anvil --chain-id 31337 --no-mining --accounts 60 --port 8546
 *   pnpm --filter scripts exec tsx src/anvil-clock.ts --rpc http://127.0.0.1:8546 --block-ms 300
 */
import { createPublicClient, http } from 'viem';
import { anvilLocal } from '@blockbeat/shared';
import { parseFlags } from './lib/args';
import { createLogger, runMain } from './lib/cli';
import { urlSecrets } from './lib/env';

async function main(): Promise<number> {
  const flags = parseFlags(process.argv.slice(2));
  const rpc = flags['rpc'] ?? 'http://127.0.0.1:8546';
  const blockMs = Number(flags['block-ms'] ?? 300);
  if (!Number.isInteger(blockMs) || blockMs < 50) throw new Error(`--block-ms must be an integer >= 50, got "${flags['block-ms']}"`);
  const log = createLogger(urlSecrets(rpc));
  const client = createPublicClient({ chain: anvilLocal, transport: http(rpc, { retryCount: 0 }) });
  log(`anvil-clock: mining every ${blockMs} ms on ${rpc} (ctrl-c to stop)`);
  let next = Date.now();
  let mined = 0;
  for (;;) {
    next += blockMs;
    await client.request({ method: 'evm_mine' as 'eth_blockNumber' });
    mined += 1;
    if (mined % 100 === 0) log(`anvil-clock: ${mined} blocks`);
    const wait = next - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
}

runMain(main, () => []);
