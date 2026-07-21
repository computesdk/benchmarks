import { chromium, type Browser, type Page } from 'playwright-core';
import { withTimeout } from '../util/timeout.js';
import {
  ACTION_TYPES,
  ACTIONS_PER_LOOP,
  ACTIONS_PER_SESSION,
  LOOPS_PER_SESSION,
  type ActionResult,
  type ActionType,
  type ThroughputBenchmarkResult,
  type ThroughputProviderConfig,
  type ThroughputStats,
  type ThroughputStatsTriple,
  type ThroughputTimingResult,
} from './throughput-types.js';

const RANDOM_URL = 'https://en.wikipedia.org/wiki/Special:Random';
const FIRST_HEADING = '#firstHeading';

// Providers must be benchmarked against the same pages to be comparable, but in
// CI each provider runs as a separate job/process — so `Special:Random` makes
// each one draw different articles. The workflow resolves one concrete article
// URL per iteration up front and injects the list via THROUGHPUT_URLS (a JSON
// array). Iteration i then navigates to urls[i] for *every* provider: the same
// page across providers, but a different page each iteration so we don't measure
// a warmed cache. Absent the env var (local runs), navigation stays random.
const NAV_URLS: string[] = parseNavUrls();

function parseNavUrls(): string[] {
  const raw = process.env.THROUGHPUT_URLS?.trim();
  if (!raw) return [];
  // Accept either a JSON array or a plain newline/whitespace-delimited list, so
  // the workflow can emit the URLs with pure bash and not depend on jq/python
  // being present on the runner image.
  if (raw.startsWith('[')) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.filter((u): u is string => typeof u === 'string' && u.length > 0);
    } catch {
      // Malformed JSON falls through to whitespace splitting below.
    }
  }
  return raw.split(/\s+/).filter(u => u.length > 0);
}

/** The article URL iteration `i` should navigate to (same across providers). */
export function navUrlForIteration(i: number): string {
  if (NAV_URLS.length > 0) return NAV_URLS[i % NAV_URLS.length];
  return RANDOM_URL;
}
// Match article-body links across classic MediaWiki HTML (relative "/wiki/Foo"),
// Parsoid read-HTML (protocol-relative "//en.wikipedia.org/wiki/Foo"), and the
// newer absolute form ("https://en.wikipedia.org/wiki/Foo").
// We can't use :not([href*=":"]) because that also rejects https: URLs. Instead
// we select all /wiki/ links in the content area and filter in JS by checking
// that the path segment after /wiki/ has no namespace colon (Help:, File:, etc.).
const ARTICLE_LINK_SELECTOR = '#mw-content-text a[href*="/wiki/"]';

