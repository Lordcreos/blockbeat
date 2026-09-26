/**
 * W19 visible mode: the real `Phone` driver, one headed Chromium window per phone (Playwright),
 * placed on the screen grid with an iPhone 14 viewport and touch. It clicks what a person
 * clicks on the join page: "Skip tour", the instrument tab, a pad, a step.
 */
import { chromium, devices, type Browser, type Page } from 'playwright';
import type { Hex } from 'viem';
import type { Phone, Rect } from './visible';

/** apps/web/lib/burner.ts BURNER_STORAGE_KEY: where the join page keeps its burner key. */
export const BURNER_STORAGE_KEY = 'blockbeat:burner:pk:v1';
const KEY_RE = /^0x[0-9a-fA-F]{64}$/;
/** Window chrome (title bar, address bar) above the page. */
const CHROME_HEIGHT = 88;

export async function openPlaywrightPhone(url: string, rect: Rect, log: (line: string) => void): Promise<Phone> {
  const browser: Browser = await chromium.launch({ headless: false, args: [`--window-position=${rect.x},${rect.y}`, `--window-size=${rect.width},${rect.height}`] });
  const iphone = devices['iPhone 14'];
  const viewport = { width: Math.min(390, rect.width - 16), height: Math.max(480, rect.height - CHROME_HEIGHT) };
  const context = await browser.newContext({ ...iphone, viewport, screen: viewport, deviceScaleFactor: 1 });
  const page: Page = await context.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  return {
    async waitReady(timeoutMs) {
      // Funded = the pads are live. "Wallet ready" is only a passing pill (it turns into
      // "0.30 MON · ~28 notes" once the balance is read) and was missed on testnet.
      const ready = page.locator('#phone-pads button:not([disabled])').first();
      const full = page.getByTestId('room-full');
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (await full.isVisible()) return 'room-full';
        if (await ready.isVisible()) return 'ready';
        await page.waitForTimeout(500);
      }
      throw new Error(`the phone at ${url} was not funded within ${timeoutMs} ms`);
    },
    async skipTour(timeoutMs) {
      const skip = page.getByRole('button', { name: 'Skip tour' });
      const shown = await skip.waitFor({ state: 'visible', timeout: timeoutMs }).then(
        () => true,
        () => false,
      );
      if (!shown) {
        log(`phone ${url}: no tour showed within ${timeoutMs} ms`);
        return false;
      }
      await skip.click();
      return true;
    },
    async pickInstrument(label) {
      await page.getByRole('tab', { name: label, exact: true }).click();
    },
    async setMode(mode) {
      await page.getByRole('group', { name: 'How your notes land' }).getByRole('button', { name: mode === 'tap' ? 'Tap now' : 'Aim', exact: true }).click();
    },
    async tap(padIndex) {
      await page.locator('#phone-pads button').nth(padIndex).click();
    },
    async aim(padIndex, step) {
      await page.locator('#phone-pads button').nth(padIndex).click();
      await page.locator(`button[data-step="${step}"]`).click();
    },
    async burnerKey(): Promise<Hex | null> {
      // The page makes its key on load; wait for it (a string expression: no DOM lib in this package).
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        const raw: unknown = await page.evaluate(`window.localStorage.getItem(${JSON.stringify(BURNER_STORAGE_KEY)})`);
        if (typeof raw === 'string' && KEY_RE.test(raw)) return raw as Hex;
        await page.waitForTimeout(200);
      }
      return null;
    },
    async close() {
      await browser.close();
    },
    async screenshot(path) {
      await page.screenshot({ path });
    },
  };
}
