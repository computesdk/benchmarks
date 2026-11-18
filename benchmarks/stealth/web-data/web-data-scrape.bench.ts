/**
 * Web data scrape benchmark: one synchronous URL → markdown call per
 * iteration. Declarative — exports `config` + `task`; `bench run` owns the
 * entrypoint. Migrated from the benchmarks-web-data repo (was `test-web-scrape`
 * under benchmarks/stealth/scrape/).
 *
 * Iteration N scrapes `SCRAPE_TARGETS[N % length]` (see urls.ts), so the
 * default 36 iterations hit each of the 12 URLs three times. `groupBy:
 * 'round'` with every provider in a round running concurrently means each
 * round is one URL scraped by every provider at the same moment.
 *
 * Success is content-validated, not status-based: a scrape only succeeds when
 * the returned markdown contains the URL's marker phrase and no bot-challenge
 * text. Failures throw a TaskError whose code is the failure reason, and the
 * runner's composite (latency score × success rate) does the rest.
 *
 *   pnpm bench benchmarks/stealth/web-data/web-data-scrape.bench.ts
 *   pnpm bench benchmarks/stealth/web-data/web-data-scrape.bench.ts --iterations 12 --provider firecrawl --no-ingest
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import '../src/env.js';
import { defineBenchmarkConfig, defineTask, TaskError } from '@benchsdk/runner';
import { formatError } from '../src/util/error.js';
import { scrapeProviders } from './providers.js';
import { SCRAPE_TARGETS, BLOCK_PAGE_PATTERNS } from './urls.js';
import { writeWebDataScrapeResults } from './web-data-scrape-legacy-results.js';
import type { ScrapeProviderConfig } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Timeout passed to the provider for the scrape itself. */
const PROVIDER_TIMEOUT_MS = 60_000;
/** Client-side abort, with headroom over the provider's own timeout. */
const REQUEST_TIMEOUT_MS = 75_000;
/** Below this, a response without the marker is classified as empty. */
const MIN_CONTENT_CHARS = 200;

export const config = defineBenchmarkConfig({
  benchmarkSlug: process.env.BENCHMARK_SLUG ?? 'web-data-scrape',
  benchmarkName: process.env.BENCHMARK_NAME ?? 'Web Data Scrape',
  iterations: SCRAPE_TARGETS.length * 3,
  groupBy: 'round',
  concurrency: scrapeProviders.length,
  participants: scrapeProviders,
  dimensions: { cache: 'disabled', mainContentOnly: true },
  display: {
    metrics: [
      { key: 'scrapeMs', label: 'Scrape latency', unit: 'ms', direction: 'lower-better', decimals: 0 },
      { key: 'contentChars', label: 'Markdown length', unit: 'chars', direction: 'higher-better', decimals: 0 },
    ],
    steps: [{ key: 'scrape', label: 'Scrape' }],
    overview: { defaultMetric: 'compositeScore', defaultLayout: 'ranking' },
  },
  scoring: {
    groupBy: 'bucket',
    metrics: [
      { key: 'scrapeMs', ceiling: 30_000, weights: { median: 0.6, p95: 0.3, p99: 0.1 } },
    ],
  },
  onComplete: (outcome) =>
    writeWebDataScrapeResults(outcome.participants, {
      resultsDir: path.resolve(__dirname, '../../../results/web_data_scrape'),
    }),
});

export const task = defineTask<ScrapeProviderConfig>(async ({ participant, taskIndex, step, log }) => {
  const target = SCRAPE_TARGETS[taskIndex % SCRAPE_TARGETS.length];
  const base = { bucket: target.bucket, url: target.url };

  const start = performance.now();
  let json: any;
  try {
    json = await step('scrape', async () => {
      const res = await fetch(participant.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...participant.buildHeaders() },
        body: JSON.stringify(participant.buildBody(target.url, PROVIDER_TIMEOUT_MS)),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const text = await res.text();
      if (!res.ok) {
        // 429 is the provider's own API rate limit (plan tier), not the target
        // site — kept as its own code so it never reads as a scrape failure.
        throw new TaskError(`Provider API returned ${res.status}`, {
          code: res.status === 429 ? 'RATE_LIMITED' : 'HTTP_ERROR',
          data: {
            apiStatus: res.status,
            responseBody: text.slice(0, 500),
            ...(res.headers.get('retry-after') !== null && { retryAfter: res.headers.get('retry-after')! }),
          },
        });
      }
      return JSON.parse(text);
    });
  } catch (err) {
    const scrapeMs = performance.now() - start;
    const isTimeout = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    const code = isTimeout ? 'TIMEOUT' : err instanceof TaskError ? err.code ?? 'HTTP_ERROR' : 'REQUEST_FAILED';
    const errData = err instanceof TaskError ? err.data ?? {} : {};
    const message = formatError(err);
    log('Scrape request failed', { level: 'error', meta: { ...base, ...errData, code, error: message } });
    throw new TaskError(message, { code, data: { ...base, ...errData, scrapeMs, errorMessage: message } });
  }
  const scrapeMs = performance.now() - start;

  const out = participant.parseResponse(json);
  const data = {
    ...base,
    scrapeMs,
    contentChars: out.markdown.length,
    ...(out.targetStatus !== undefined && { targetStatus: out.targetStatus }),
    ...(out.cacheStatus !== undefined && { cacheStatus: out.cacheStatus }),
  };
  if (out.cacheStatus === 'hit') {
    log('Provider served a cached result despite live-fetch settings', { level: 'warn', meta: data });
  }

  const failure = classify(out.markdown, target.marker, out.targetStatus, out.error);
  if (failure) {
    log('Scrape failed validation', { level: 'warn', meta: { ...data, code: failure.code, reason: failure.message } });
    throw new TaskError(failure.message, { code: failure.code, data: { ...data, errorMessage: failure.message } });
  }

  return { data, latencyMs: scrapeMs };
});

/** Returns null on success, or the failure reason for an unusable scrape. */
function classify(
  markdown: string,
  marker: string,
  targetStatus: number | undefined,
  providerError: string | undefined,
): { code: string; message: string } | null {
  const text = toPlainText(markdown);
  const blocked = BLOCK_PAGE_PATTERNS.find((p) => p.test(text));
  if (blocked) return { code: 'BLOCKED', message: `Bot challenge page returned (${blocked.source})` };
  if (text.includes(toPlainText(marker))) return null;
  if (providerError) return { code: 'TARGET_ERROR', message: providerError };
  if (targetStatus !== undefined && targetStatus >= 400) {
    return { code: 'TARGET_ERROR', message: `Target page returned ${targetStatus}` };
  }
  if (markdown.trim().length < MIN_CONTENT_CHARS) {
    return { code: 'EMPTY', message: `Only ${markdown.trim().length} chars of content` };
  }
  return { code: 'MARKER_MISSING', message: `Expected content "${marker}" not found` };
}

/**
 * Markdown → comparable plain text, so a marker matches the page's prose no
 * matter how a provider formats it: `is [data scraping](/wiki/Data_scraping)
 * used` must match "data scraping used". Drops link targets and emphasis,
 * collapses whitespace, lower-cases.
 */
function toPlainText(markdown: string): string {
  return markdown
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`]+/g, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}
