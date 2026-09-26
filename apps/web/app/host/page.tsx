import type { Metadata } from 'next';
import { HostView, type RecentSession } from '@/components/host/HostView';
import { createHttpClient, getRpcUrls, isMockMode, runtimeAddress } from '@/lib/chain/clients';
import { readRecentSessions } from '@/lib/track/list';

export const metadata: Metadata = { title: 'Host · Blockbeat' };

/** Session states change as the host plays; read them on every view (9 eth_calls, spaced). */
export const dynamic = 'force-dynamic';

/** How many sessions /host lists. */
const RECENT_SESSIONS = 8;

async function loadRecent(): Promise<{ recent: RecentSession[] | null; recentError: string | null }> {
  // The simulator keeps no session list: the page shows the sessions created in this tab.
  if (isMockMode()) return { recent: [], recentError: null };
  try {
    const client = createHttpClient(process.env.MONAD_RPC_URL?.trim() || getRpcUrls().http);
    const sessions = await readRecentSessions({ client, address: runtimeAddress(), limit: RECENT_SESSIONS });
    return {
      recent: sessions.map((s) => ({ sessionId: s.sessionId.toString(), finalized: s.finalized, tokenId: s.tokenId.toString(), hits: s.hitCount.toString() })),
      recentError: null,
    };
  } catch (error) {
    // viem messages embed the RPC URL (and any provider key in it): log it here, show a short reason.
    console.error('host: reading recent sessions failed', error);
    return { recent: null, recentError: 'the RPC did not answer' };
  }
}

export default async function HostPage() {
  const { recent, recentError } = await loadRecent();
  return <HostView recent={recent} recentError={recentError} />;
}
