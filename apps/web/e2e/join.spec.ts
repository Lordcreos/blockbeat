import { test, expect } from '@playwright/test';

test.describe('join', () => {
  // W16: these phone taps are the original immediate sends (Tap now), not aimed notes.
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem('blockbeat:phone:mode', 'now');
      window.localStorage.setItem('blockbeat:phone:tour', 'done'); // W16: a returning player (tour.spec covers the tour)
    });
  });

  test('renders eight labelled pads for the assigned track', async ({ page }) => {
    await page.goto('/join/1');
    await expect(page.getByTestId('pads').getByRole('button')).toHaveCount(8);
    await expect(page.getByTestId('track-name')).toBeVisible();
    await expect(page.getByRole('button', { name: /tip the room/i })).toBeVisible();
  });

  test('a tap produces a landing line', async ({ page }) => {
    await page.goto('/join/1');
    const pad = page.getByRole('button', { name: /pad 3/i });
    await expect(pad).toBeEnabled();
    await pad.click();
    const line = page.getByTestId('landing-line');
    await expect(line).toContainText(/landed · block [\d,]+ · step \d+ · \d+ ms/);
  });

  test('the step strip marks where the last note landed', async ({ page }) => {
    await page.goto('/join/1');
    const strip = page.getByTestId('step-strip');
    await expect(strip.locator('[data-step]')).toHaveCount(16);
    await expect(strip.locator('[data-landed="true"]')).toHaveCount(0);
    await page.getByRole('button', { name: /pad 2/i }).click();
    const line = page.getByTestId('landing-line');
    await expect(line).toContainText(/landed · block [\d,]+ · step \d+ · \d+ ms/);
    const step = Number(/step (\d+)/.exec((await line.textContent()) ?? '')?.[1]);
    await expect(strip.locator('[data-landed="true"]')).toHaveCount(1);
    await expect(strip.locator('[data-landed="true"]')).toHaveAttribute('data-step', String(step));
  });

  test('a second tap on the same pad replays the flash and keeps the pad (and its focus)', async ({ page }) => {
    await page.goto('/join/1');
    const pad = page.getByRole('button', { name: /pad 1/i });
    await pad.click();
    const flash = pad.locator('[data-flash="true"]');
    await expect(flash).toHaveClass(/pad-flash/);
    const padBefore = await pad.elementHandle();
    const flashBefore = await flash.elementHandle();
    await pad.focus();
    await pad.press('Enter');
    await expect(page.getByTestId('landing-line')).toContainText(/landed/);
    const same = await page.evaluate(([a, b]) => a === b, [padBefore, await pad.elementHandle()] as const);
    expect(same).toBe(true);
    const flashSame = await page.evaluate(([a, b]) => a === b, [flashBefore, await flash.elementHandle()] as const);
    expect(flashSame).toBe(false);
    await expect(pad).toBeFocused();
  });

  test('invalid session shows the not-found page', async ({ page }) => {
    const res = await page.goto('/join/abc');
    expect(res?.status()).toBe(404);
  });
});

test.describe('join W12: balance', () => {
  // W16: these phone taps are the original immediate sends (Tap now), not aimed notes.
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem('blockbeat:phone:mode', 'now');
      window.localStorage.setItem('blockbeat:phone:tour', 'done'); // W16: a returning player (tour.spec covers the tour)
    });
  });

  test('the header pill shows the balance and notes left once funded', async ({ page }) => {
    await page.goto('/join/1');
    await expect(page.getByTestId('funds-pill')).toHaveText(/^0\.3 MON · ~\d+ notes$/);
  });

  test('a landed note lowers the estimate', async ({ page }) => {
    await page.goto('/join/1');
    const pill = page.getByTestId('funds-pill');
    await expect(pill).toHaveText(/~27 notes/);
    await page.getByRole('button', { name: /^Pad 1, / }).click();
    await expect(page.getByTestId('landing-line')).toContainText(/landed/);
    await expect(pill).toHaveText(/~26 notes/);
  });
});
