/**
 * Full flow against a real chain (local anvil): host → stage → phone tap → cell lights on
 * the same step → agent hit in the agent colour → tip → finalize mints → /track renders.
 *
 * Gated on BLOCKBEAT_E2E_ANVIL=1 (read from apps/web/.env.local by playwright.config.ts).
 * Needs: anvil running, Blockbeat deployed, the dev server on :3000 with NEXT_PUBLIC_CHAIN_ID,
 * NEXT_PUBLIC_BLOCKBEAT_ADDRESS, DRIP_PRIVATE_KEY, HOST_PRIVATE_KEY, HOST_SECRET,
 * NEXT_PUBLIC_AGENT_ADDRESS and AGENT_PRIVATE_KEY (the test sends one hit as the agent).
 * Records both contexts to docs/evidence/w5-integration/ with screenshots of each step.
 */
import { test, expect, devices, type Browser, type BrowserContext, type Page } from '@playwright/test';
import os from 'node:os';
import path from 'node:path';
import { createPublicClient, createWalletClient, http, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { HIT_GAS_LIMIT_FIRST, TRACK_META, blockbeatAbi, chainById } from '@blockbeat/shared';
import { isChainMode } from './env';

const OUT = path.resolve(__dirname, '../../../docs/evidence/w5-integration');
const ENABLED = process.env.BLOCKBEAT_E2E_ANVIL?.trim() === '1' && isChainMode();

test.describe('anvil end to end', () => {
  test.skip(!ENABLED, 'set BLOCKBEAT_E2E_ANVIL=1 with the dev server on a real chain');
  test.setTimeout(120_000);

  let stageCtx: BrowserContext;
  let phoneCtx: BrowserContext;

  test.afterEach(async () => {
    await Promise.all([stageCtx?.close(), phoneCtx?.close()]);
  });

  async function record(browser: Browser, options: Parameters<Browser['newContext']>[0]): Promise<BrowserContext> {
    // Raw recordings land in the OS temp dir; the two we keep are saved into OUT at the end.
    return browser.newContext({ ...options, recordVideo: { dir: path.join(os.tmpdir(), 'blockbeat-e2e-video'), size: options?.viewport ?? undefined } });
  }

  async function shot(page: Page, name: string): Promise<void> {
    await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: false });
  }

  test('host starts, phone taps, cell lights on the same step, agent colour, tip, finalize, track', async ({ browser, page: host }, info) => {
    test.skip(info.project.name !== 'stage', 'runs once, from the stage project');
    const secret = process.env.HOST_SECRET ?? '';
    const agentKey = process.env.AGENT_PRIVATE_KEY?.trim();
    const contract = process.env.NEXT_PUBLIC_BLOCKBEAT_ADDRESS?.trim() as Address;
    const rpc = process.env.NEXT_PUBLIC_MONAD_RPC_URL?.trim() ?? 'http://127.0.0.1:8545';
    const chain = chainById(Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? '31337'));
    expect(secret, 'HOST_SECRET').not.toBe('');
    expect(agentKey, 'AGENT_PRIVATE_KEY').toBeTruthy();

    // 1. Host creates a real session.
    await host.goto('/host');
    await host.getByLabel(/host secret/i).fill(secret);
    await host.getByRole('button', { name: /create session/i }).click();
    const stageLink = host.getByRole('link', { name: /open stage/i });
    await expect(stageLink).toHaveAttribute('href', /\/stage\/\d+$/, { timeout: 15_000 });
    const sessionId = (await stageLink.getAttribute('href'))?.split('/').at(-1) ?? '';
    expect(Number(sessionId)).toBeGreaterThan(0);
    await shot(host, '01-host-session-created');

    // 2. Stage shows the session live on the chain.
    stageCtx = await record(browser, { ...devices['Desktop Chrome'], viewport: { width: 1920, height: 1080 } });
    const stage = await stageCtx.newPage();
    await stage.goto(`/stage/${sessionId}`);
    await stage.getByRole('button', { name: /start the room/i }).click();
    await expect(stage.getByText(`Live on ${chain.name}`)).toBeVisible({ timeout: 15_000 });
    const grid = stage.getByTestId('stage-grid');
    await expect.poll(() => grid.getAttribute('data-playhead-step'), { timeout: 5_000 }).not.toBeNull();
    await shot(stage, '02-stage-live');

    // 3. Phone joins, gets funded, taps; the hit lands on a block and step.
    phoneCtx = await record(browser, { ...devices['iPhone 14'] });
    const phone = await phoneCtx.newPage();
    // W16: the flow checks the immediate send (Tap now); aimed notes have their own spec.
    await phone.addInitScript(() => {
      window.localStorage.setItem('blockbeat:phone:mode', 'now');
      window.localStorage.setItem('blockbeat:phone:tour', 'done'); // W16: a returning player (tour.spec covers the tour)
    });
    await phone.goto(`/join/${sessionId}`);
    const pad = phone.getByRole('button', { name: /pad 3/i });
    await expect(pad).toBeEnabled({ timeout: 20_000 });
    const trackLabel = (await phone.getByTestId('track-name').innerText()).trim();
    const track = TRACK_META.find((t) => t.label === trackLabel);
    expect(track, `track label ${trackLabel}`).toBeDefined();
    await shot(phone, '03-phone-funded');
    await pad.click();
    const line = phone.getByTestId('landing-line');
    await expect(line).toContainText(/landed · block [\d,]+ · step \d+ · \d+ ms/, { timeout: 20_000 });
    const landing = await line.innerText();
    const step = Number(/step (\d+)/.exec(landing)?.[1]);
    expect(step).toBeGreaterThanOrEqual(0);
    await shot(phone, '04-phone-landed');

    // 4. The same cell lights on the stage: same step, the phone's track.
    const cell = grid.locator(`[data-cell="${step}:${track?.id}"]`);
    await expect(cell).toHaveAttribute('data-on', 'true', { timeout: 10_000 });
    await expect(stage.getByTestId('hud-hits')).toContainText('1');
    await shot(stage, '05-stage-cell-lit');

    // 4b. A second tap goes out with the lower gas tier (the first hit is confirmed) and still lands.
    await phone.getByRole('button', { name: /pad 5/i }).click();
    await expect(line).toContainText(/landed · block [\d,]+ · step \d+ · \d+ ms/, { timeout: 20_000 });
    await expect(stage.getByTestId('hud-hits')).toContainText('2', { timeout: 10_000 });

    // 5. The resident DJ agent hits from its own wallet; the stage marks it in the agent colour.
    const agent = privateKeyToAccount(agentKey as Hex);
    const wallet = createWalletClient({ account: agent, chain, transport: http(rpc) });
    const pub = createPublicClient({ chain, transport: http(rpc), pollingInterval: 200 });
    const agentTx = await wallet.writeContract({ address: contract, abi: blockbeatAbi, functionName: 'hit', args: [BigInt(sessionId), 2, 1], gas: HIT_GAS_LIMIT_FIRST });
    const agentReceipt = await pub.waitForTransactionReceipt({ hash: agentTx, timeout: 20_000 });
    expect(agentReceipt.status).toBe('success');
    await expect(grid.locator('[data-agent="true"]')).toHaveCount(1, { timeout: 10_000 });
    await expect(stage.getByTestId('hud-players')).toContainText('2');
    await shot(stage, '06-stage-agent-hit');

    // 6. W21b: tip from the tip page (its own drip-funded burner, fixed gas), as a stage-QR scanner would.
    const tipper = await phoneCtx.newPage();
    await tipper.goto(`/tip/${sessionId}`);
    await expect(tipper.getByRole('button', { name: 'Send tip' })).toBeEnabled({ timeout: 20_000 });
    await tipper.getByRole('button', { name: 'Send tip' }).click();
    await expect(tipper.getByTestId('tip-confirmed')).toContainText(/0\.01 MON landed in block [\d,]+/, { timeout: 20_000 });
    await shot(tipper, '07-phone-tipped');

    // 7. Finalize from the stage (a fresh context: the presenter types the secret here).
    // Commit the secret first (Enter): committing it on blur hides the field and reflows the buttons
    // under the pointer, so a click that also blurs the field misses Finalize (found in W13).
    await stage.getByLabel(/host secret/i).fill(secret);
    await stage.getByLabel(/host secret/i).press('Enter');
    await stage.getByRole('button', { name: /finalize and mint/i }).click();
    const overlay = stage.getByTestId('finalize-overlay');
    await expect(overlay).toBeVisible({ timeout: 20_000 });
    await expect(overlay).toContainText(/Blockbeat Track #\d+/);
    await expect(overlay).toContainText(/2 co-authors/);
    const tokenId = /Track #(\d+)/.exec((await overlay.innerText()) ?? '')?.[1] ?? '';
    await shot(stage, '08-stage-finalized');

    // 8. The track page renders the onchain SVG, attributes and both contributors.
    await overlay.getByRole('link', { name: /open the track/i }).click();
    await expect(stage).toHaveURL(new RegExp(`/track/${tokenId}$`));
    await expect(stage.getByRole('heading', { level: 1 })).toContainText(`Track #${tokenId}`);
    await expect(stage.locator('img[src^="data:image/svg+xml"]')).toBeVisible();
    await expect(stage.getByText(/contributors/i).first()).toBeVisible();
    await expect(stage.getByRole('table')).toContainText(agent.address.slice(0, 6));
    await shot(stage, '09-track-page');

    const [stageVideo, phoneVideo] = [stage.video(), phone.video()];
    await stageCtx.close();
    await phoneCtx.close();
    await stageVideo?.saveAs(path.join(OUT, 'stage.webm'));
    await phoneVideo?.saveAs(path.join(OUT, 'phone.webm'));
  });
});
