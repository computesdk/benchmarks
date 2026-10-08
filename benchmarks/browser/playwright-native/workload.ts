import { readFileSync } from 'node:fs';
import type { Page, ElementHandle } from 'playwright-native-core';
import { withTimeout } from '../../src/util/timeout.js';
import type { ActionResult, ActionType } from '../throughput-types.js';
import { requiredEnv, safeError } from './providers.js';

const LOOPS_PER_SESSION = 5;
export const ACTIONS_PER_SESSION = LOOPS_PER_SESSION * 10;
export const ACTION_TIMEOUT_MS = 30_000;
export const ARTICLE_LINK_SELECTOR = '#mw-content-text a[href*="/wiki/"]';

export function articleUrl(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Article URL must be a string');
  const url = new URL(value);
  const article = url.pathname.slice('/wiki/'.length);
  if (url.origin !== 'https://en.wikipedia.org' || url.username || url.password || !url.pathname.startsWith('/wiki/') || !article || decodeURIComponent(article).includes(':') || url.search || url.hash) {
    throw new Error('Expected a concrete Wikipedia article URL');
  }
  return url.href;
}

export function loadArticleUrls(): string[] {
  const parsed: unknown = JSON.parse(readFileSync(requiredEnv('PLAYWRIGHT_NATIVE_URLS_FILE'), 'utf8'));
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error('Expected a nonempty array of validated article URLs');
  return parsed.map(articleUrl);
}

export async function firstArticleLink(page: Page): Promise<ElementHandle> {
  await page.waitForSelector(ARTICLE_LINK_SELECTOR, { timeout: 10_000 });
  const links = await page.$$(ARTICLE_LINK_SELECTOR);
  for (const link of links) {
    const href = await link.getAttribute('href');
    const match = href?.match(/\/wiki\/([^#]*)/);
    if (match && !match[1].includes(':')) return link;
  }
  throw new Error('No article body link found on page');
}

export async function runActionLoop(page: Page, url: string, actions: ActionResult[]): Promise<void> {
  const operations: [ActionType, () => Promise<unknown>][] = [
    ['navigate', () => page.goto(url, { waitUntil: 'load' })],
    ['waitForSelector', () => page.waitForSelector('#firstHeading')],
    ['screenshot', () => page.screenshot()],
    ['textContent', () => page.textContent('#firstHeading')],
    ['click', async () => { await (await firstArticleLink(page)).click(); }],
    ['waitForSelector', () => page.waitForSelector('#firstHeading')],
    ['screenshot', () => page.screenshot()],
    ['textContent', () => page.textContent('#firstHeading')],
    ['goBack', () => page.goBack({ waitUntil: 'commit' })],
    ['waitForSelector', () => page.waitForSelector('#firstHeading')],
  ];
  for (let loop = 0; loop < LOOPS_PER_SESSION; loop++) {
    let clickFailed = false;
    for (const [offset, [type, operation]] of operations.entries()) {
      const index = loop * operations.length + offset + 1;
      if (clickFailed && offset >= 5) {
        actions.push({ index, type, durationMs: 0, success: false, error: 'skipped: click failed' });
        continue;
      }
      const start = performance.now();
      try {
        await withTimeout(operation(), ACTION_TIMEOUT_MS, 'Action timed out');
        actions.push({ index, type, durationMs: performance.now() - start, success: true });
      } catch (error) {
        actions.push({ index, type, durationMs: performance.now() - start, success: false, error: safeError(error) });
        if (offset === 4) clickFailed = true;
      }
    }
  }
}
