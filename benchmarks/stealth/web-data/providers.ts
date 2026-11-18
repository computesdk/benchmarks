import type { ScrapeProviderConfig } from './types.js';

/**
 * Scrape provider configurations: one synchronous URL → markdown call each,
 * hit directly over HTTP (no SDKs).
 *
 * Every provider is pinned to the same settings:
 * - Live fetch only. Both providers cache by default (Firecrawl `maxAge` 2
 *   days, Context.dev `maxAgeMs` 3 days), which would measure cache hits
 *   instead of scraping. `cacheStatus` is recorded so a hit is visible.
 * - Main content only (Firecrawl's default; Context.dev defaults to off).
 * - Otherwise provider defaults — no extra proxy/stealth tier or waits.
 *
 * Add providers above the marker comment.
 */
export const scrapeProviders: ScrapeProviderConfig[] = [
  {
    // https://docs.firecrawl.dev/api-reference/endpoint/scrape
    // `proxy` is left at its default ('auto'), which retries with an enhanced
    // proxy when the basic one is blocked — that's Firecrawl's out-of-box
    // behavior.
    name: 'firecrawl',
    requiredEnvVars: ['FIRECRAWL_API_KEY'],
    endpoint: 'https://api.firecrawl.dev/v2/scrape',
    buildHeaders: () => ({ Authorization: `Bearer ${process.env.FIRECRAWL_API_KEY}` }),
    buildBody: (url, timeoutMs) => ({
      url,
      formats: ['markdown'],
      onlyMainContent: true,
      maxAge: 0,
      timeout: timeoutMs,
    }),
    parseResponse: (json) => ({
      markdown: json?.data?.markdown ?? '',
      targetStatus: json?.data?.metadata?.statusCode,
      cacheStatus: json?.data?.metadata?.cacheState,
      error: json?.success === false ? (json?.error ?? 'success: false') : (json?.data?.metadata?.error ?? undefined),
    }),
  },
  {
    // https://docs.context.dev/api-reference/web-scraping/scrape
    // JS rendering and anti-bot handling are on for every request.
    name: 'context-dev',
    requiredEnvVars: ['CONTEXT_DEV_API_KEY'],
    endpoint: 'https://api.context.dev/v1/web/scrape',
    buildHeaders: () => ({ Authorization: `Bearer ${process.env.CONTEXT_DEV_API_KEY}` }),
    buildBody: (url, timeoutMs) => ({
      url,
      formats: { markdown: true },
      sharedParams: { mainContentOnly: true },
      maxAgeMs: 0,
      timeoutOpts: { milliseconds: timeoutMs, behavior: 'fail' },
    }),
    parseResponse: (json) => ({
      markdown: json?.markdown?.data ?? '',
      cacheStatus: json?.cache_metadata?.status,
      error: json?.markdown?.success === false
        ? `${json.markdown.error_code ?? 'error'}: ${json.markdown.message ?? ''}`.trim()
        : undefined,
    }),
  },
  // add scrape providers above
];
