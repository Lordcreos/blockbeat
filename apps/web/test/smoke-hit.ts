/**
 * Smoke check: send ONE real `hit` to Monad testnet and print where it landed.
 *
 *   pnpm --filter web exec tsx test/smoke-hit.ts
 *
 * Needs the shared address for chain 10143 to be non-zero and a funded PRIVATE_KEY (env
 * or apps/web/.env.local). Optional: SESSION_ID (default 1), TRACK (0..7), NOTE (0..31),
 * MONAD_RPC_URL / MONAD_WS_URL. In mock mode (address zero) it exits 0 with a message.
 * Never prints the key.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { formatEther } from 'viem';
import { privateKeyToAccount, nonceManager } from 'viem/accounts';
import { MONAD_TESTNET_ID, MONAD_TESTNET_RPC_HTTP, MONAD_TESTNET_RPC_WS, blockbeatAddress, explorerTxUrl, isDeployed, isTrackId, isNote } from '@blockbeat/shared';
import { createBurnerWalletClient, createHttpClient, createWsClient } from '../lib/chain/clients';
import { createChainEventSource } from '../lib/chain/eventSource';
import { createChainHitWriter } from '../lib/chain/hitWriter';
import { createEventFeed } from '../lib/eventFeed';
import { createHitSender, HitError } from '../lib/hitSender';

function loadDotEnvLocal(): void {
  let text: string;
  try {
    text = readFileSync(resolve(process.cwd(), '.env.local'), 'utf8');
  } catch {
    return; // optional file
  }
  for (const line of text.split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || !m[1] || m[2] === undefined) continue;
    if (process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
  }
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n)) throw new Error(`${name} must be an integer, got "${raw}"`);
  return n;
}

async function main(): Promise<number> {
  loadDotEnvLocal();

  if (!isDeployed(MONAD_TESTNET_ID)) {
    console.log('smoke-hit: mock mode (shared address for chain 10143 is zero); nothing sent.');
    return 0;
  }
  const raw = process.env.PRIVATE_KEY?.trim();
  if (!raw) {
    console.log('smoke-hit: PRIVATE_KEY not set; nothing sent. Fund a key and export PRIVATE_KEY=0x…');
    return 0;
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) throw new Error('PRIVATE_KEY is not a 0x-prefixed 32-byte hex key');

  const address = blockbeatAddress(MONAD_TESTNET_ID);
  const sessionId = BigInt(intEnv('SESSION_ID', 1));
  const track = intEnv('TRACK', 0);
  const note = intEnv('NOTE', 0);
  if (!isTrackId(track)) throw new Error('TRACK must be 0..7');
  if (!isNote(note)) throw new Error('NOTE must be 0..31');

  const httpUrl = process.env.MONAD_RPC_URL?.trim() || MONAD_TESTNET_RPC_HTTP;
  const wsUrl = process.env.MONAD_WS_URL?.trim() || MONAD_TESTNET_RPC_WS;
  const account = privateKeyToAccount(raw as `0x${string}`, { nonceManager });
  const http = createHttpClient(httpUrl);
  const ws = createWsClient(wsUrl);
  const wallet = createBurnerWalletClient(account, httpUrl);

  const balance = await http.getBalance({ address: account.address });
  console.log(`smoke-hit: contract ${address} · player ${account.address} · balance ${formatEther(balance)} MON · session ${sessionId}`);

  const source = createChainEventSource({ ws, http, address });
  const feed = createEventFeed({ sessionId, source });
  feed.onError((e) => console.warn(`feed: ${e.message}`));
  await feed.start();
  const session = feed.getState().session;
  console.log(session ? `session startBlock ${session.startBlock}, hits so far ${session.hitCount}` : 'session not found on chain (hit may revert)');

  const sender = createHitSender({ writer: createChainHitWriter({ wallet, address }), hits: feed });
  const sentAtBlock = await http.getBlockNumber();
  console.log(`sending hit(track ${track}, note ${note}) at block ${sentAtBlock}…`);
  try {
    const r = await sender.send(sessionId, track, note);
    console.log(`landed · block ${r.blockNumber} · step ${r.step} · ${r.on ? 'on' : 'off'} · ${r.latencyMs} ms · ${explorerTxUrl(r.txHash)}`);
    return 0;
  } catch (e) {
    if (e instanceof HitError) {
      console.error(`hit failed: ${e.code}: ${e.message}${e.txHash ? ` (${explorerTxUrl(e.txHash)})` : ''}`);
      return 1;
    }
    throw e;
  } finally {
    feed.stop();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((e: unknown) => {
    console.error(`smoke-hit: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
