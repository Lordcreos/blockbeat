/**
 * W13 note decay on a real chain (local anvil at 300 ms): a phone tap lights a cell, the cell
 * fades over its last 2 bars and is dark 128 blocks after the hit while `pattern()` (the
 * recorded layer, the NFT) still has the bit, then the resident DJ started from the stage
 * refills a groove floor.
 *
 * Gated like anvil-flow.spec.ts: BLOCKBEAT_E2E_ANVIL=1 and a dev server on a real chain. The
 * DJ is spawned by the stage's Start DJ (`pnpm --filter agent start`), so apps/agent/.env must
 * point at the same anvil (AGENT_CHAIN_ID=31337, AGENT_RPC_URL, BLOCKBEAT_ADDRESS, a funded
 * AGENT_PRIVATE_KEY). Screenshots and the stage recording go to docs/evidence/w13-evolving-music/.
 */
import { test, expect, devices, type Page } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPublicClient, http, type Address } from 'viem';
import { TRACK_META, blockbeatAbi, chainById, isOn, type TrackId } from '@blockbeat/shared';
import { isChainMode } from './env';

const OUT = path.resolve(__dirname, '../../../docs/evidence/w13-evolving-music');
const ENABLED = process.env.BLOCKBEAT_E2E_ANVIL?.trim() === '1' && isChainMode();
const LIFETIME_BLOCKS = 128n;

