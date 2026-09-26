/**
 * W16: how often an aimed phone note lands on the step it was aimed at, on a real node at
 * Monad's 300 ms cadence, through a slow network. Uses the phone's own code: the runtime block
 * clock over the chain head source, the chain hit writer (fixed gas, local nonce manager, no
 * estimateGas) and the aim queue with its adaptive lead. Every RPC round trip (heads, sends,
 * receipts) is delayed by --delay-ms (half on the way out, half on the way back).
 *
 *   anvil --chain-id 31337 --no-mining --port 8555
 *   pnpm --filter web exec tsx test/anvil-300ms.ts --rpc http://127.0.0.1:8555
 *   (deploy Blockbeat, see docs/evidence/w5-integration/README.md)
 *   pnpm --filter web exec tsx test/aim-accuracy.ts --rpc http://127.0.0.1:8555 --address 0x… --delay-ms 300 --notes 60
 *
 * Needs a funded key: --key or AIM_PRIVATE_KEY (anvil's dev keys are fine). Writes a JSON
 * summary to --out when given.
 */
import { writeFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, decodeEventLog, http, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { ANVIL_ID, STEPS, START_SESSION_GAS_LIMIT, blockbeatAbi, chainById, isTrackId, type TrackId } from '@blockbeat/shared';
import { createBlockClock } from '../lib/blockClock';
import type { HeadSource } from '../lib/blockClock';
import { createChainHeadSource } from '../lib/chain/headSource';
import { createChainHitWriter } from '../lib/chain/hitWriter';
import { createAimQueue, MAX_AIMED, type AimResult } from '../lib/join/aimQueue';
import { aimClockFrom } from '../lib/join/phoneClock';
import { createLocalNonceManager } from '../lib/localNonce';

function arg(name: string, fallback: string | null = null): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? (process.argv[i + 1] as string) : fallback;
}
function num(name: string, fallback: number): number {
  const raw = arg(name, String(fallback)) ?? String(fallback);
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a number >= 0, got ${raw}`);
  return n;
}

const rpc = arg('--rpc', 'http://127.0.0.1:8555') ?? 'http://127.0.0.1:8555';
const address = arg('--address');
const key = (arg('--key') ?? process.env.AIM_PRIVATE_KEY ?? '').trim();
const delayMs = num('--delay-ms', 300);
const notes = num('--notes', 60);
const pollMs = num('--poll-ms', 100);
const out = arg('--out');
/**
 * push (default): a phone's WebSocket newHeads, each head delivered one way (delay / 2) after
 * the node has it. poll: the HTTP fallback, eth_blockNumber every --poll-ms over the slow link.
 */
const headsMode = arg('--heads', 'push') === 'poll' ? 'poll' : 'push';
/** sub (default): the phone's sub-block timer. tick: whole-block lead sent on the clock tick (the agent's way). */
const timing = arg('--timing', 'sub') === 'tick' ? 'tick' : 'sub';
/** Pass chainId so viem skips eth_fillTransaction (one round trip fewer per hit); see the W16 evidence. */

if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error('--address must be the deployed Blockbeat address');
if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error('--key / AIM_PRIVATE_KEY must be a 0x-prefixed 32-byte key');

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** A phone on a slow link: every request and every answer waits half the delay. */
const slowFetch: typeof fetch = async (input, init) => {
  await sleep(delayMs / 2);
  const res = await fetch(input, init);
  await sleep(delayMs / 2);
  return res;
};

const chain = chainById(ANVIL_ID);
const transport = http(rpc, { batch: false, fetchFn: slowFetch });
const publicClient = createPublicClient({ chain, transport, pollingInterval: pollMs });
// The phone's own local-first nonce manager (lib/localNonce.ts, as lib/burner.ts installs it).
const account = privateKeyToAccount(key as Hex, { nonceManager: createLocalNonceManager() });
const wallet = createWalletClient({ account, chain, transport });
const contract = address as Address;
/** Reads the node directly (no delay), as the WebSocket server would see its own new heads. */
const nodeClient = createPublicClient({ chain, transport: http(rpc, { batch: false }) });

function pushHeadSource(): HeadSource {
  return {
    kind: () => 'ws',
    subscribe(onHead, onError) {
      let last: bigint | null = null;
      let stopped = false;
      const timer = setInterval(() => {
        nodeClient.getBlockNumber({ cacheTime: 0 }).then(
          (b) => {
            if (stopped || (last !== null && b <= last)) return;
            last = b;
            setTimeout(() => {
              if (!stopped) onHead(b);
            }, delayMs / 2);
          },
          (e: unknown) => onError(e instanceof Error ? e : new Error(String(e))),
        );
      }, 20);
      return () => {
        stopped = true;
        clearInterval(timer);
      };
    },
  };
}

/** The first log of `receipt` that decodes as `name`; the others are reported, never swallowed. */
function findEvent<N extends 'SessionStarted' | 'Hit'>(logs: ReadonlyArray<{ data: Hex; topics: [Hex, ...Hex[]] | [] }>, name: N) {
  for (const log of logs) {
    try {
      const ev = decodeEventLog({ abi: blockbeatAbi, data: log.data, topics: log.topics });
      if (ev.eventName === name) return ev;
    } catch (error) {
      console.debug(`aim-accuracy: skipped a log (${error instanceof Error ? (error.message.split('\n')[0] ?? '') : String(error)})`);
    }
  }
  return null;
}

async function startSession(): Promise<{ sessionId: bigint; startBlock: bigint }> {
  const hash = await wallet.writeContract({ address: contract, abi: blockbeatAbi, functionName: 'startSession', gas: START_SESSION_GAS_LIMIT });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  const ev = findEvent(receipt.logs, 'SessionStarted');
  if (!ev || ev.eventName !== 'SessionStarted') throw new Error(`startSession ${hash}: no SessionStarted log`);
  return { sessionId: ev.args.sessionId, startBlock: ev.args.startBlock };
}

/** Fire to hash returned: with the local nonce every send is one round trip (the first also reads the count). */
const sendMs: number[] = [];

async function main(): Promise<void> {
  const { sessionId, startBlock } = await startSession();
  console.log(`aim-accuracy: session ${sessionId} starts at block ${startBlock}; delay ${delayMs} ms per round trip, heads ${headsMode}`);

  const headSource = headsMode === 'push' ? pushHeadSource() : createChainHeadSource({ ws: null, http: publicClient, pollingIntervalMs: pollMs, warn: (m) => console.warn(m) });
  const clock = createBlockClock({ headSource, startBlock });
  clock.onError((e) => console.warn(`clock: ${e.message}`));
  clock.start();
  const aimClock = aimClockFrom(clock);

  const writer = createChainHitWriter({ wallet, address: contract, warn: (m) => console.warn(m) });
  const send = async (track: TrackId, note: number) => {
    const sentAt = Date.now();
    const hash = await writer({ sessionId, track, note });
    sendMs.push(Date.now() - sentAt);
    const receipt = await publicClient.waitForTransactionReceipt({ hash, pollingInterval: pollMs });
    const ev = findEvent(receipt.logs, 'Hit');
    if (!ev || ev.eventName !== 'Hit') throw new Error(`hit ${hash}: ${receipt.status}, no Hit log`);
    return { blockNumber: ev.args.blockNumber, step: ev.args.step, latencyMs: Date.now() - sentAt };
  };

  const results: AimResult[] = [];
  const leads: number[] = [];
  // Without position() the queue falls back to whole-block leads on the tick.
  const queueClock = timing === 'sub' ? aimClock : { head: aimClock.head, onBlock: aimClock.onBlock };
  const queue = createAimQueue({ clock: queueClock, send, startBlock: () => startBlock, keepResults: 1 });
  let lastId = 0;
  queue.subscribe((s) => {
    const r = s.results[0];
    if (r && r.id !== lastId) {
      lastId = r.id;
      results.push(r);
      leads.push(s.lead);
      console.log(r.ok ? `#${results.length} ${r.text} (lead now ${s.lead})` : `#${results.length} FAILED: ${r.error instanceof Error ? r.error.message : String(r.error)}`);
    }
  });

  while (aimClock.head() === null) await sleep(50);
  let aimed = 0;
  const trackOf = (i: number): TrackId => {
    const t = i % 8;
    if (!isTrackId(t)) throw new Error('unreachable');
    return t;
  };
  while (results.length < notes) {
    if (aimed < notes && queue.getState().items.length < MAX_AIMED) {
      const step = Math.floor(Math.random() * STEPS);
      const r = queue.aim({ track: trackOf(aimed), note: aimed % 32, step });
      if (r.ok) aimed += 1;
    }
    await sleep(120 + Math.random() * 400);
  }
  queue.dispose();
  aimClock.dispose();
  clock.stop();

  const ok = results.filter((r): r is Extract<AimResult, { ok: true }> => r.ok);
  const exact = ok.filter((r) => r.delta === 0).length;
  const deltas: Record<string, number> = {};
  for (const r of ok) deltas[String(r.delta)] = (deltas[String(r.delta)] ?? 0) + 1;
  // The first 4 notes teach the lead; report the settled rate separately.
  const settled = ok.slice(4);
  const settledExact = settled.filter((r) => r.delta === 0).length;
  // y = landed block − clock position at send. With a clean clock y spans exactly one block.
  const ys = ok.filter((r) => r.sentAtPosition !== null).map((r) => Number(r.landedBlock) - (r.sentAtPosition ?? 0));
  if (ys.length === 0) ys.push(Number.NaN);
  const yMean = ys.reduce((a, b) => a + b, 0) / Math.max(1, ys.length);
  const ySd = Math.sqrt(ys.reduce((a, b) => a + (b - yMean) ** 2, 0) / Math.max(1, ys.length));
  const summary = {
    yMean: Number(yMean.toFixed(3)),
    ySd: Number(ySd.toFixed(3)),
    yMin: Number(Math.min(...ys).toFixed(3)),
    yMax: Number(Math.max(...ys).toFixed(3)),
    ys: ys.map((y) => Number(y.toFixed(3))),
    sendMs,
    rpc,
    blockMs: 300,
    delayMsPerRoundTrip: delayMs,
    timing,
    heads: headsMode === 'push' ? `newHeads push, ${delayMs / 2} ms one way` : `eth_blockNumber poll every ${pollMs} ms`,
    sessionId: sessionId.toString(),
    notes: results.length,
    failed: results.length - ok.length,
    exact,
    accuracy: ok.length === 0 ? 0 : exact / ok.length,
    accuracyAfterFirst4: settled.length === 0 ? 0 : settledExact / settled.length,
    deltas,
    finalLead: leads.at(-1) ?? null,
    leads,
    meanInclusionDelayBlocks: ok.length === 0 ? null : ok.reduce((a, r) => a + Number(r.landedBlock - (r.sentAtBlock ?? r.landedBlock)), 0) / ok.length,
    meanLatencyMs: ok.length === 0 ? null : Math.round(ok.reduce((a, r) => a + (r.latencyMs ?? 0), 0) / ok.length),
  };
  console.log(JSON.stringify(summary, null, 2));
  if (out) writeFileSync(out, `${JSON.stringify(summary, null, 2)}\n`);
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  },
);
