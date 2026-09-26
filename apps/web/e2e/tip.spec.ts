/**
 * W21b: the tip flow on the simulator (mock mode). One browser context, so the stage, the tip
 * page and the phone share their simulators over the mock bus (lib/mock/bus.ts):
 * waiting screen → first note → tip 0.02 MON with a name and a message → the stage shows it
 * and the raised total → the host pulls its 20 % → finalize (overlay shows Raised) → the phone
 * claims its 80 % → /track shows the split and the tip. Screenshots go to docs/evidence/w21b-tips/.
 */
import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';
import { E2E_HOST_SECRET } from './env';

const OUT = path.resolve(__dirname, '../../../docs/evidence/w21b-tips');

async function shot(page: Page, name: string): Promise<void> {
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: false });
}

test.describe('tips (W21b)', () => {
  test.skip(({ isMobile }) => isMobile, 'one run: the spec opens its own phone-sized pages');

  test('waiting → first note → tip with a note → stage raised → host claim → finalize → claim → track split', async ({ context, page: stage }) => {
    test.setTimeout(90_000);
    // A fresh session id per run: the note store on disk (apps/web/.data) outlives the dev server.
    const session = String(10_000 + Math.floor(Math.random() * 80_000));

    // 1. The stage: two codes, the join code hidden by default.
    await stage.setViewportSize({ width: 1920, height: 1080 });
    await stage.goto(`/stage/${session}?host=1`);
    await stage.getByRole('button', { name: /start the room/i }).click();
    await expect(stage.getByTestId('host-bar')).not.toHaveAttribute('inert', '');
    const secret = stage.getByLabel(/host secret/i);
    await secret.fill(E2E_HOST_SECRET);
    await secret.press('Enter');
    await expect(stage.getByTestId('qr-join')).toHaveAttribute('data-visible', 'false');
    await expect(stage.getByTestId('tip-url')).toContainText(`/tip/${session}`);
    await shot(stage, '01-stage-two-codes-join-hidden');

    // 2. The tip page before any note: the contract would refuse (NoHits), so it waits.
    const tipper = await context.newPage();
    await tipper.setViewportSize({ width: 390, height: 844 });
    await tipper.goto(`/tip/${session}`);
    await expect(tipper.getByTestId('tip-waiting')).toContainText('Waiting for the music');
    await expect(tipper.getByTestId('tip-waiting')).toContainText('Tips open with the first note');
    await shot(tipper, '02-tip-waiting');

    // 3. A player's first note opens the tips.
    const phone = await context.newPage();
    await phone.setViewportSize({ width: 390, height: 844 });
    await phone.addInitScript(() => {
      window.localStorage.setItem('blockbeat:phone:mode', 'now');
      window.localStorage.setItem('blockbeat:phone:tour', 'done');
    });
    await phone.goto(`/join/${session}`);
    const pad = phone.getByRole('button', { name: /pad 3/i });
    await expect(pad).toBeEnabled();
    await pad.click();
    await expect(phone.getByTestId('landing-line')).toContainText(/landed · block/);
    await expect(tipper.getByTestId('tip-waiting')).toHaveCount(0, { timeout: 5_000 });
    await expect(tipper.getByRole('button', { name: 'Send tip' })).toBeEnabled();
    await shot(tipper, '03-tip-form');

    // 4. Tip 0.02 MON with a name and a message.
    await tipper.getByText('0.02', { exact: true }).click();
    await expect(tipper.getByRole('radio', { name: '0.02 MON' })).toBeChecked();
    await tipper.getByLabel(/your name/i).fill('Ana');
    await tipper.getByLabel(/message/i).fill('More kick, Berlin!');
    await shot(tipper, '04-tip-form-filled');
    await tipper.getByRole('button', { name: 'Send tip' }).click();
    await expect(tipper.getByTestId('tip-confirmed')).toContainText('0.02 MON landed');
    await expect(tipper.getByTestId('note-status')).toContainText('on the big screen');
    await shot(tipper, '05-tip-confirmed');

    // 5. The stage: raised total and the tip with its name and message.
    await expect(stage.getByTestId('raised')).toHaveText('0.02 MON', { timeout: 5_000 });
    const item = stage.getByTestId('tip-item').first();
    await expect(item).toContainText('Ana', { timeout: 6_000 });
    await expect(item).toContainText('0.02 MON');
    await expect(item).toContainText('More kick, Berlin!');
    await expect(stage.getByRole('button', { name: 'Claim host tips (0.004 MON)' })).toBeEnabled();
    await shot(stage, '06-stage-with-tips');

    // 6. The host pulls its 20 %.
    await stage.getByRole('button', { name: 'Claim host tips (0.004 MON)' }).click();
    await expect(stage.getByTestId('host-bar')).toContainText('Host tips claimed: 0.004 MON');
    await expect(stage.getByRole('button', { name: 'Claim host tips (0 MON)' })).toBeDisabled();

    // 7. Finalize: the overlay shows what the song raised.
    await stage.getByRole('button', { name: 'End session and mint' }).click();
    const overlay = stage.getByTestId('finalize-overlay');
    await expect(overlay).toBeVisible();
    await expect(overlay.getByTestId('finalize-raised')).toHaveText('Raised: 0.02 MON');
    await shot(stage, '07-finalize-overlay');

    // 8. The phone hears the mint and claims its 80 %.
    const claim = phone.getByTestId('claim-share');
    await expect(claim).toContainText('You earned 0.016 MON from tips', { timeout: 5_000 });
    await shot(phone, '08-phone-claim');
    await phone.getByRole('button', { name: 'Claim' }).click();
    await expect(claim).toContainText('Claimed 0.016 MON');

    // 9. The track page: raised, host share, the player's notes, share and MON, and the tip.
    await overlay.getByRole('link', { name: 'Play the track' }).click();
    await expect(stage).toHaveURL(new RegExp(`/track/${session}$`));
    const tips = stage.getByTestId('track-tips');
    await expect(tips.getByTestId('track-raised')).toHaveText('0.02 MON');
    await expect(tips.getByTestId('track-host-share')).toHaveText('0.004 MON');
    await expect(tips.getByTestId('track-host-claimable')).toHaveText('claimed');
    await expect(tips.getByTestId('tip-pool')).toHaveText('0.016 MON');
    const row = tips.getByTestId('contributors').locator('tbody tr').first();
    await expect(row).toContainText('1');
    await expect(row).toContainText('100%');
    await expect(row).toContainText('0.016 MON');
    const tip = tips.getByTestId('track-tip').first();
    await expect(tip).toContainText('Ana');
    await expect(tip).toContainText('More kick, Berlin!');
    await tips.scrollIntoViewIfNeeded();
    await shot(stage, '09-track-split');
  });

  test('the stage rail still fits 1080 px with three tips and their messages', async ({ context, page: stage }) => {
    test.setTimeout(60_000);
    const session = String(10_000 + Math.floor(Math.random() * 80_000));
    await stage.setViewportSize({ width: 1920, height: 1080 });
    await stage.goto(`/stage/${session}?host=1`);
    await stage.getByRole('button', { name: /start the room/i }).click();
    const phone = await context.newPage();
    await phone.addInitScript(() => {
      window.localStorage.setItem('blockbeat:phone:mode', 'now');
      window.localStorage.setItem('blockbeat:phone:tour', 'done');
    });
    await phone.goto(`/join/${session}`);
    await phone.getByRole('button', { name: /pad 1/i }).click();
    await expect(phone.getByTestId('landing-line')).toContainText(/landed/);
    const tipper = await context.newPage();
    await tipper.setViewportSize({ width: 390, height: 844 });
    await tipper.goto(`/tip/${session}`);
    for (const [who, text] of [
      ['Kai', 'This bassline is the reason I came to Berlin tonight, do not stop it'],
      ['Mira', 'Hat on the offbeat please, and more of that acid lead in the next bar'],
      ['Jo', 'Best room at the Blitz. Tip for the host and every player on the grid'],
    ] as const) {
      await expect(tipper.getByRole('button', { name: 'Send tip' })).toBeEnabled();
      await tipper.getByLabel(/your name/i).fill(who);
      await tipper.getByLabel(/message/i).fill(text);
      await tipper.getByRole('button', { name: 'Send tip' }).click();
      await expect(tipper.getByTestId('note-status')).toContainText('on the big screen');
      await tipper.getByRole('button', { name: 'Send another tip' }).click();
    }
    await expect(stage.getByTestId('raised')).toHaveText('0.03 MON');
    await expect(stage.getByTestId('tip-item')).toHaveCount(3, { timeout: 6_000 });
    await expect(stage.getByTestId('tip-item').first()).toContainText('Jo');
    const dj = await stage.getByTestId('dj-panel').boundingBox();
    expect((dj?.y ?? 0) + (dj?.height ?? 0)).toBeLessThanOrEqual(1080);
    await shot(stage, '10-stage-three-tips');
  });
});
