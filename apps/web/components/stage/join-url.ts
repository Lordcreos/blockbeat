/**
 * Stage-side sanity checks for the join URL (review C2): phones on mobile data cannot
 * reach a laptop-local origin, so the stage must shout when the QR would encode one.
 */

const PRIVATE_HOST = /^(localhost|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|0\.0\.0\.0|\[::1\])$/i;

/** True when the URL's host is loopback or RFC1918, i.e. unreachable from the audience. */
export function isLaptopOnlyOrigin(url: string): boolean {
  if (!url) return false;
  try {
    return PRIVATE_HOST.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

export interface StageWarning {
  id: 'mock' | 'local-qr';
  title: string;
  detail: string;
}

/** Warnings the presenter must see before the pitch. Empty when the stage is safe. */
export function stageWarnings(input: { source: string; joinBase: string; joinBaseFromEnv: boolean }): StageWarning[] {
  const out: StageWarning[] = [];
  if (input.source === 'mock') {
    out.push({
      id: 'mock',
      title: 'Simulator, no chain',
      detail: 'Nothing on this screen exists on Monad. Set NEXT_PUBLIC_BLOCKBEAT_ADDRESS and restart the dev server.',
    });
  }
  if (!input.joinBaseFromEnv && isLaptopOnlyOrigin(input.joinBase)) {
    out.push({
      id: 'local-qr',
      title: 'QR points at this laptop',
      detail: `Phones cannot reach ${input.joinBase}. Start the tunnel, set NEXT_PUBLIC_JOIN_BASE_URL to it and restart the dev server.`,
    });
  }
  return out;
}
