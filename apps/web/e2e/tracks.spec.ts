import { test, expect } from '@playwright/test';

/** W15: the gallery of minted tracks. The default suite runs on the simulator: nothing is minted. */
test.describe('tracks gallery', () => {
  test('shows the empty state on the simulator, with a way to host a session', async ({ page }) => {
    const res = await page.goto('/tracks');
    expect(res?.status()).toBe(200);
    await expect(page.getByRole('heading', { level: 1, name: 'Tracks' })).toBeVisible();
    await expect(page.getByTestId('gallery-empty')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'No tracks minted yet' })).toBeVisible();
    await expect(page.getByTestId('gallery-empty').getByRole('link', { name: 'Host a session' })).toHaveAttribute('href', '/host');
  });

  test('is linked from the landing page', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: 'Hear the tracks' }).click();
    await expect(page).toHaveURL(/\/tracks$/);
  });
});
