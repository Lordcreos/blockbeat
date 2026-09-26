/**
 * Blockbeat load test.
 *
 *   pnpm --filter scripts loadtest -- --chain-id 31337 --address 0x... --session 1 --wallets 40 --hits 30
 *   pnpm --filter scripts loadtest -- --wallets 40 --hits 30 --window-ms 60000 --rps 50   # Monad testnet
 *
 * Flags: --rpc --ws --chain-id --address --session --wallets --hits --window-ms --rps
 *        --block-ms --lag-blocks --hit-timeout-ms --seed --sweep --receipts all|sample|none
 *        --fund-mon <MON per wallet> --note "<text>" --allow-over-limit
 * Funder: FUNDER_PRIVATE_KEY, else DRIP_PRIVATE_KEY (env or ~/.blockbeat/keys.env), else
 * anvil account 0 on chain 31337. Keys are never printed.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseLoadtestArgs } from './lib/args';
import { createViemAdapter } from './lib/chain';
import { createLogger, loadEnv, runMain, secretsOf } from './lib/cli';
import { redactSecrets, redactUrl, resolveKey, urlSecrets } from './lib/env';
import { renderRunSection, writeReport, type MemoryFs, type RunMeta } from './lib/report';
import { runLoadTest } from './lib/runner';

const env = loadEnv();
const secrets = secretsOf(env);

const diskFs: MemoryFs = {
  readFile: (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null),
  writeFile: (p, c) => writeFileSync(p, c),
  mkdir: (p) => mkdirSync(p, { recursive: true }),
};

async function main(): Promise<number> {
  const opts = parseLoadtestArgs(process.argv.slice(2), env);
  secrets.push(...urlSecrets(opts.rpc), ...urlSecrets(opts.ws));
  const log = createLogger(secrets);
  const chain = createViemAdapter({ chainId: opts.chainId, rpc: opts.rpc, ws: opts.ws, address: opts.address, pollingIntervalMs: opts.blockMs, onWarn: log });
  let result;
  try {
    // The key is chosen by chain id (anvil accounts on 31337), so the RPC must agree before any signing.
    const actualChainId = await chain.http.getChainId();
    if (actualChainId !== opts.chainId) throw new Error(`--chain-id ${opts.chainId} but the RPC at ${redactUrl(opts.rpc)} reports chain ${actualChainId}`);
    const funder = resolveKey({ chainId: opts.chainId, env, role: 'drip' });
    secrets.push(funder.key);
    log(`loadtest: ${opts.chainName} (${opts.chainId}) rpc ${opts.rpc} ws ${opts.ws || '(polling)'} contract ${opts.address} session ${opts.sessionId}`);
    log(`plan: ${opts.wallets} wallets × ${opts.hits} hits over ${opts.windowMs} ms at ${opts.rps} rps; funder key from ${funder.source}`);

    // Without a WebSocket URL viem polls eth_blockNumber and eth_getFilterChanges every
    // blockMs outside the bucket; reserve that budget so the total stays under --rps.
    const pollingRps = opts.ws ? 0 : Math.ceil(2000 / opts.blockMs);
    const rps = Math.max(1, opts.rps - pollingRps);
    if (pollingRps > 0) log(`warning: no --ws, heads and Hit logs are polled every ${opts.blockMs} ms (~${pollingRps} rps outside the bucket); send budget reduced to ${rps} rps`);

    result = await runLoadTest({ ...opts, rps, funderKey: funder.key, log }, chain);
  } finally {
    await chain.close();
  }

  const meta: RunMeta = {
    startedAt: result.startedAt,
    chainId: opts.chainId,
    chainName: opts.chainName,
    rpc: redactUrl(opts.rpc),
    ws: redactUrl(opts.ws),
    address: opts.address,
    sessionId: opts.sessionId.toString(),
    wallets: opts.wallets,
    hitsPerWallet: opts.hits,
    windowMs: opts.windowMs,
    rps: opts.rps,
    blockMs: opts.blockMs,
    measuredBlockMs: result.measuredBlockMs,
    lagBlocks: opts.lagBlocks,
    ...(opts.note ? { note: opts.note } : {}),
  };
  const repoRoot = resolve(process.cwd(), '..');
  const out = writeReport({
    meta,
    summary: result.summary,
    evidenceDir: resolve(repoRoot, 'docs/evidence/loadtest'),
    markdownPath: resolve(repoRoot, 'docs/evidence/loadtest.md'),
    fs: diskFs,
    scrub: (text) => redactSecrets(text, secrets),
    extra: { funder: result.funder, fundWeiPerWallet: result.fundWeiPerWallet, sweptWei: result.sweptWei, wallets: result.wallets, records: result.records },
  });
  log('\n' + renderRunSection(meta, result.summary));
  log(`wrote ${out.jsonPath} and ${out.markdownPath}`);
  return result.summary.hits.confirmed === result.summary.hits.total ? 0 : 2;
}

runMain(main, () => secrets);
