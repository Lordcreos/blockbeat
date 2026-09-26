import { test, expect } from '@playwright/test';
import { E2E_HOST_SECRET } from './env';

test('host creates a session and gets stage and join links', async ({ page }) => {
  await page.goto('/host');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  // W15: the field is always shown; the e2e server runs with a pinned HOST_SECRET (playwright.config.ts).
  await page.getByLabel(/host secret/i).fill(process.env.HOST_SECRET ?? E2E_HOST_SECRET);
  await page.getByRole('button', { name: 'Create session' }).click();
  const stage = page.getByRole('link', { name: /open stage/i });
  const join = page.getByRole('link', { name: /open join page/i });
  // The stage opens with the host bar on.
  await expect(stage).toHaveAttribute('href', /\/stage\/\d+\?host=1$/);
  await expect(join).toHaveAttribute('href', /\/join\/\d+$/);
  await expect(page.getByTestId('qr-stage').locator('canvas')).toBeVisible();
  await expect(page.getByTestId('qr-join').locator('canvas')).toBeVisible();
});

test('host lists the session it just created, with its state and the gallery link', async ({ page }) => {
  await page.goto('/host');
  await page.getByLabel(/host secret/i).fill(process.env.HOST_SECRET ?? E2E_HOST_SECRET);
  await page.getByRole('button', { name: 'Create session' }).click();
  const row = page.getByTestId('recent-session').first();
  await expect(row).toContainText(/Session \d+/);
  await expect(row).toContainText('Live');
  await expect(page.getByRole('link', { name: /open the gallery/i })).toHaveAttribute('href', '/tracks');
});

test('Open stage from /host lands on the stage with the host bar, after a client-side navigation', async ({ page }) => {
  await page.goto('/host');
  await page.getByLabel(/host secret/i).fill(process.env.HOST_SECRET ?? E2E_HOST_SECRET);
  await page.getByRole('button', { name: 'Create session' }).click();
  await page.getByRole('link', { name: /open stage/i }).click();
  await expect(page).toHaveURL(/\/stage\/\d+\?host=1$/);
  await expect(page.getByTestId('host-bar')).toBeVisible();
  await expect(page.getByRole('button', { name: 'End session and mint' })).toBeVisible();
});
