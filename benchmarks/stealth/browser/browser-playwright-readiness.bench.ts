/**
 * Playwright-native Browser Readiness: per session, times the first provider
 * request through example.com load = `readinessMs` (provision →
 * chromium.connect → context+page → navigate); session release measured
 * separately as `cleanupMs`. Participants: Momentic Browser Fleet + Azure
 * Playwright Workspaces via `chromium.connect()` (Playwright server protocol,
 * client pinned to 1.60.x). `groupBy: 'round'` interleaves providers on one
 * runner so each round sees identical conditions.
 *
 *   pnpm bench benchmarks/stealth/browser/browser-playwright-readiness.bench.ts --iterations 1 --no-ingest
 *   pnpm bench benchmarks/stealth/browser/browser-playwright-readiness.bench.ts --provider momentic --iterations 1 --no-ingest
 */
import { defineBenchmarkConfig, defineTask, type BenchmarkScoringConfig } from '@benchsdk/runner';
import { runSession } from './playwright-session.js';
import { playwrightProviders, requireProviderCredentials } from './playwright-providers.js';
import type { PlaywrightProviderConfig } from './playwright-types.js';
import { writeNativeResults, writeLegacyResults } from './playwright-results.js';

requireProviderCredentials();

const slug = process.env.BENCHMARK_SLUG ?? 'browser-playwright-readiness';

const scoringMetrics: BenchmarkScoringConfig['metrics'] = [
  { key: 'readinessMs', label: 'Browser readiness', unit: 'ms', ceiling: 60_000, weights: { median: 0.5, p95: 0.2, p99: 0.1 } },
  { key: 'cleanupMs', label: 'Cleanup', unit: 'ms', ceiling: 15_000, weights: { median: 0.2, p95: 0, p99: 0 } },
];

export const config = defineBenchmarkConfig({
  benchmarkSlug: slug,
  benchmarkName: process.env.BENCHMARK_NAME ?? 'Playwright-native Browser Readiness',
  iterations: 100,
  concurrency: 1,
  groupBy: 'round',
  participants: playwrightProviders,
  scoring: {
    success: { requireData: { workloadSuccess: true } },
    metrics: scoringMetrics,
  },
  display: {
    metrics: [
      { key: 'readinessMs', label: 'Browser readiness', unit: 'ms', direction: 'lower-better' },
      { key: 'cleanupMs', label: 'Cleanup', unit: 'ms', direction: 'lower-better' },
    ],
    steps: [
      { key: 'provision', label: 'Provision session' },
      { key: 'connect', label: 'Connect Playwright' },
      { key: 'page', label: 'Create context and page' },
      { key: 'navigate', label: 'Navigate page' },
      { key: 'reconcile-context', label: 'Reconcile pending context' },
      { key: 'close-context', label: 'Close context' },
      { key: 'close-browser', label: 'Close browser' },
      { key: 'release', label: 'Release session' },
    ],
    overview: { defaultMetric: 'readinessMs', defaultLayout: 'chart' },
  },
  onComplete: outcome => {
    writeNativeResults(outcome, 'readiness');
    writeLegacyResults(outcome, slug, 'readinessMs', scoringMetrics);
  },
});

export const task = defineTask<PlaywrightProviderConfig>(ctx => runSession(ctx, async (page, startedAt, data) => {
  await ctx.step('navigate', async () => {
    await page.goto('https://www.example.com', { waitUntil: 'load' });
    data.readinessMs = performance.now() - startedAt;
    ctx.measure({ readinessMs: data.readinessMs });
  });
}));
