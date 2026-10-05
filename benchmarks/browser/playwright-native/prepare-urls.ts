/** Resolve and DOM-validate shared Wikipedia inputs before measured sessions. */
import { chromium } from 'playwright-native-core';
import { writeFileSync } from 'node:fs';
import { articleUrl, firstArticleLink } from './workload.js';
import { withTimeout } from '../../src/util/timeout.js';

const count = Number(process.argv[2] ?? '100');
const filename = process.argv[3] ?? 'playwright-native-urls.json';
if (!Number.isInteger(count) || count < 1) throw new Error('Count must be a positive integer');
const browser = await chromium.launch({ headless: true, timeout: 30_000 });
try {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  page.setDefaultTimeout(30_000);
  page.setDefaultNavigationTimeout(30_000);
  const urls: string[] = [];
  for (let i = 0; i < count; i++) {
    await page.goto('https://en.wikipedia.org/wiki/Special:Random', { waitUntil: 'load' });
    const url = articleUrl(page.url());
    await page.waitForSelector('#firstHeading');
    await withTimeout((await firstArticleLink(page)).click(), 30_000, 'Article link validation timed out');
    await page.waitForSelector('#firstHeading');
    urls.push(url);
  }
  writeFileSync(filename, JSON.stringify(urls, null, 2));
  console.log(`Wrote ${urls.length} validated shared inputs to ${filename}`);
} finally { await withTimeout(browser.close(), 15_000, 'URL preparation cleanup timed out'); }
