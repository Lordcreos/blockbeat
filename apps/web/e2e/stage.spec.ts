import { test, expect } from '@playwright/test';
import { E2E_HOST_SECRET } from './env';

test.describe('stage', () => {
  test('renders the grid, HUD and QR', async ({ page }) => {
    await page.goto('/stage/1');
    await expect(page.getByRole('heading', { level: 1, name: /session 1/i })).toBeVisible();
    const grid = page.getByTestId('stage-grid');
    await expect(grid).toBeVisible();
    await expect(grid.locator('[data-cell]')).toHaveCount(16 * 8);
    await expect(grid.getByRole('table')).toHaveAttribute('aria-rowcount', '8');
    for (const label of ['Block', 'Hits', 'Hits / min', 'Latency', 'Players', 'BPM']) {
      await expect(page.getByTestId('hud').getByText(label, { exact: true })).toBeVisible();
    }
    await expect(page.getByTestId('qr-join').locator('canvas')).toBeVisible();
    await expect(page.getByTestId('short-url')).toContainText(/\/join\/1$/);
    await expect(page.getByTestId('legend')).toContainText(/agent/i);
    await expect(page.getByTestId('scan-cta')).toContainText(/scan to play/i);
  });

  test('shows a waiting hint until the first note lands', async ({ page }) => {
    await page.goto('/stage/1');
    await expect(page.getByTestId('grid-empty')).toContainText(/waiting for the first note/i);
  });

  test('the playhead column sweeps with a two-step trail', async ({ page }) => {
    await page.goto('/stage/1');
    const cols = page.locator('[data-playhead-col]');
    await expect(cols).toHaveCount(16);
    await expect(page.locator('[data-playhead-col][data-active="true"]')).toHaveCount(1);
    await expect(page.locator('[data-playhead-col][data-trail="1"]')).toHaveCount(1);
    await expect(page.locator('[data-playhead-col][data-trail="2"]')).toHaveCount(1);
  });

  test('playhead column changes within 1 s in mock mode', async ({ page }) => {
    await page.goto('/stage/1');
    const grid = page.getByTestId('stage-grid');
    await expect(grid).toBeVisible();
    const first = await grid.getAttribute('data-playhead-step');
    expect(first).not.toBeNull();
    await expect
      .poll(() => grid.getAttribute('data-playhead-step'), { timeout: 1000 })
      .not.toBe(first);
    const step = Number(await grid.getAttribute('data-playhead-step'));
    expect(step).toBeGreaterThanOrEqual(0);
    expect(step).toBeLessThan(16);
    await expect(grid.locator('[data-playhead="true"]')).toHaveCount(8);
  });

  test('start-audio overlay disappears after a click', async ({ page }) => {
    await page.goto('/stage/1?host=1');
    const button = page.getByRole('button', { name: /start the room/i });
    await expect(button).toBeVisible();
    await button.click();
    await expect(button).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'New session' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'New session' })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'End session and mint' })).toBeVisible();
  });

  test('the host secret can be typed one key at a time and is committed with Enter', async ({ page }) => {
    await page.goto('/stage/1?host=1');
    await page.getByRole('button', { name: /start the room/i }).click();
    // The host bar is inert until the audio engine confirms it started; keystrokes sent
    // before that are dropped, so wait for the lock to lift before typing.
    await expect(page.getByRole('button', { name: /start the room/i })).toHaveCount(0);
    await expect(page.getByTestId('host-bar')).not.toHaveAttribute('inert', '');
    const secret = page.getByLabel(/host secret/i);
    await expect(secret).toBeVisible();
    await secret.click();
    await secret.pressSequentially(E2E_HOST_SECRET);
    await expect(secret).toHaveValue(E2E_HOST_SECRET);
    await secret.press('Enter');
    await expect(page.getByLabel(/host secret/i)).toHaveCount(0);
  });

  test('new session asks for confirmation before stranding the phones', async ({ page }) => {
    await page.goto('/stage/1?host=1');
    await page.getByRole('button', { name: /start the room/i }).click();
    await page.getByRole('button', { name: 'New session' }).click();
    await expect(page.getByText(/phones must re-scan/i)).toBeVisible();
    await expect(page).toHaveURL(/\/stage\/1\?host=1$/);
    await page.getByRole('button', { name: /keep this session/i }).click();
    await expect(page.getByText(/phones must re-scan/i)).toHaveCount(0);
    await expect(page).toHaveURL(/\/stage\/1\?host=1$/);
  });

  test('HUD values keep a fixed width while the block advances', async ({ page }) => {
    await page.goto('/stage/1');
    const block = page.getByTestId('hud-block');
    const w1 = (await block.boundingBox())?.width;
    await page.waitForTimeout(700);
    const w2 = (await block.boundingBox())?.width;
    expect(w1).toBe(w2);
  });
});

