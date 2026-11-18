/**
 * Shared workload helpers for the Playwright-native suites: the frozen
 * article URL list, the article-link helper, and the fixed 10-action loop
 * (navigate → waitForSelector → screenshot → textContent → click article →
 * waitForSelector → screenshot → textContent → goBack → waitForSelector)
 * repeated LOOPS_PER_SESSION times per session.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page, ElementHandle } from 'playwright-native-core';
import { withTimeout } from '../src/util/timeout.js';
import type { ActionResult, ActionType } from './playwright-types.js';
import { safeError } from './playwright-providers.js';

const LOOPS_PER_SESSION = 5;
export const ACTIONS_PER_SESSION = LOOPS_PER_SESSION * 10;
export const ACTION_TIMEOUT_MS = 30_000;
export const ARTICLE_LINK_SELECTOR = '#mw-content-text a[href*="/wiki/"]';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function articleUrl(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Article URL must be a string');
  const url = new URL(value);
  const article = url.pathname.slice('/wiki/'.length);
  if (url.origin !== 'https://en.wikipedia.org' || url.username || url.password || !url.pathname.startsWith('/wiki/') || !article || decodeURIComponent(article).includes(':') || url.search || url.hash) {
    throw new Error('Expected a concrete Wikipedia article URL');
  }
  return url.href;
}

/**
 * Frozen, DOM-validated article URL list committed at
 * browser-playwright-urls.json (regenerate with prepare-urls.ts). Every
 * provider walks the same ordered list so a round exercises identical input.
 * PLAYWRIGHT_NATIVE_URLS_FILE overrides the committed file.
 */
export function loadArticleUrls(): string[] {
  const filename = process.env.PLAYWRIGHT_NATIVE_URLS_FILE ?? path.resolve(__dirname, 'browser-playwright-urls.json');
  let raw: string;
  try { raw = readFileSync(filename, 'utf8'); }
  catch { throw new Error(`Cannot read Playwright-native article URL list at ${filename}; run prepare-urls.ts or set PLAYWRIGHT_NATIVE_URLS_FILE`); }
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error('Expected a nonempty array of validated article URLs');
  return parsed.map(articleUrl);
}

/** Capture the response status a navigate produced, for surfacing real
 * server responses (e.g. "Wikimedia Error" 403s from a provider's egress IP)
 * instead of just the downstream selector timeout it caused. */
export interface PageState {
  lastHttpStatus?: number;
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

export async function runActionLoop(page: Page, url: string, actions: ActionResult[], state: PageState = {}): Promise<void> {
  const operations: [ActionType, () => Promise<unknown>][] = [
    ['navigate', async () => {
      const response = await page.goto(url, { waitUntil: 'load' });
      state.lastHttpStatus = response?.status() ?? undefined;
    }],
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
        // Record where the page actually landed — distinguishes "selector
        // missing" (wrong page / blocked) from a slow load.
        let diag = '';
        try {
          const title = await withTimeout(page.title(), 2_000, 'title read timed out');
          const status = state.lastHttpStatus !== undefined ? ` status=${state.lastHttpStatus}` : '';
          // Body text carries the server's own error message (e.g. Wikimedia's
          // "Request from <ip> blocked" detail) — keep it short and single-line.
          const body = (await withTimeout(page.textContent('body'), 2_000, 'body read timed out'))
            ?.replace(/\s+/g, ' ').trim().slice(0, 200);
          diag = ` [url=${page.url()}${status} title=${JSON.stringify(title)}${body ? ` body=${JSON.stringify(body)}` : ''}]`;
        } catch { /* page may be gone */ }
        actions.push({ index, type, durationMs: performance.now() - start, success: false, error: safeError(error) + diag });
        if (offset === 4) clickFailed = true;
      }
    }
  }
}
