/**
 * Drives a `anvil --no-mining` node at Monad's 300 ms cadence so integration runs on the
 * real block rhythm (anvil's own --block-time only takes whole seconds).
 *
 *   anvil --chain-id 31337 --no-mining --port 8555
 *   pnpm --filter web exec tsx test/anvil-300ms.ts --rpc http://127.0.0.1:8555 --block-ms 300
 */
import { BLOCK_MS } from '@blockbeat/shared';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? (process.argv[i + 1] as string) : fallback;
}

const rpc = arg('--rpc', 'http://127.0.0.1:8555');
const blockMs = Number(arg('--block-ms', String(BLOCK_MS)));
if (!Number.isFinite(blockMs) || blockMs < 50) throw new Error(`--block-ms must be >= 50, got ${blockMs}`);

let id = 0;
let mined = 0;
let failures = 0;

async function mine(): Promise<void> {
  const res = await fetch(rpc, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'evm_mine', params: [] }),
  });
  if (!res.ok) throw new Error(`evm_mine HTTP ${res.status}`);
  const body: unknown = await res.json();
  const error = typeof body === 'object' && body !== null && 'error' in body ? (body as { error: unknown }).error : null;
  if (error !== null && error !== undefined) {
    const message = typeof error === 'object' && error !== null && 'message' in error ? String((error as { message: unknown }).message) : 'unknown error';
    throw new Error(`evm_mine: ${message}`);
  }
}

console.log(`anvil-300ms: mining every ${blockMs} ms on ${rpc}`);
setInterval(() => {
  mine().then(
    () => {
      mined += 1;
      if (mined % 100 === 0) console.log(`anvil-300ms: ${mined} blocks mined, ${failures} failures`);
    },
    (error: unknown) => {
      failures += 1;
      console.warn(`anvil-300ms: ${error instanceof Error ? error.message : String(error)}`);
    },
  );
}, blockMs);
