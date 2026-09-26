/**
 * `pnpm --filter agent start [-- --session <id>]`: run the resident DJ for the session from
 * `--session` or AGENT_SESSION_ID. Env from apps/agent/.env (gitignored) and the process
 * environment; the process environment wins (dotenv never overrides it).
 */
import 'dotenv/config';
import { ZERO_ADDRESS, STEPS } from '@blockbeat/shared';
import { createAgentLoop, formatMon } from './agent';
import { loadConfig } from './config';
import { createBlockClock } from './lib/blockClock';
import { createAnthropicCompleter, createFallbackBrain, createGeminiCompleter, createOpenAiCompleter, createRulesBrain, selectBrain } from './lib/brain';
import { createChainHeadSource } from './lib/headSource';
import { createChainHitSender, createChainIdentity, createClients, createHitLogStream, createNonceSource, readHitsOf, readSession } from './lib/chain';
import { createFileStore } from './lib/fileStore';
import { buildAgentURI, startIdentity } from './lib/identity';
import { createLogger } from './lib/log';
import { keyName, progression, progressionName } from './lib/music/theory';
import { createPatternReader } from './lib/pattern';
import { createScheduler } from './lib/scheduler';
import { redactSecrets, rpcOrigin } from './lib/log';

async function main(): Promise<void> {
  const log = createLogger();
  const config = loadConfig(process.env, process.argv.slice(2));
  if (config.blockbeatAddress === ZERO_ADDRESS) {
    throw new Error(`Blockbeat is not deployed on chain ${config.chainId}; set BLOCKBEAT_ADDRESS`);
  }
  const clients = createClients(config);
  // Origins only: a provider key in the RPC path must never reach the terminal or a recording.
  log.info(`agent ${clients.account.address} on chain ${config.chainId} (${rpcOrigin(config.rpcUrl)}${config.wsUrl ? `, ws ${rpcOrigin(config.wsUrl)}` : ''})`);
  log.info(`contract ${config.blockbeatAddress} session ${config.sessionId} | cap ${config.maxHitsPerSession} hits, ${config.maxNotesPerBar} notes per bar | enabled=${config.enabled}`);
  log.info(`set: ${keyName(config.key)}, ${progressionName(progression(config.key))} in every bar; intro 4, build 4, peak 8, breakdown 4 bars from the first bar the DJ plays${config.setStartBar > 0 ? ` (opening on arrangement bar ${config.setStartBar}, AGENT_SET_START_BAR)` : ''}`);
  log.info(
    config.decay.lifetimeBars > 0
      ? `notes decay after ${config.decay.lifetimeBars} bars, ${config.decay.maxLivePerTrack === 0 ? 'no voice cap' : `${config.decay.maxLivePerTrack} voices per track`}: the DJ keeps the groove floor`
      : 'no note decay (NEXT_PUBLIC_NOTE_LIFETIME_BARS=0): the DJ plans on the recorded pattern',
  );
  if (!config.enabled) log.warn('kill switch is on (AGENT_ENABLED=false): the loop runs but sends nothing');

  const session = await readSession(clients.http, config.blockbeatAddress, config.sessionId);
  if (session.host === ZERO_ADDRESS) throw new Error(`session ${config.sessionId} does not exist`);
  if (session.finalized) throw new Error(`session ${config.sessionId} is finalized`);
  const agentHits = await readHitsOf(clients.http, config.blockbeatAddress, config.sessionId, clients.account.address);
  log.info(`session ${config.sessionId} started at block ${session.startBlock} by ${session.host}, ${session.hitCount} hits so far (${agentHits} by this agent)`);

  // W17: one nonce authority for the account: the batched hits and the ERC-8004 register tx.
  const nonces = createNonceSource(() => clients.batchHttp.getTransactionCount({ address: clients.account.address, blockTag: 'pending' }));

  // Review H9: registration runs alongside the loop and never delays the first bar.
  const identity = startIdentity({
    chainId: config.chainId,
    agentAddress: clients.account.address,
    agentURI: buildAgentURI(clients.account.address, config.chainId),
    chain: createChainIdentity(clients, nonces),
    store: createFileStore(config.statePath),
    log,
    registryOverride: config.identityRegistry ?? undefined,
  });

  // W12/W14/W14b: AGENT_BRAIN=anthropic|openai|gemini|rules (default: anthropic with a Claude key, else
  // openai (the live DJ: gpt-6-luna, reasoning none), else gemini (dormant), else rules).
  // W17: one rules instance is the LLM's menu and its fallback, so both hold the same per-cycle choices.
  const rules = createRulesBrain();
  const selected = selectBrain(
    config,
    { anthropic: createAnthropicCompleter, openai: createOpenAiCompleter, gemini: createGeminiCompleter },
    { rules, log: (m) => log.info(m), ...(config.debugLlm ? { debug: (m: string) => log.info(`debug ${m}`) } : {}) },
  );
  const llm = selected.primary;
  if (!llm) log.warn(`brain: rules only (AGENT_BRAIN=${config.brain}; set OPENAI_API_KEY (or ANTHROPIC_API_KEY / GEMINI_API_KEY) for an LLM brain)`);
  else log.info(`brain: ${selected.label}${config.brain === 'gemini' ? `, ${config.geminiRpm === 0 ? 'no request cap' : `at most ${config.geminiRpm} requests/min (GEMINI_RPM)`}` : ''}`);
  const brain = createFallbackBrain({ primary: llm, fallback: rules, warn: (m) => log.warn(m) });

  const clock = createBlockClock({ headSource: createChainHeadSource({ ws: clients.ws, http: clients.http, warn: (m) => log.warn(m) }) });
  clock.onError((e) => log.warn(`head source: ${e.message}`));
  const reader = createPatternReader({
    client: clients.http,
    address: config.blockbeatAddress,
    sessionId: config.sessionId,
    agentAddress: clients.account.address,
    startBlock: session.startBlock,
    decay: config.decay,
  });
  const hits = createHitLogStream({ ws: clients.ws, http: clients.http, address: config.blockbeatAddress, sessionId: config.sessionId, warn: (m) => log.warn(m) });
  const scheduler = createScheduler({
    clock,
    sender: createChainHitSender({
      wallet: clients.wallet,
      publicClient: clients.http,
      address: config.blockbeatAddress,
      sessionId: config.sessionId,
      hasHitBefore: agentHits > 0n,
      hits,
      warn: (m) => log.warn(m),
      // W17: the notes of one step are signed locally and broadcast in one ordered batch.
      batch: { signer: clients.account, rpc: clients.batchHttp, chainId: config.chainId, nonces },
    }),
    startBlock: session.startBlock,
    maxHits: config.maxHitsPerSession,
    enabled: () => config.enabled,
    log,
  });
  const loop = createAgentLoop({
    clock,
    reader,
    brain,
    scheduler,
    startBlock: session.startBlock,
    log,
    bars: config.bars,
    showGrid: process.env.AGENT_SHOW_GRID === '1',
    identityLabel: identity.label,
    readSession: () => readSession(clients.http, config.blockbeatAddress, config.sessionId),
    music: { key: config.key },
    maxNotesPerBar: config.maxNotesPerBar,
    lifetimeBars: config.decay.lifetimeBars,
    startBar: config.setStartBar,
  });

  // One shared shutdown: whoever triggers it first (signal or the finite-bars path) runs
  // it, everyone else awaits the same promise, so the summary is written exactly once.
  let shutdownPromise: Promise<void> | null = null;
  function shutdown(reason: string): Promise<void> {
    shutdownPromise ??= (async () => {
      log.info(`${reason}: stopping after in-flight hits settle`);
      await Promise.race([loop.stop(), new Promise((r) => setTimeout(r, 5000))]);
      hits.stop();
      clock.stop();
      const s = scheduler.stats();
      log.info(`summary: bars ${loop.barsHandled()} | sent ${s.sent} | confirmed ${s.confirmed} | on-step ${s.matched} (${s.confirmed === 0 ? '-' : `${Math.round(s.matchRate * 100)}%`}) | failed ${s.failed} | skipped ${s.skipped} | cancelled ${s.cancelled} | gas ${s.gasUsed} | MON ${formatMon(s.feeWei)} | budget left ${s.budgetLeft} | brain ${brain.lastLabel()} | ${identity.label()}`);
    })();
    return shutdownPromise;
  }
  function onSignal(signal: string): void {
    shutdown(signal)
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        process.stderr.write(`agent: shutdown failed: ${redactSecrets(error instanceof Error ? error.message : String(error))}\n`);
        process.exit(1);
      });
  }
  process.once('SIGINT', () => onSignal('SIGINT'));
  process.once('SIGTERM', () => onSignal('SIGTERM'));

  clock.start();
  loop.start();
  log.info(`listening for heads; acting once per bar (${STEPS} blocks)${config.bars ? `, ${config.bars} bars` : ''}`);
  await loop.done;
  if (loop.finalized()) {
    await shutdown('session finalized');
    process.exit(0);
  }
  if (config.bars !== null) {
    log.info(`${config.bars} bars planned; waiting for the last bar's hits to land`);
    await Promise.race([scheduler.settle(), new Promise((r) => setTimeout(r, 30_000))]);
    await shutdown(`${config.bars} bars done`);
    process.exit(0);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`agent: ${redactSecrets(error instanceof Error ? error.message : String(error))}\n`);
  process.exit(1);
});
