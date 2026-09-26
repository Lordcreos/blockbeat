/**
 * W16: the playable phone on the simulator (mock mode). Switch instrument, aim a step and see
 * "aimed step N · landed step M", queue 4 notes and watch the queue drain. Screenshots at
 * 390×844 go to docs/evidence/w16-playable-phone/.
 */
import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';

const OUT = path.resolve(__dirname, '../../../docs/evidence/w16-playable-phone');

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: false });
}

async function open(page: Page): Promise<void> {
  await page.setViewportSize({ width: 390, height: 844 });
  // A returning player: the first-visit tour has its own spec (tour.spec.ts).
  await page.addInitScript(() => window.localStorage.setItem('blockbeat:phone:tour', 'done'));
  await page.goto('/join/1');
  await expect(page.getByRole('button', { name: /^Pad 1, / })).toBeEnabled();
  // The block clock locks on the first simulator head (300 ms).
  await expect(page.getByTestId('step-strip').locator('[data-playhead="true"]')).toHaveCount(1);
}

test.describe('playable phone (W16)', () => {
  test.skip(({ isMobile }) => !isMobile, 'phone only');

  test('switch instrument: tabs, header colour and pad names follow the choice', async ({ page }) => {
    await open(page);
    const tabs = page.getByRole('tablist', { name: 'Instrument' });
    await expect(tabs.getByRole('tab')).toHaveCount(8);
    await shot(page, '01-phone-aim-start');
    await tabs.getByRole('tab', { name: 'Bass' }).click();
    await expect(page.getByTestId('track-name')).toHaveText('Bass');
    await expect(tabs.getByRole('tab', { name: 'Bass' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('button', { name: 'Pad 1, A1' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Pad 8, A2 open' })).toBeVisible();
    await shot(page, '02-phone-bass-pads');
    await tabs.getByRole('tab', { name: 'Pad' }).click();
    await expect(page.getByRole('button', { name: 'Pad 2, Cmaj7' })).toBeVisible();
    await tabs.getByRole('tab', { name: 'Hat' }).click();
    await expect(page.getByRole('button', { name: 'Pad 7, Open' })).toBeVisible();
    await shot(page, '03-phone-hat-pads');
  });

  test('aim a step: pick a pad, tap step 7, see where it landed', async ({ page }) => {
    await open(page);
    await page.getByRole('button', { name: /^Pad 3, / }).click();
    await expect(page.getByRole('button', { name: /^Pad 3, / })).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: /^Step 7\b/ }).click();
    await expect(page.getByTestId('aim-queue')).toContainText(/step 7/);
    await shot(page, '04-phone-aimed-waiting');
    const line = page.getByTestId('landing-line');
    await expect(line).toContainText(/aimed step 7 · landed step \d+/, { timeout: 10_000 });
    await shot(page, '05-phone-aimed-landed');
    // The phone keeps aiming with the pad it picked; the line always says where the note really landed
    // (exactness needs a few landings to learn the lead: measured by test/aim-accuracy.ts on anvil).
    await page.getByRole('button', { name: /^Step 11\b/ }).click();
    await expect(line).toContainText(/aimed step 11 · landed step (10|11|12)\b/, { timeout: 10_000 });
  });

  test('queue 4 notes: arm steps 0, 4, 8, 12, then a kick pad; the queue drains as they land', async ({ page }) => {
    await open(page);
    await page.getByRole('tablist', { name: 'Instrument' }).getByRole('tab', { name: 'Kick' }).click();
    for (const s of [0, 4, 8, 12]) await page.getByRole('button', { name: new RegExp(`^Step ${s}\\b`) }).click();
    await expect(page.getByTestId('step-strip').locator('[data-armed="true"]')).toHaveCount(4);
    await shot(page, '06-phone-four-armed');
    await page.getByRole('button', { name: 'Pad 1, Deep' }).click();
    const queue = page.getByTestId('aim-queue');
    await expect(queue.getByRole('listitem')).toHaveCount(4);
    await shot(page, '07-phone-queue-of-four');
    await expect(queue).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByTestId('landing-line')).toContainText(/aimed step \d+ · landed step \d+/);
    await expect(page.getByTestId('step-strip').locator('[data-live="true"]')).toHaveCount(4);
    await shot(page, '08-phone-queue-drained');
  });

  test('Tap now still sends at once, where the block decides', async ({ page }) => {
    await open(page);
    await page.getByRole('button', { name: 'Tap now' }).click();
    await page.getByRole('button', { name: /^Pad 5, / }).click();
    await expect(page.getByTestId('landing-line')).toContainText(/landed · block [\d,]+ · step \d+ · \d+ ms/);
    await shot(page, '09-phone-tap-now');
  });
});
