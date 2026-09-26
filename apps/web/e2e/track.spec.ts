import { test, expect } from '@playwright/test';

test.describe('track', () => {
  test('a non-numeric token id is a 404', async ({ page }) => {
    const res = await page.goto('/track/abc');
    expect(res?.status()).toBe(404);
  });

  test('token 1 renders or is a clean 404, never a server error', async ({ page }) => {
    const res = await page.goto('/track/1');
    expect([200, 404]).toContain(res?.status());
    if (res?.status() === 200) {
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    }
  });

  test('W15: Play starts the loop and sweeps the playhead over the cover; Stop clears it', async ({ page }) => {
    await page.goto('/track/1');
    // On the simulator /track shows the demo loop through the same player a minted track uses.
    const play = page.getByTestId('track-play');
    await expect(play).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByTestId('cover-playhead')).toHaveCount(0);
    await play.click();
    await expect(play).toHaveAttribute('aria-pressed', 'true');
    await expect(play).toHaveText(/stop/i);
    const head = page.getByTestId('cover-playhead');
    await expect(head).toBeVisible();
    const first = await head.getAttribute('data-step');
    await expect.poll(() => head.getAttribute('data-step'), { timeout: 1500 }).not.toBe(first);
    await play.click();
    await expect(play).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByTestId('cover-playhead')).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'All tracks' })).toHaveAttribute('href', '/tracks');
  });
});
