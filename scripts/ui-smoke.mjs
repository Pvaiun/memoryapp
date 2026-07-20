// UI smoke test: drive the built app against a running `wrangler dev`,
// screenshot each view. Usage: CHROMIUM_PATH=/opt/pw-browsers/chromium node scripts/ui-smoke.mjs [outdir]
import { chromium } from '@playwright/test';

const out = process.argv[2] ?? 'screens';
const base = 'http://localhost:8787';

const browser = await chromium.launch(
  process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
);
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
page.on('console', (m) => m.type() === 'error' && console.log('console error:', m.text()));
page.on('pageerror', (e) => console.log('page error:', e.message));

await page.goto(base);
await page.waitForSelector('.tab-bar', { timeout: 30000 });
await page.waitForTimeout(1200);
await page.screenshot({ path: `${out}/1-map.png` });

// Open a bubble — descent view (engaged card) or classic tiles
const card = page.locator('.dsc-card, .bubble').first();
if (await card.count()) {
  await card.click();
  await page.waitForTimeout(400);
  await card.click(); // descent: first tap may only snap focus; second opens
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${out}/2-bubble-open.png` });
  await page.mouse.click(20, 100); // close sheet
  await page.waitForTimeout(300);
}

// Capture via the capture bar
await page.fill('.capture-bar textarea', 'buy soy milk before Sarah arrives');
await page.click('.capture-bar button');
await page.waitForTimeout(1500);
await page.screenshot({ path: `${out}/3-after-capture.png` });

// Browse
await page.click('.tab-bar button:nth-child(2)');
await page.waitForTimeout(800);
await page.screenshot({ path: `${out}/4-browse.png` });

// Calendar
await page.click('.tab-bar button:nth-child(3)');
await page.waitForTimeout(800);
await page.screenshot({ path: `${out}/5-calendar.png` });

// Search
await page.click('.tab-bar button:nth-child(4)');
await page.fill('.search-bar input', 'sarah');
await page.waitForTimeout(900);
await page.screenshot({ path: `${out}/6-search.png` });

// Item sheet from search result
const row = page.locator('.item-row').first();
if (await row.count()) {
  await row.click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${out}/7-item-sheet.png` });
}

await browser.close();
console.log('screens written to', out);
