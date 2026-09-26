/**
 * W19 crowd simulator: N virtual players that sound like a room, for rehearsals and as the
 * plan B on stage (say honestly that they are simulated players).
 *
 *   pnpm --filter scripts crowd -- --session 12 --players 10 --minutes 3
 *   pnpm --filter scripts crowd -- --session 12 --players 10 --minutes 2 --max-mon 1.0 --seed 5
 *   pnpm --filter scripts crowd -- --sweep-only          # return what a failed run left in its burners
 *   pnpm --filter scripts crowd -- --ui --players 5 --session 12   # headed phone windows on the join page
 *
 * Flags: --session --players (1..30) --minutes (≤15) --max-mon (default 1.5, ≤5) --seed
 *        --notes-per-player --rps (default 15) --block-ms --hit-timeout-ms --note
 *        --rpc --ws --chain-id --address --sweep-only
 *        --ui (visible mode, ≤6 phones, --play tap (default) | aim) --base-url (default NEXT_PUBLIC_JOIN_BASE_URL from apps/web/.env.local)
 * Funder: FUNDER_PRIVATE_KEY, else DRIP_PRIVATE_KEY (env or ~/.blockbeat/keys.env). Burner keys
 * go to scripts/.crowd/ (mode 600, gitignored) before any funding. No key is ever printed.
 * SIGINT or SIGTERM stops the players and sweeps; a second one exits at once (then --sweep-only).
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { formatEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { parseCrowdArgs } from './lib/crowd/args';
import { createCrowdChain } from './lib/crowd/chain';
import { CrowdAbortError, formatMon, runCrowd, sweepPending } from './lib/crowd/engine';
import { createKeystore, type KeystoreFs } from './lib/crowd/keystore';
import { renderVisibleMarkdown, writeCrowdReport } from './lib/crowd/report';
import { openPlaywrightPhone } from './lib/crowd/ui/playwright';
import { runVisibleCrowd } from './lib/crowd/ui/visible';
import { parseKeysEnv } from './lib/env';
import { createLogger, loadEnv, runMain, secretsOf } from './lib/cli';
import { redactSecrets, redactUrl, resolveKey, urlSecrets } from './lib/env';

const env = loadEnv();
const secrets = secretsOf(env);
const scriptsRoot = resolve(import.meta.dirname, '..');
const repoRoot = resolve(scriptsRoot, '..');

/** The public join URL the stage shows (only this one variable is read from the web env file). */
function joinBaseFromWebEnv(): string | null {
  const file = resolve(repoRoot, 'apps/web/.env.local');
  if (!existsSync(file)) return null;
  const value = parseKeysEnv(readFileSync(file, 'utf8'))['NEXT_PUBLIC_JOIN_BASE_URL']?.trim().replace(/\/+$/, '');
  return value ? value : null;
}

const keystoreFs: KeystoreFs = {
  mkdir: (p, mode) => {
    mkdirSync(p, { recursive: true, mode });
    chmodSync(p, mode);
  },
  writeFile: (p, text, mode) => {
    writeFileSync(p, text, { mode });
    chmodSync(p, mode);
  },
  readFile: (p) => readFileSync(p, 'utf8'),
  list: (dir) => (existsSync(dir) ? readdirSync(dir) : []),
  rename: (from, to) => renameSync(from, to),
};

