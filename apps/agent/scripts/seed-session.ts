/**
 * Evidence helper for anvil: start a session and place a few "human" hits on chosen steps
 * using the same scheduler the agent uses. Prints the session id and the landed steps.
 *
 * Env: AGENT_RPC_URL, AGENT_CHAIN_ID, BLOCKBEAT_ADDRESS, SEED_PRIVATE_KEY (a funded key;
 * anvil's default account 0 for local runs), SEED_SESSION_ID (reuse a session instead of
 * starting one), SEED_BARS (bars of human hits to play, default 1).
 */
import 'dotenv/config';
import { parseEventLogs, type Hash } from 'viem';
import { STEPS, blockbeatAbi, type TrackId } from '@blockbeat/shared';
import { loadConfig } from '../src/config';
import { createBlockClock } from '../src/lib/blockClock';
import type { Addition } from '../src/lib/brain/types';
import { createChainHitSender, createClients, readSession } from '../src/lib/chain';
import { createChainHeadSource } from '../src/lib/headSource';
import { createLogger } from '../src/lib/log';
import { createScheduler } from '../src/lib/scheduler';

/** A human four-on-the-floor with a snare on 4 and 12 and hats on the offbeats. */
const HUMAN_BAR: Addition[] = [
  { step: 0, track: 0 as TrackId, note: 0 },
  { step: 4, track: 0 as TrackId, note: 0 },
  { step: 8, track: 0 as TrackId, note: 0 },
  { step: 12, track: 0 as TrackId, note: 0 },
  { step: 4, track: 1 as TrackId, note: 0 },
  { step: 12, track: 1 as TrackId, note: 0 },
  { step: 2, track: 2 as TrackId, note: 0 },
  { step: 6, track: 2 as TrackId, note: 0 },
  { step: 10, track: 2 as TrackId, note: 0 },
];

async function main(): Promise<void> {
  const log = createLogger();
  const key = process.env.SEED_PRIVATE_KEY;
  if (!key) throw new Error('SEED_PRIVATE_KEY is required');
  const config = loadConfig({ ...process.env, AGENT_PRIVATE_KEY: key, AGENT_SESSION_ID: process.env.SEED_SESSION_ID ?? '1' });
  const clients = createClients(config);
  const address = config.blockbeatAddress;

  let sessionId: bigint;
  if (process.env.SEED_SESSION_ID) {
    sessionId = BigInt(process.env.SEED_SESSION_ID);
  } else {
    const hash: Hash = await clients.wallet.writeContract({ address, abi: blockbeatAbi, functionName: 'startSession', gas: 200_000n });
    const receipt = await clients.http.waitForTransactionReceipt({ hash });
    const [started] = parseEventLogs({ abi: blockbeatAbi, eventName: 'SessionStarted', logs: receipt.logs, strict: true });
    if (!started) throw new Error('no SessionStarted log');
    sessionId = started.args.sessionId;
    log.info(`started session ${sessionId} at block ${started.args.startBlock} (tx ${hash})`);
  }
  const session = await readSession(clients.http, address, sessionId);

  const clock = createBlockClock({ headSource: createChainHeadSource({ ws: clients.ws, http: clients.http, warn: (m) => log.warn(m) }) });
  clock.start();
  await new Promise<void>((resolve) => {
    const off = clock.onHead(() => {
      off();
      resolve();
    });
  });

  const scheduler = createScheduler({
    clock,
    sender: createChainHitSender({ wallet: clients.wallet, publicClient: clients.http, address, sessionId, hasHitBefore: false }),
    startBlock: session.startBlock,
    maxHits: 1000,
    enabled: () => true,
    log,
  });
  const bars = Number(process.env.SEED_BARS ?? 1);
  let barStart = scheduler.nextBarStart();
  for (let i = 0; i < bars; i++) {
    // A different note per bar: a repeated (step, track, note) would XOR the cell off again.
    scheduler.scheduleBar(HUMAN_BAR.map((a) => ({ ...a, note: i % 32 })), barStart);
    barStart += BigInt(STEPS);
  }
  const lastSend = barStart + 2n;
  await new Promise<void>((resolve) => {
    const off = clock.onHead((b) => {
      if (b >= lastSend) {
        off();
        resolve();
      }
    });
  });
  await scheduler.drain();
  clock.stop();
  const s = scheduler.stats();
  log.info(`seed done: session ${sessionId} | sent ${s.sent} | matched ${s.matched}/${s.confirmed} | gas ${s.gasUsed}`);
  process.stdout.write(`SESSION_ID=${sessionId}\n`);
  process.exit(0);
}

main().catch((error: unknown) => {
  process.stderr.write(`seed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
