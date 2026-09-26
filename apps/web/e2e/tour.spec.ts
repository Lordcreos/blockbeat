/**
 * W16 follow-up: the first-visit tour on the simulator. A new phone gets the tour by itself once
 * it can play, walks the six steps (each highlighting its part of the screen), and does not see it
 * again after it; the ? button replays it. Screenshots at 390×844 in docs/evidence/w16-playable-phone/.
 */
import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';

const OUT = path.resolve(__dirname, '../../../docs/evidence/w16-playable-phone');
const TITLES = ['Pick your instrument', 'Eight different sounds', 'Aim or Tap now', 'The loop, driven by Monad', 'The chain confirms', 'Keep playing'];

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: false });
}

test.describe('first-visit tour (W16)', () => {
  test.skip(({ isMobile }) => !isMobile, 'phone only');

  test('a new phone gets the tour, walks all six steps, and is not asked again', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/join/1');
    for (const [i, title] of TITLES.entries()) {
      const dialog = page.getByRole('dialog', { name: title });
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText(`${i + 1} of 6`);
      if (i < TITLES.length - 1) await expect(page.getByTestId('tour-spotlight')).toBeVisible();
      await page.waitForTimeout(300); // let the highlight settle for the screenshot
      await shot(page, `1${i}-tour-${i + 1}`);
      await page.getByRole('button', { name: i === TITLES.length - 1 ? 'Start playing' : 'Next' }).click();
    }
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole('button', { name: /^Pad 1, / })).toBeEnabled();
    await page.waitForTimeout(500);
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

  test('Skip closes it at once; How to play brings it back from step 1; Escape closes it', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/join/1');
    await page.getByRole('button', { name: 'Skip tour' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.getByRole('button', { name: 'How to play' }).click();
    await expect(page.getByRole('dialog', { name: 'Pick your instrument' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Next' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'How to play' })).toBeFocused();
  });
});
