/**
 * Prints the drip, deployer and agent addresses and balances on the selected chain and
 * warns when the drip wallet cannot fund --players (default 60) at DRIP_AMOUNT_MON plus
 * the gas of one hit budget per player.
 *
 *   pnpm --filter scripts fund-drip -- [--chain-id 10143] [--players 60] [--drip-mon 0.05]
 */
import { createPublicClient, formatEther, http, parseEther, type Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { DRIP_AMOUNT_MON, HIT_GAS_LIMIT, MONAD_TESTNET_FAUCET, chainById, explorerAddressUrl } from '@blockbeat/shared';
import { parseFundDripArgs } from './lib/args';
import { createLogger, loadEnv, runMain, secretsOf } from './lib/cli';
import { redactUrl, resolveKey, urlSecrets, type Role } from './lib/env';
import { TRANSFER_GAS } from './lib/runner';

const env = loadEnv();
const secrets = secretsOf(env);

const ROLE_ADDRESS_ENV: Record<Role, string> = { deployer: 'DEPLOYER_ADDRESS', drip: 'DRIP_ADDRESS', agent: 'AGENT_ADDRESS' };

function addressFor(role: Role, chainId: number, warn: (line: string) => void): { address: Address; source: string } | null {
  try {
    const { key, source } = resolveKey({ chainId, env, role });
    secrets.push(key);
    return { address: privateKeyToAccount(key).address, source };
  } catch (err) {
    const fromEnv = env[ROLE_ADDRESS_ENV[role]];
    if (fromEnv && /^0x[0-9a-fA-F]{40}$/.test(fromEnv)) return { address: fromEnv as Address, source: ROLE_ADDRESS_ENV[role] };
    const message = err instanceof Error ? err.message : String(err);
    warn(`${role}: no key or address available (${message})`);
    return null;
  }
}

async function main(): Promise<number> {
  const opts = parseFundDripArgs(process.argv.slice(2), env, DRIP_AMOUNT_MON);
  secrets.push(...urlSecrets(opts.rpc));
  const log = createLogger(secrets);
  const chain = chainById(opts.chainId);
  const client = createPublicClient({ chain, transport: http(opts.rpc, { retryCount: 1 }) });
  const actualChainId = await client.getChainId();
  if (actualChainId !== opts.chainId) throw new Error(`--chain-id ${opts.chainId} but the RPC at ${redactUrl(opts.rpc)} reports chain ${actualChainId}`);
  const [block, fees] = await Promise.all([client.getBlockNumber(), client.estimateFeesPerGas()]);
  log(`fund-drip: ${opts.chainName} (${opts.chainId}) rpc ${opts.rpc} block ${block} maxFeePerGas ${fees.maxFeePerGas} wei`);

  const roles: Role[] = ['drip', 'deployer', 'agent'];
  const balances = new Map<Role, bigint>();
  for (const role of roles) {
    const who = addressFor(role, opts.chainId, log);
    if (!who) continue;
    const balance = await client.getBalance({ address: who.address });
    balances.set(role, balance);
    const link = opts.chainId === 10143 ? ` ${explorerAddressUrl(who.address)}` : '';
    log(`${role.padEnd(8)} ${who.address} ${formatEther(balance).padStart(14)} MON (${who.source})${link}`);
  }

  const dripBalance = balances.get('drip');
  if (dripBalance === undefined) {
    log(`drip: cannot check coverage without the drip address`);
    return 1;
  }
  const perPlayer = parseEther(opts.dripAmountMon) + TRANSFER_GAS * fees.maxFeePerGas;
  const needed = perPlayer * BigInt(opts.players);
  const hitReserve = HIT_GAS_LIMIT * fees.maxFeePerGas;
  const hitsPerDrip = hitReserve > 0n ? parseEther(opts.dripAmountMon) / hitReserve : 0n;
  log(`coverage: ${opts.players} players × (${opts.dripAmountMon} MON + drip gas) = ${formatEther(needed)} MON needed; each drip covers about ${hitsPerDrip} hits at the ${HIT_GAS_LIMIT} gas limit`);
  if (dripBalance < needed) {
    const shortfall = needed - dripBalance;
    log(`WARNING: drip wallet is short by ${formatEther(shortfall)} MON for ${opts.players} players. Top up from ${MONAD_TESTNET_FAUCET} or move MON from the deployer.`);
    return 2;
  }
  const players = perPlayer > 0n ? dripBalance / perPlayer : 0n;
  log(`ok: drip wallet covers ${players} players at ${opts.dripAmountMon} MON each`);
  return 0;
}

runMain(main, () => secrets);
