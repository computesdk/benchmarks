/** First per-session request → example.com load; cleanup is measured separately. */
import '../src/env.js';
import { defineBenchmarkConfig, defineTask } from '@benchsdk/runner';
import { runSession } from './playwright-session.js';
import { playwrightProviders, requireProviderCredentials } from './playwright-providers.js';
import type { PlaywrightProviderConfig } from './playwright-types.js';
import { writeNativeResults } from './playwright-results.js';

requireProviderCredentials();

export const config = defineBenchmarkConfig({
  benchmarkSlug: 'playwright-native-readiness',
  benchmarkName: 'Playwright-native Browser Readiness',
  iterations: 100,
  concurrency: 1,
  groupBy: 'round',
  participants: playwrightProviders,
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
  onComplete: outcome => writeNativeResults(outcome, 'readiness'),
});

export const task = defineTask<PlaywrightProviderConfig>(ctx => runSession(ctx, async (page, startedAt, data) => {
  await ctx.step('navigate', async () => {
    await page.goto('https://www.example.com', { waitUntil: 'load' });
    data.readinessMs = performance.now() - startedAt;
    ctx.measure({ readinessMs: data.readinessMs });
  });
}));