test.describe('anvil note decay (W13)', () => {
  test.skip(!ENABLED, 'set BLOCKBEAT_E2E_ANVIL=1 with the dev server on a real chain');
  test.setTimeout(180_000);

  test('a hit lights a cell, is dark on the stage 128 blocks later while pattern() keeps the bit, and the DJ refills a floor', async ({ browser, page: host }, info) => {
    test.skip(info.project.name !== 'stage', 'runs once, from the stage project');
    const secret = process.env.HOST_SECRET ?? '';
    const contract = process.env.NEXT_PUBLIC_BLOCKBEAT_ADDRESS?.trim() as Address;
    const rpc = process.env.NEXT_PUBLIC_MONAD_RPC_URL?.trim() ?? 'http://127.0.0.1:8545';
    const chain = chainById(Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? '31337'));
    const pub = createPublicClient({ chain, transport: http(rpc), pollingInterval: 200 });
    expect(secret, 'HOST_SECRET').not.toBe('');
    const shot = (page: Page, name: string) => page.screenshot({ path: path.join(OUT, `${name}.png`) });
    const timeline: Array<{ at: string; block: string; note: string }> = [];
    const mark = async (note: string) => timeline.push({ at: new Date().toISOString(), block: (await pub.getBlockNumber({ cacheTime: 0 })).toString(), note });

    // 1. A fresh session.
    await host.goto('/host');
    await host.getByLabel(/host secret/i).fill(secret);
    await host.getByRole('button', { name: /create session/i }).click();
    const stageLink = host.getByRole('link', { name: /open stage/i });
    await expect(stageLink).toHaveAttribute('href', /\/stage\/\d+$/, { timeout: 15_000 });
    const sessionId = BigInt((await stageLink.getAttribute('href'))?.split('/').at(-1) ?? '0');

    // 2. The stage, recorded; the host secret typed so Start DJ works later.
    const stageCtx = await browser.newContext({
      ...devices['Desktop Chrome'],
      viewport: { width: 1920, height: 1080 },
      recordVideo: { dir: path.join(os.tmpdir(), 'blockbeat-w13-video'), size: { width: 1920, height: 1080 } },
    });
    const phoneCtx = await browser.newContext({ ...devices['iPhone 14'] });
    try {
      const stage = await stageCtx.newPage();
      await stage.goto(`/stage/${sessionId}`);
      await stage.getByRole('button', { name: /start the room/i }).click();
      await expect(stage.getByText(`Live on ${chain.name}`)).toBeVisible({ timeout: 15_000 });
      const secretField = stage.getByLabel(/host secret/i);
      await secretField.fill(secret);
      await secretField.press('Enter');
      const grid = stage.getByTestId('stage-grid');

      // 3. The phone taps once.
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
      const meta = TRACK_META.find((t) => t.label === trackLabel);
      expect(meta, `track label ${trackLabel}`).toBeDefined();
      const trackId = (meta?.id ?? 0) as TrackId;
      await pad.click();
      const line = phone.getByTestId('landing-line');
      await expect(line).toContainText(/^landed · block [\d,]+ · step \d+ · \d+ ms$/, { timeout: 20_000 });
      const landing = await line.innerText();
      const step = Number(/step (\d+)/.exec(landing)?.[1]);
      const landedBlock = BigInt((/block ([\d,]+)/.exec(landing)?.[1] ?? '0').replaceAll(',', ''));
      await mark(`phone hit landed at block ${landedBlock}, step ${step}, track ${trackLabel}`);

      // 4. The cell lights; the HUD counts one live note; the phone strip shows it still playing.
      const cell = grid.locator(`[data-cell="${step}:${trackId}"]`);
      await expect(cell).toHaveAttribute('data-on', 'true', { timeout: 10_000 });
      await expect(stage.getByTestId('hud-live-notes')).toHaveText('1');
      await expect(phone.locator(`[data-testid="step-strip"] [data-step="${step}"]`)).toHaveAttribute('data-live', 'true', { timeout: 5_000 });
      await shot(stage, '01-stage-hit-lit');
      await shot(phone, '01-phone-landed-live');

      // 5. Its last 2 bars: the cell fades (data-fade < 1); shot at half light or less.
      await expect(cell).toHaveAttribute('data-fade', /^0\.\d\d$/, { timeout: 45_000 });
      await mark(`stage cell starts fading (last 2 bars), data-fade ${await cell.getAttribute('data-fade')}`);
      await expect.poll(async () => Number((await cell.getAttribute('data-fade')) ?? '1'), { timeout: 15_000, intervals: [100] }).toBeLessThanOrEqual(0.5);
      await mark(`stage cell at data-fade ${await cell.getAttribute('data-fade')}`);
      await shot(stage, '02-stage-hit-fading');
      await shot(phone, '02-phone-strip-fading');

      // 6. Dark 128 blocks after the hit, while the recorded pattern still holds the bit.
      await expect(cell).not.toHaveAttribute('data-on', 'true', { timeout: 20_000 });
      const darkAt = await pub.getBlockNumber({ cacheTime: 0 });
      expect(darkAt - landedBlock).toBeGreaterThanOrEqual(LIFETIME_BLOCKS - 1n); // the stage head may trail the node by a block
      const words = await pub.readContract({ address: contract, abi: blockbeatAbi, functionName: 'pattern', args: [sessionId] });
      const recordedOn = decodeFirstNote(words[step] ?? 0n, trackId);
      expect(recordedOn, 'pattern() still has the bit').not.toBeNull();
      await expect(stage.getByTestId('hud-live-notes')).toHaveText('0');
      await expect(stage.getByTestId('hud-hits')).toHaveText('1');
      await mark(`stage cell dark at node block ${darkAt} (${darkAt - landedBlock} blocks after the hit); pattern() step ${step} word 0x${(words[step] ?? 0n).toString(16)}`);
      await shot(stage, '03-stage-hit-dark-recorded-kept');
      await expect(phone.locator(`[data-testid="step-strip"] [data-step="${step}"]`)).not.toHaveAttribute('data-live', 'true', { timeout: 5_000 });
      await expect(phone.locator('[data-testid="step-strip"] [data-landed="true"]')).toHaveCount(0);
      await shot(phone, '03-phone-strip-dark');

      // 7. The resident DJ, from the stage, refills a groove floor on the empty live grid.
      await stage.getByRole('button', { name: /start dj/i }).click();
      await expect(stage.getByTestId('dj-state')).toContainText(/on/i, { timeout: 15_000 });
      await expect(grid.locator('[data-agent="true"]').first()).toBeVisible({ timeout: 40_000 });
      await mark('first DJ note live on the stage');
      await shot(stage, '04-stage-dj-first-note');
      await expect.poll(async () => grid.locator('[data-agent="true"]').count(), { timeout: 40_000 }).toBeGreaterThanOrEqual(6);
      const live = Number(await stage.getByTestId('hud-live-notes').innerText());
      expect(live).toBeGreaterThanOrEqual(6);
      expect(live).toBeLessThan(12 + 3);
      await mark(`DJ floor: ${live} live notes`);
      await shot(stage, '05-stage-dj-floor');
      const djLines = await stage.getByTestId('dj-lines').innerText().catch(() => '');

      await stage.getByRole('button', { name: /stop dj/i }).click();
      await expect(stage.getByTestId('dj-state')).toContainText(/off|stopped/i, { timeout: 15_000 });
      writeFileSync(path.join(OUT, 'anvil-decay-run.json'), JSON.stringify({ sessionId: sessionId.toString(), step, track: trackLabel, landedBlock: landedBlock.toString(), recordedNote: recordedOn, timeline, djLines }, null, 2));

      const video = stage.video();
      await stageCtx.close();
      await video?.saveAs(path.join(OUT, 'stage-decay.webm'));
    } finally {
      await Promise.all([stageCtx.close().catch(() => undefined), phoneCtx.close()]);
    }
  });
});

/** The lowest note of `track` whose bit is on in a step word, or null. */
function decodeFirstNote(word: bigint, track: TrackId): number | null {
  for (let n = 0; n < 32; n++) if (isOn(word, track, n)) return n;
  return null;
}
