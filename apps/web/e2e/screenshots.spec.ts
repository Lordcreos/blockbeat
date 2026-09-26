import { test } from '@playwright/test';
import path from 'node:path';
import { E2E_HOST_SECRET } from './env';

const OUT = path.resolve(__dirname, '../../../docs/evidence/w8-polish');
const PAGES: Array<[string, string]> = [
  ['landing', '/'],
  ['host', '/host'],
  ['stage', '/stage/1'],
  ['join', '/join/1'],
  ['track', '/track/1'],
];

for (const [name, route] of PAGES) {
  test(`screenshot ${name}`, async ({ page }, info) => {
    if (info.project.name === 'phone') await page.setViewportSize({ width: 390, height: 844 });
    const vp = page.viewportSize();
    // W16: the join shot shows a returning player, not the first-visit tour.
    if (name === 'join') await page.addInitScript(() => window.localStorage.setItem('blockbeat:phone:tour', 'done'));
    await page.goto(route);
    if (name === 'host') {
      await page.getByLabel(/host secret/i).fill(process.env.HOST_SECRET ?? E2E_HOST_SECRET);
      await page.getByRole('button', { name: /create session/i }).click();
    }
    if (name === 'stage') await page.getByRole('button', { name: /start the room/i }).click();
    if (name === 'join') {
      await page.getByRole('button', { name: /pad 3/i }).click();
      await page.getByTestId('landing-line').waitFor();
    }
    await page.waitForTimeout(400);
    const file = path.join(OUT, `${name}-${vp?.width}x${vp?.height}.png`);
    await page.screenshot({ path: file, fullPage: false });
    info.attachments.push({ name: `${name}-${info.project.name}`, path: file, contentType: 'image/png' });
  });
}
