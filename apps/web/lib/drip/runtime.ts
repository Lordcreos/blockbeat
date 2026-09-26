/**
 * Process-wide drip service for the API route. Built lazily from env; in mock mode no key
 * is needed and no transaction is sent.
 */
import { createBurnerWalletClient, createHttpClient, getRpcUrls, isMockMode } from '../chain/clients';
import { createChainDripSender, dripAccountFromEnv } from './sender';
import { createDripService, dripLimitsFromEnv, type DripService } from './service';

let service: DripService | null = null;

export function getDripService(): DripService {
  if (service) return service;
  const mock = isMockMode();
  const account = mock ? null : dripAccountFromEnv(process.env);
  const rpcHttp = process.env.MONAD_RPC_URL?.trim() || getRpcUrls().http;
  const client = createHttpClient(rpcHttp);
  const sender = account
    ? createChainDripSender({
        wallet: createBurnerWalletClient(account, rpcHttp),
        receipts: client,
        pacing: { getBalance: () => client.getBalance({ address: account.address }), getBlockNumber: () => client.getBlockNumber({ cacheTime: 0 }) },
        ...(process.env.DRIP_AMOUNT_MON?.trim() ? { amountMon: process.env.DRIP_AMOUNT_MON.trim() } : {}),
      })
    : null;
  // W12: top-ups check the burner balance on the same RPC the drip sends through.
  const balanceOf = mock ? undefined : (address: `0x${string}`) => client.getBalance({ address });
  service = createDripService({ sender, mock, ...(balanceOf ? { balanceOf } : {}), ...dripLimitsFromEnv(process.env) });
  return service;
}
