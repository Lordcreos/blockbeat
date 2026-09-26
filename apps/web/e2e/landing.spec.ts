import { test, expect } from '@playwright/test';

test('landing renders the explainer and a demo link', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: /blockbeat/i })).toBeVisible();
  const lines = page.getByTestId('explainer').locator('p');
  await expect(lines).toHaveCount(3);
  await expect(page.getByRole('link', { name: /open the demo stage/i })).toHaveAttribute('href', '/stage/1');
  await expect(page.getByRole('link', { name: /join the demo/i })).toHaveAttribute('href', '/join/1');
  const hero = page.getByTestId('hero-grid');
  await expect(hero).toBeVisible();
  await expect(hero.locator('[data-cell]')).toHaveCount(16 * 8);
});
