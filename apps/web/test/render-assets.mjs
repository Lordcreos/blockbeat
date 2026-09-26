/**
 * Renders the SVG assets in public/ to PNG with headless Chromium (no ImageMagick/ffmpeg
 * on the stage laptop): og.png for link previews and a preview of the stage background
 * for the evidence folder.
 *
 *   node test/render-assets.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const web = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const targets = [
  ['og.svg', 1200, 630, resolve(web, 'public/og.png')],
  ['logo.svg', 512, 512, resolve(web, 'public/logo-512.png')],
  ['stage-bg.svg', 1920, 1080, resolve(web, '../../docs/evidence/w5-integration/stage-bg-preview.png')],
];

const browser = await chromium.launch();
for (const [file, width, height, out] of targets) {
  const page = await browser.newPage({ viewport: { width, height } });
  const svg = readFileSync(resolve(web, 'public', file), 'utf8');
  await page.setContent(`<html><body style="margin:0;background:#050507">${svg}</body></html>`);
  await page.locator('svg').first().evaluate((el, size) => {
    el.setAttribute('width', String(size.width));
    el.setAttribute('height', String(size.height));
  }, { width, height });
  await page.waitForTimeout(300);
  await page.screenshot({ path: out });
  console.log(`rendered ${file} → ${out}`);
  await page.close();
}
await browser.close();
