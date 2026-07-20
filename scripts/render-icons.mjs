// Render public/icons/icon.svg to the PNG sizes the manifest needs.
// Uses Playwright's bundled Chromium; run once when the icon changes.
import { chromium } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const svgPath = path.join(root, 'public/icons/icon.svg');

const browser = await chromium.launch(
  process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
);
const page = await browser.newPage();
for (const size of [192, 512]) {
  await page.setViewportSize({ width: size, height: size });
  await page.goto(`file://${svgPath}`);
  await page.screenshot({ path: path.join(root, `public/icons/icon-${size}.png`), omitBackground: true });
  console.log(`icon-${size}.png written`);
}
await browser.close();