/** Returns true if an href points to a real article (not a namespace page). */
function isArticleLink(href: string | null): boolean {
  if (!href) return false;
  const match = href.match(/\/wiki\/([^#]*)/);
  if (!match) return false;
  return !match[1].includes(':');
}

const ACTION_TIMEOUT_MS = 30_000;

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.min(Math.max(idx, 0), sorted.length - 1)];
}

function computeStats(values: number[]): ThroughputStatsTriple {
  if (values.length === 0) return { median: 0, p95: 0, p99: 0 };

  const sorted = [...values].sort((a, b) => a - b);
  // Trim 5% tails when we have enough samples to make trimming meaningful
  const trimCount = Math.floor(sorted.length * 0.05);
  const trimmed = trimCount > 0 && sorted.length - 2 * trimCount > 0
    ? sorted.slice(trimCount, sorted.length - trimCount)
    : sorted;

  const mid = Math.floor(trimmed.length / 2);
  const median = trimmed.length % 2 === 0
    ? (trimmed[mid - 1] + trimmed[mid]) / 2
    : trimmed[mid];

  return {
    median,
    p95: percentile(trimmed, 95),
    p99: percentile(trimmed, 99),
  };
}

async function timeAction<T>(
  fn: () => Promise<T>,
): Promise<{ durationMs: number; success: boolean; error?: string; value?: T }> {
  const start = performance.now();
  try {
    const value = await withTimeout(fn(), ACTION_TIMEOUT_MS, 'Action timed out');
    return { durationMs: performance.now() - start, success: true, value };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { durationMs: performance.now() - start, success: false, error };
  }
}

async function runActionLoop(page: Page, results: ActionResult[], navigateUrl: string): Promise<void> {
  for (let loop = 0; loop < LOOPS_PER_SESSION; loop++) {
    const baseIdx = loop * ACTIONS_PER_LOOP;

    // 1. Navigate to the article for this iteration (shared across providers)
    {
      const r = await timeAction(() =>
        page.goto(navigateUrl, { waitUntil: 'load' }) as Promise<unknown>,
      );
      results.push({ index: baseIdx + 1, type: 'navigate', durationMs: r.durationMs, success: r.success, error: r.error });
    }

    // 2. Wait for #firstHeading
    {
      const r = await timeAction(() => page.waitForSelector(FIRST_HEADING));
      results.push({ index: baseIdx + 2, type: 'waitForSelector', durationMs: r.durationMs, success: r.success, error: r.error });
    }

    // 3. Screenshot
    {
      const r = await timeAction(() => page.screenshot());
      results.push({ index: baseIdx + 3, type: 'screenshot', durationMs: r.durationMs, success: r.success, error: r.error });
    }

    // 4. Read text content of #firstHeading
    {
      const r = await timeAction(() => page.textContent(FIRST_HEADING));
      results.push({ index: baseIdx + 4, type: 'textContent', durationMs: r.durationMs, success: r.success, error: r.error });
    }

    // 5. Click first article link (filter out meta pages like Help:, File:, etc.)
    let clickSucceeded = false;
    {
      const r = await timeAction(async () => {
        // Wait for any /wiki/ link to appear, then filter in JS for article
        // links (no namespace colon after /wiki/). This handles relative,
        // protocol-relative, and absolute https:// URL formats.
        await page.waitForSelector(ARTICLE_LINK_SELECTOR, { timeout: 10_000 });
        const links = await page.$$(ARTICLE_LINK_SELECTOR);
        for (const link of links) {
          const href = await link.getAttribute('href');
          if (isArticleLink(href)) {
            await link.click();
            return;
          }
        }
        throw new Error('No article body link found on page');
      });
      clickSucceeded = r.success;
      results.push({ index: baseIdx + 5, type: 'click', durationMs: r.durationMs, success: r.success, error: r.error });
    }

    // If the click failed (e.g. stub article with no body links), skip the
    // remaining actions that depend on having navigated to a new page.
    // Without this, goBack navigates to a blank page and the final
    // waitForSelector times out for 30s, inflating task time.
    if (!clickSucceeded) {
      for (const idx of [6, 7, 8, 9, 10]) {
        results.push({ index: baseIdx + idx, type: idx <= 8 ? (idx === 6 || idx === 10 ? 'waitForSelector' : idx === 7 ? 'screenshot' : 'textContent') : 'goBack', durationMs: 0, success: false, error: 'skipped: click failed' });
      }
      continue;
    }

    // 6. Wait for #firstHeading on the new page
    {
      const r = await timeAction(() => page.waitForSelector(FIRST_HEADING));
      results.push({ index: baseIdx + 6, type: 'waitForSelector', durationMs: r.durationMs, success: r.success, error: r.error });
    }

    // 7. Screenshot the new page
    {
      const r = await timeAction(() => page.screenshot());
      results.push({ index: baseIdx + 7, type: 'screenshot', durationMs: r.durationMs, success: r.success, error: r.error });
    }

    // 8. Read text content of #firstHeading on the new page
    {
      const r = await timeAction(() => page.textContent(FIRST_HEADING));
      results.push({ index: baseIdx + 8, type: 'textContent', durationMs: r.durationMs, success: r.success, error: r.error });
    }

    // 9. Go back. Use `waitUntil: 'commit'` because back-forward cache restores
    // fire `pageshow` instead of `load`, and Playwright's default
    // `waitUntil: 'load'` hangs for the full timeout on a bfcache restore.
    // Resolving on commit returns as soon as the navigation lands; the next
    // waitForSelector confirms #firstHeading is present.
    {
      const r = await timeAction(() => page.goBack({ waitUntil: 'commit' }) as Promise<unknown>);
      results.push({ index: baseIdx + 9, type: 'goBack', durationMs: r.durationMs, success: r.success, error: r.error });
    }

    // 10. Wait for #firstHeading on the previous page
    {
      const r = await timeAction(() => page.waitForSelector(FIRST_HEADING));
      results.push({ index: baseIdx + 10, type: 'waitForSelector', durationMs: r.durationMs, success: r.success, error: r.error });
    }
  }
}

export async function runThroughputIteration(
  provider: any,
  timeout: number,
  sessionCreateOptions: Record<string, unknown>,
  navigateUrl: string,
): Promise<ThroughputTimingResult> {
  const totalStart = performance.now();
  const actions: ActionResult[] = [];
  let createMs = 0;
  let connectMs = 0;
  let releaseMs = 0;

  let session: { sessionId: string; connectUrl: string } | undefined;
  let browser: Browser | undefined;
  let iterationError: string | undefined;

  try {
    // 1. Create session
    const createStart = performance.now();
    session = await withTimeout(
      provider.session.create(sessionCreateOptions),
      timeout,
      'Session creation timed out',
    ) as { sessionId: string; connectUrl: string };
    createMs = performance.now() - createStart;

    // 2. Connect over CDP
    const connectStart = performance.now();
    browser = await withTimeout(
      chromium.connectOverCDP(session.connectUrl),
      30_000,
      'CDP connection timed out',
    );

    const [context] = browser.contexts();
    if (!context) throw new Error('No default browser context found');
    const [existingPage] = context.pages();
    const page = existingPage ?? await context.newPage();
    connectMs = performance.now() - connectStart;

    // 3. Run the 50-action loop. Individual action failures are recorded but
    // do not abort the session.
    await runActionLoop(page, actions, navigateUrl);
  } catch (err) {
    iterationError = err instanceof Error ? err.message : String(err);
  } finally {
    if (browser) {
      await browser.close().catch(() => { });
    }
    if (session) {
      const releaseStart = performance.now();
      try {
        await withTimeout(
          provider.session.destroy(session.sessionId),
          15_000,
          'Session destroy timed out',
        );
      } catch {
        // Swallow release errors — they're recorded via releaseMs but should
        // not mask the more important action timings.
      }
      releaseMs = performance.now() - releaseStart;
    }
  }

  const totalMs = performance.now() - totalStart;
  const taskMs = actions.reduce((sum, a) => sum + a.durationMs, 0);
  const actionsCompleted = actions.filter(a => a.success).length;
  const actionsPerSecond = taskMs > 0 ? actionsCompleted / (taskMs / 1000) : 0;

  return {
    createMs,
    connectMs,
    actions,
    releaseMs,
    totalMs,
    taskMs,
    actionsCompleted,
    actionsPerSecond,
    ...(iterationError ? { error: iterationError } : {}),
  };
}

export function summarizeIterations(iterations: ThroughputTimingResult[]): ThroughputStats {
  const createValues = iterations.map(i => i.createMs).filter(v => v > 0);
  const taskValues = iterations.map(i => i.taskMs).filter(v => v > 0);
  const totalValues = iterations.map(i => i.totalMs).filter(v => v > 0);
  const apsValues = iterations.map(i => i.actionsPerSecond).filter(v => v > 0);

  const perActionType = {} as Record<ActionType, ThroughputStatsTriple>;
  for (const type of ACTION_TYPES) {
    const values: number[] = [];
    for (const iter of iterations) {
      for (const a of iter.actions) {
        if (a.type === type && a.success) values.push(a.durationMs);
      }
    }
    perActionType[type] = computeStats(values);
  }

  return {
    createMs: computeStats(createValues),
    taskMs: computeStats(taskValues),
    totalMs: computeStats(totalValues),
    actionsPerSecond: computeStats(apsValues),
    perActionType,
  };
}

export function emptySummary(): ThroughputStats {
  const empty: ThroughputStatsTriple = { median: 0, p95: 0, p99: 0 };
  const perActionType = {} as Record<ActionType, ThroughputStatsTriple>;
  for (const t of ACTION_TYPES) perActionType[t] = { ...empty };
  return {
    createMs: { ...empty },
    taskMs: { ...empty },
    totalMs: { ...empty },
    actionsPerSecond: { ...empty },
    perActionType,
  };
}

export async function runThroughputBenchmark(
  config: ThroughputProviderConfig,
): Promise<ThroughputBenchmarkResult> {
  const {
    name,
    iterations = 100,
    timeout = 120_000,
    requiredEnvVars,
    sessionCreateOptions = {},
  } = config;

  const missingVars = requiredEnvVars.filter(v => !process.env[v]);
  if (missingVars.length > 0) {
    return {
      provider: name,
      mode: 'browser-throughput',
      iterations: [],
      summary: emptySummary(),
      skipped: true,
      skipReason: `Missing: ${missingVars.join(', ')}`,
    };
  }

  const provider = config.createBrowserProvider();
  const results: ThroughputTimingResult[] = [];

  console.log(`\n--- Throughput Benchmark: ${name} (${iterations} sessions × ${ACTIONS_PER_SESSION} actions) ---`);
  console.log('Sess  Create   Connect  Task     Release  Total    APS    Actions');
  console.log('────  ───────  ───────  ───────  ───────  ───────  ─────  ───────');

  for (let i = 0; i < iterations; i++) {
    const result = await runThroughputIteration(provider, timeout, sessionCreateOptions, navUrlForIteration(i));
    results.push(result);

    const pad = (n: number) => `${Math.round(n)}ms`.padStart(7);
    const aps = result.actionsPerSecond.toFixed(1).padStart(5);
    const status = `${result.actionsCompleted}/${ACTIONS_PER_SESSION}`;
    const errSuffix = result.error ? `  ✗ ${result.error.slice(0, 50)}` : '';
    console.log(
      `${String(i + 1).padStart(4)}  ${pad(result.createMs)}  ${pad(result.connectMs)}  ${pad(result.taskMs)}  ${pad(result.releaseMs)}  ${pad(result.totalMs)}  ${aps}  ${status}${errSuffix}`,
    );
  }

  return {
    provider: name,
    mode: 'browser-throughput',
    iterations: results,
    summary: summarizeIterations(results),
  };
}

function roundStats(s: ThroughputStatsTriple): ThroughputStatsTriple {
  return { median: round(s.median), p95: round(s.p95), p99: round(s.p99) };
}

export async function writeThroughputResultsJson(
  results: ThroughputBenchmarkResult[],
  outPath: string,
  options: { timeoutMs?: number } = {},
): Promise<void> {
  const fs = await import('fs');
  const os = await import('os');

  const cleanResults = results.map(r => ({
    provider: r.provider,
    mode: r.mode,
    iterations: r.iterations.map(i => ({
      createMs: round(i.createMs),
      connectMs: round(i.connectMs),
      releaseMs: round(i.releaseMs),
      totalMs: round(i.totalMs),
      taskMs: round(i.taskMs),
      actionsCompleted: i.actionsCompleted,
      actionsPerSecond: round(i.actionsPerSecond),
      actions: i.actions.map(a => ({
        index: a.index,
        type: a.type,
        durationMs: round(a.durationMs),
        success: a.success,
        ...(a.error ? { error: a.error } : {}),
      })),
      ...(i.error ? { error: i.error } : {}),
    })),
    summary: {
      createMs: roundStats(r.summary.createMs),
      taskMs: roundStats(r.summary.taskMs),
      totalMs: roundStats(r.summary.totalMs),
      actionsPerSecond: roundStats(r.summary.actionsPerSecond),
      perActionType: Object.fromEntries(
        ACTION_TYPES.map(t => [t, roundStats(r.summary.perActionType[t])]),
      ),
    },
    ...(r.compositeScore !== undefined ? { compositeScore: round(r.compositeScore) } : {}),
    ...(r.successRate !== undefined ? { successRate: round(r.successRate) } : {}),
    ...(r.skipped ? { skipped: r.skipped, skipReason: r.skipReason } : {}),
  }));

  // Derive iteration count from the largest run across providers, so a
  // skipped first provider doesn't make the header read 0.
  const iterations = results.reduce((max, r) => Math.max(max, r.iterations.length), 0);

  const output = {
    version: '1.0',
    timestamp: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: os.platform(),
      arch: os.arch(),
    },
    config: {
      iterations,
      actionsPerSession: ACTIONS_PER_SESSION,
      timeoutMs: options.timeoutMs ?? 120_000,
    },
    results: cleanResults,
  };

  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`Results written to ${outPath}`);
}