async function main(): Promise<number> {
  const args = parseCrowdArgs(process.argv.slice(2), env);
  secrets.push(...urlSecrets(args.rpc), ...urlSecrets(args.ws));
  const log = createLogger(secrets);
  const onSecret = (key: string): void => void secrets.push(key);
  const keystore = createKeystore(resolve(scriptsRoot, '.crowd'), keystoreFs);
  const chain = createCrowdChain({ chainId: args.chainId, rpc: args.rpc, ws: args.ws, address: args.address, pollingIntervalMs: args.blockMs, onWarn: log });
  const ac = new AbortController();
  let signals = 0;
  const onSignal = (sig: NodeJS.Signals): void => {
    signals += 1;
    if (signals === 1) {
      log(`crowd: ${sig}: stopping the players, then sweeping (send ${sig} again to exit at once)`);
      ac.abort();
      return;
    }
    log('crowd: exiting without a full sweep; the keys are in scripts/.crowd/, run: pnpm --filter scripts crowd -- --sweep-only');
    process.exit(130);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  try {
    const actual = await chain.getChainId();
    if (actual !== args.chainId) throw new Error(`--chain-id ${args.chainId} but the RPC at ${redactUrl(args.rpc)} reports chain ${actual}`);

    if (args.mode === 'sweep-only') {
      const result = await sweepPending({ keystore, chain, chainId: args.chainId, blockMs: args.blockMs, log, rps: args.rps, onSecret });
      return result.failed.length === 0 ? 0 : 2;
    }

    const funder = resolveKey({ chainId: args.chainId, env, role: 'drip' });
    secrets.push(funder.key);
    if (args.ui) {
      const baseUrl = args.ui.baseUrl ?? joinBaseFromWebEnv();
      if (!baseUrl) throw new Error('--ui needs the join URL: pass --base-url https://… or set NEXT_PUBLIC_JOIN_BASE_URL in apps/web/.env.local');
      const dripAddress = privateKeyToAccount(funder.key).address;
      log(`crowd --ui: ${args.players} phones on ${baseUrl}/join/${args.sessionId.toString()}; burners are swept back to the drip ${dripAddress}; seed ${args.seed}`);
      let visible;
      try {
        visible = await runVisibleCrowd(
          {
            chainId: args.chainId,
            contract: args.address,
            sessionId: args.sessionId,
            players: args.players,
            minutes: args.minutes,
            baseUrl,
            seed: args.seed,
            maxWei: args.maxWei,
            funder: dripAddress,
            keystore,
            log,
            signal: ac.signal,
            onSecret,
            playMode: args.ui.play,
            ...(args.ui.snapshotAtBar !== null ? { snapshotAtBar: args.ui.snapshotAtBar, snapshotDir: resolve(repoRoot, 'docs/evidence/w19-crowd') } : {}),
          },
          {
            openPhone: (url, rect) => openPlaywrightPhone(url, rect, log),
            chain,
            sweep: () => sweepPending({ keystore, chain, chainId: args.chainId, blockMs: args.blockMs, log, rps: args.rps, onSecret }),
          },
        );
      } catch (error) {
        if (error instanceof CrowdAbortError) {
          log(`crowd: refused: ${error.message}`);
          return 3;
        }
        throw error;
      }
      const ratio = visible.landed === 0 ? 0 : Math.round((100 * visible.onStep) / visible.landed);
      log(`crowd summary: players ${visible.ready}/${args.players} | sent ${visible.aimed} | confirmed ${visible.landed} | on-step ${ratio}% | spent ${formatMon(visible.spentWeiEstimate)} MON | swept ${formatMon(visible.sweep.sweptWei)} MON | left in burners ${visible.sweep.failed.length} | stop ${visible.stopReason}`);
      const dir = resolve(repoRoot, 'docs/evidence/crowd');
      mkdirSync(dir, { recursive: true });
      const stem = resolve(dir, `crowd-ui-${visible.startedAt.replace(/[:.]/g, '-')}-s${args.sessionId.toString()}`);
      const meta = { chainId: args.chainId, chainName: args.chainName, rpc: redactUrl(args.rpc), address: args.address, sessionId: args.sessionId.toString(), players: args.players, minutes: args.minutes, maxMon: formatEther(args.maxWei), seed: args.seed, note: args.note };
      writeFileSync(`${stem}.json`, `${redactSecrets(JSON.stringify({ meta, ...visible }, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v), 2), secrets)}\n`);
      writeFileSync(`${stem}.md`, redactSecrets(renderVisibleMarkdown(meta, visible), secrets));
      log(`wrote ${stem}.json and ${stem}.md`);
      return visible.sweep.failed.length === 0 ? 0 : 2;
    }
    log(`crowd: ${args.chainName} (${args.chainId}) rpc ${redactUrl(args.rpc)} contract ${args.address}; funder ${privateKeyToAccount(funder.key).address} (key from ${funder.source}); seed ${args.seed}`);
    let result;
    try {
      result = await runCrowd(
        {
          chainId: args.chainId,
          contract: args.address,
          sessionId: args.sessionId,
          players: args.players,
          minutes: args.minutes,
          maxWei: args.maxWei,
          seed: args.seed,
          blockMs: args.blockMs,
          hitTimeoutMs: args.hitTimeoutMs,
          funderKey: funder.key,
          notesPerPlayer: args.notesPerPlayer,
          rps: args.rps,
          lifetimeBars: args.lifetimeBars,
          maxLivePerTrack: args.maxLivePerTrack,
          keystore,
          log,
          signal: ac.signal,
          onSecret,
        },
        chain,
      );
    } catch (error) {
      if (error instanceof CrowdAbortError) {
        log(`crowd: refused: ${error.message}`);
        return 3;
      }
      throw error;
    }
    const s = result.summary;
    const ratio = s.confirmed === 0 ? 0 : Math.round((100 * s.onStep) / s.confirmed);
    log(
      `crowd summary: players ${result.funded}/${args.players} | sent ${s.sent} | confirmed ${s.confirmed} | on-step ${ratio}% | p50 ${s.latencyP50Ms ?? 'n/a'} ms | p95 ${s.latencyP95Ms ?? 'n/a'} ms | spent ${formatMon(s.spentWei)} MON | swept ${formatMon(result.sweep.sweptWei)} MON | left in burners ${result.sweep.failed.length} | stop ${result.stopReason}`,
    );
    log(`funder ${formatEther(result.funderBeforeWei)} → ${formatEther(result.funderAfterWei)} MON`);
    const out = writeCrowdReport({
      meta: { chainId: args.chainId, chainName: args.chainName, rpc: redactUrl(args.rpc), address: args.address, sessionId: args.sessionId.toString(), players: args.players, minutes: args.minutes, maxMon: formatEther(args.maxWei), seed: args.seed, note: args.note },
      result,
      dir: resolve(repoRoot, 'docs/evidence/crowd'),
      fs: { writeFile: (p, c) => writeFileSync(p, c), mkdir: (p) => mkdirSync(p, { recursive: true }) },
      scrub: (text) => redactSecrets(text, secrets),
    });
    log(`wrote ${out.jsonPath} and ${out.markdownPath}`);
    return result.sweep.failed.length === 0 ? 0 : 2;
  } finally {
    await chain.close();
  }
}

runMain(main, () => secrets);
