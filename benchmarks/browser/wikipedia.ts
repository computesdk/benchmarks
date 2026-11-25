import type { BrowserContext } from 'playwright-core';
import { withTimeout } from '../src/util/timeout.js';

export const WIKIPEDIA_ARTICLE_LINK_SELECTOR = '#mw-content-text a[href*="/wiki/"]:visible';

interface ArticleLink {
  getAttribute(name: string): Promise<string | null>;
}

// Structural types keep the same selection rule usable over CDP and the
// separately versioned Playwright-native client, preserving its handle type.
interface ArticleLinkPage<Link extends ArticleLink> {
  url(): string;
  waitForSelector(selector: string, options: { timeout: number }): Promise<unknown>;
  $$(selector: string): Promise<Link[]>;
}

/** Select a visible article link without leaving the current wiki. */
export async function firstWikipediaArticleLink<Link extends ArticleLink>(page: ArticleLinkPage<Link>): Promise<Link> {
  // Filter visibility before taking DOM order: a collapsed infobox may contain
  // the first otherwise-valid article link, even when an earlier File: link
  // satisfied the old visibility wait.
  await page.waitForSelector(WIKIPEDIA_ARTICLE_LINK_SELECTOR, { timeout: 10_000 });
  const baseUrl = new URL(page.url());
  const links = await page.$$(WIKIPEDIA_ARTICLE_LINK_SELECTOR);
  for (const link of links) {
    const href = await link.getAttribute('href');
    if (!href) continue;
    try {
      const url = new URL(href, baseUrl);
      if (url.origin !== baseUrl.origin || !url.pathname.startsWith('/wiki/')) continue;
      const article = decodeURIComponent(url.pathname.slice('/wiki/'.length));
      if (article && !article.includes(':')) return link;
    } catch {
      // Malformed URLs and percent escapes are not article destinations.
    }
  }
  throw new Error('No visible same-origin article body link found on page');
}

/**
 * Give every Wikipedia session the same cookie state before its first request.
 * Some cloud egress ranges receive HTTP 429 for fresh, cookieless sessions.
 * This only updates the browser's cookie jar; it does not warm DNS, TLS, or HTTP.
 * Call outside measured navigation/action windows.
 */
export async function seedWikipediaCookie(context: Pick<BrowserContext, 'addCookies'>): Promise<void> {
  try {
    await withTimeout(context.addCookies([{
      name: 'WMF-Last-Access-Global',
      // DD-Mon-YYYY in UTC, e.g. 20-Nov-2026.
      value: new Date().toUTCString().slice(5, 16).replaceAll(' ', '-'),
      domain: '.wikipedia.org',
      path: '/',
      secure: true,
      sameSite: 'Lax',
    }]), 5_000, 'Wikipedia cookie setup timed out');
  } catch (error) {
    throw new Error(`Wikipedia cookie setup failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}