test.describe('stage W12: tips and the resident DJ', () => {
  test('shows the Tips stat and a DJ panel that starts off', async ({ page }) => {
    await page.goto('/stage/1');
    await expect(page.getByTestId('hud').getByText('Tips', { exact: true })).toBeVisible();
    await expect(page.getByTestId('hud-tips')).toHaveText(/MON · \d+/);
    await expect(page.getByTestId('dj-state')).toHaveText('Off');
    // W15: the DJ button lives in the host bar, shown with ?host=1 or a stored secret.
    await expect(page.getByRole('button', { name: 'Start DJ' })).toHaveCount(0);
    await page.goto('/stage/1?host=1');
    await expect(page.getByRole('button', { name: 'Start DJ' })).toBeVisible();
  });

  test('Start DJ without the host secret explains itself instead of doing nothing', async ({ page }) => {
    await page.goto('/stage/1?host=1');
    await page.getByRole('button', { name: /start the room/i }).click().catch(() => undefined);
    await page.getByRole('button', { name: 'Start DJ' }).click();
    await expect(page.getByTestId('dj-panel').getByRole('alert')).toContainText(/DJ:/);
  });
});

test.describe('stage W15: the host bar', () => {
  test('the audience view has no host controls; ?host=1 shows the bar with the session and labelled actions', async ({ page }) => {
    await page.goto('/stage/1');
    await expect(page.getByRole('heading', { level: 1, name: /session 1/i })).toBeVisible();
    await expect(page.getByTestId('host-bar')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'End session and mint' })).toHaveCount(0);

    await page.goto('/stage/1?host=1');
    const bar = page.getByTestId('host-bar');
    await expect(bar).toBeVisible();
    await expect(bar).toContainText('Session 1');
    await expect(page.getByTestId('host-session-state')).toHaveText('Live');
    await expect(bar.getByRole('button', { name: 'New session' })).toBeVisible();
    await expect(bar.getByRole('button', { name: 'End session and mint' })).toBeVisible();
    // The bar sits at the top, across the whole stage, and the grid still fits the viewport.
    const vp = page.viewportSize();
    const box = await bar.boundingBox();
    expect(box?.y).toBe(0);
    expect(box?.width).toBe(vp?.width);
    if ((vp?.width ?? 0) > 1100) {
      // Big screen: the grid still fits under the bar without scrolling.
      const grid = await page.getByTestId('stage-grid').boundingBox();
      expect((grid?.y ?? 0) + (grid?.height ?? 0)).toBeLessThanOrEqual(vp?.height ?? 0);
    }
  });

  test('after End session and mint the bar offers Play the track and Open the gallery', async ({ page }) => {
    await page.goto('/stage/1?host=1');
    await page.getByRole('button', { name: /start the room/i }).click();
    await expect(page.getByTestId('host-bar')).not.toHaveAttribute('inert', '');
    const secret = page.getByLabel(/host secret/i);
    await secret.fill(E2E_HOST_SECRET);
    await secret.press('Enter');
    await page.getByRole('button', { name: 'End session and mint' }).click();
    const overlay = page.getByTestId('finalize-overlay');
    await expect(overlay).toBeVisible();
    await expect(overlay.getByRole('link', { name: 'Open the gallery' })).toHaveAttribute('href', '/tracks');
    await overlay.getByRole('button', { name: /back to the stage/i }).click();
    const bar = page.getByTestId('host-bar');
    await expect(page.getByTestId('host-session-state')).toHaveText(/Minted as Track #\d+/);
    await expect(bar.getByRole('link', { name: 'Play the track' })).toHaveAttribute('href', /\/track\/\d+$/);
    await expect(bar.getByRole('link', { name: 'Open the gallery' })).toHaveAttribute('href', '/tracks');
  });
});
