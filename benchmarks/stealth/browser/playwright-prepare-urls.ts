/**
 * Resolve and DOM-validate shared Wikipedia inputs before measured sessions:
 * N rounds of Special:Random, each kept only if it lands on a concrete
 * en.wikipedia.org article with a clickable in-body article link. Output is a
 * JSON array; the throughput suite consumes it via
 * PLAYWRIGHT_NATIVE_URLS_FILE (default: committed browser-playwright-urls.json).
 *
 *   pnpm exec tsx benchmarks/stealth/browser/prepare-urls.ts 100 benchmarks/stealth/browser/browser-playwright-urls.json
 */
import { chromium } from 'playwright-native-core';
import { seedWikipediaCookie } from '../../browser/wikipedia.js';
import { writeFileSync } from 'node:fs';
import { articleUrl, firstArticleLink } from './playwright-workload.js';
import { withTimeout } from '../src/util/timeout.js';
import { VIEWPORT } from './playwright-providers.js';

const count = Number(process.argv[2] ?? '100');
const filename = process.argv[3] ?? 'browser-playwright-urls.json';
if (!Number.isInteger(count) || count < 1) throw new Error('Count must be a positive integer');
const browser = await chromium.launch({ headless: true, timeout: 30_000 });
try {
  const page = await browser.newPage({ viewport: VIEWPORT });
  page.setDefaultTimeout(30_000);
  page.setDefaultNavigationTimeout(30_000);
  await seedWikipediaCookie(page.context());
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
