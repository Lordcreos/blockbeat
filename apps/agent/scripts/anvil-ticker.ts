/**
 * Drive anvil at Monad's cadence: `anvil --no-mining` plus this ticker calling anvil_mine
 * every TICK_MS (default 300). Usage: pnpm --filter agent tick
 */
const url = process.env.AGENT_RPC_URL ?? 'http://127.0.0.1:8545';
const tickMs = Number(process.env.TICK_MS ?? 300);
let id = 0;
let inFlight = false;

async function mine(): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'anvil_mine', params: ['0x1'] }),
    });
    if (!res.ok) throw new Error(`anvil_mine HTTP ${res.status}`);
  } catch (error) {
    process.stderr.write(`ticker: ${error instanceof Error ? error.message : String(error)}\n`);
  } finally {
    inFlight = false;
  }
}

process.stdout.write(`ticker: anvil_mine every ${tickMs} ms at ${url}\n`);
const timer = setInterval(() => void mine(), tickMs);
process.once('SIGINT', () => {
  clearInterval(timer);
  process.exit(0);
});
