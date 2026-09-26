/**
 * Process-wide drip service for the API route. Built lazily from env; in mock mode no key
 * is needed and no transaction is sent.
 */
import { createBurnerWalletClient, createHttpClient, getRpcUrls, isMockMode } from '../chain/clients';
import { createChainDripSender, dripAccountFromEnv } from './sender';
import { createDripService, dripLimitsFromEnv, type DripSender, type DripService } from './service';
import { createTipperDripService, tipperAmountFromEnv, tipperLimitsFromEnv, type TipperDripService } from './tipper';

let service: DripService | null = null;
let tipperService: TipperDripService | null = null;
let shared: { sender: DripSender | null; client: ReturnType<typeof createHttpClient> } | null = null;

/** W21b: one sender for the player and the tipper drips, so the drip key keeps one nonce queue and one reserve pacing. */
function dripSender(): { sender: DripSender | null; client: ReturnType<typeof createHttpClient> } {
  if (shared) return shared;
  const account = isMockMode() ? null : dripAccountFromEnv(process.env);
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
  shared = { sender, client };
  return shared;
}

export function getDripService(): DripService {
  if (service) return service;
  const mock = isMockMode();
  const { sender, client } = dripSender();
  // W12: top-ups check the burner balance on the same RPC the drip sends through.
  const balanceOf = mock ? undefined : (address: `0x${string}`) => client.getBalance({ address });
  service = createDripService({ sender, mock, ...(balanceOf ? { balanceOf } : {}), ...dripLimitsFromEnv(process.env) });
  return service;
}

/** W21b: the tip page's drip (`mode: "tipper"`), with its own caps (lib/drip/tipper.ts). */
export function getTipperDripService(): TipperDripService {
  tipperService ??= createTipperDripService({
    sender: dripSender().sender,
    mock: isMockMode(),
    amountWei: tipperAmountFromEnv(process.env),
    limits: tipperLimitsFromEnv(process.env),
  });
  return tipperService;
}
