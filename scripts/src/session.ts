/**
 * Session ops for the host before the pitch.
 *
 *   pnpm --filter scripts session -- --start                 # start a session, print its id
 *   pnpm --filter scripts session -- --status 1              # print a session's state
 *   pnpm --filter scripts session -- --finalize 1            # finalize and mint (host only)
 *   pnpm --filter scripts session -- --start --chain-id 31337 --address 0x...
 *
 * Host key: FUNDER_PRIVATE_KEY, else DEPLOYER_PRIVATE_KEY (env or ~/.blockbeat/keys.env),
 * else anvil account 0 on chain 31337. Never printed.
 */
import { createPublicClient, createWalletClient, formatEther, http, parseEventLogs } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { FINALIZE_GAS_LIMIT, START_SESSION_GAS_LIMIT, blockbeatAbi, chainById, explorerTokenUrl, explorerTxUrl } from '@blockbeat/shared';
import { parseSessionArgs } from './lib/args';
import { createLogger, loadEnv, runMain, secretsOf } from './lib/cli';
import { redactUrl, resolveKey, urlSecrets } from './lib/env';

const env = loadEnv();
const secrets = secretsOf(env);
// Monad charges the gas LIMIT: the same fixed limits as the web host routes (review L10).
const START_SESSION_GAS = START_SESSION_GAS_LIMIT;
const FINALIZE_GAS = FINALIZE_GAS_LIMIT;

async function main(): Promise<number> {
  const opts = parseSessionArgs(process.argv.slice(2), env);
  secrets.push(...urlSecrets(opts.rpc));
  const log = createLogger(secrets);
  const chain = chainById(opts.chainId);
  const publicClient = createPublicClient({ chain, transport: http(opts.rpc, { retryCount: 1 }) });
  const actualChainId = await publicClient.getChainId();
  if (actualChainId !== opts.chainId) throw new Error(`--chain-id ${opts.chainId} but the RPC at ${redactUrl(opts.rpc)} reports chain ${actualChainId}`);
  const isTestnet = opts.chainId === 10143;

  if (opts.status !== null) {
    const s = await publicClient.readContract({ address: opts.address, abi: blockbeatAbi, functionName: 'getSession', args: [opts.status] });
    const head = await publicClient.getBlockNumber();
    log(`session ${opts.status}: startBlock ${s.startBlock} host ${s.host} finalized ${s.finalized} hits ${s.hitCount} tokenId ${s.tokenId} parent ${s.parentSessionId} tipPool ${formatEther(s.tipPool)} MON; head ${head}, step ${s.startBlock === 0n ? 'n/a' : Number((head - s.startBlock) % 16n)}`);
    if (!opts.start && opts.finalize === null) return 0;
  }

  const host = resolveKey({ chainId: opts.chainId, env, role: 'deployer' });
  secrets.push(host.key);
  const account = privateKeyToAccount(host.key);
  const wallet = createWalletClient({ account, chain, transport: http(opts.rpc, { retryCount: 1 }) });
  const balance = await publicClient.getBalance({ address: account.address });
  log(`host ${account.address} (${host.source}) balance ${formatEther(balance)} MON on ${opts.chainName}; contract ${opts.address}`);

  if (opts.start) {
    const hash = await wallet.writeContract({ address: opts.address, abi: blockbeatAbi, functionName: 'startSession', gas: START_SESSION_GAS });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error(`startSession reverted in tx ${hash}`);
    const [started] = parseEventLogs({ abi: blockbeatAbi, eventName: 'SessionStarted', logs: receipt.logs });
    if (!started) throw new Error(`no SessionStarted event in tx ${hash}`);
    log(`started session ${started.args.sessionId} at block ${started.args.startBlock} (tx ${hash}${isTestnet ? ` ${explorerTxUrl(hash)}` : ''})`);
    log(`SESSION_ID=${started.args.sessionId}`);
  }

  if (opts.finalize !== null) {
    const hash = await wallet.writeContract({ address: opts.address, abi: blockbeatAbi, functionName: 'finalize', args: [opts.finalize], gas: FINALIZE_GAS });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error(`finalize reverted in tx ${hash}`);
    const [finalized] = parseEventLogs({ abi: blockbeatAbi, eventName: 'Finalized', logs: receipt.logs });
    if (!finalized) throw new Error(`no Finalized event in tx ${hash}`);
    log(`finalized session ${opts.finalize}: token ${finalized.args.tokenId}, ${finalized.args.contributors} contributors (tx ${hash}${isTestnet ? ` ${explorerTokenUrl(opts.address, finalized.args.tokenId)}` : ''})`);
  }
  return 0;
}

runMain(main, () => secrets);
