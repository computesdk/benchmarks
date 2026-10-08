/** First per-session request → example.com load; cleanup is measured separately. */
import '../src/env.js';
import { defineBenchmarkConfig, defineTask } from '@benchsdk/runner';
import { nativeConfig, runSession } from './playwright-native/session.js';
import { writeNativeResults } from './playwright-native/results.js';

export const config = defineBenchmarkConfig({
  ...nativeConfig,
  benchmarkSlug: 'playwright-native-readiness',
  benchmarkName: 'Playwright-native Browser Readiness',
  display: {
    metrics: [
      { key: 'readinessMs', label: 'Browser readiness', unit: 'ms', direction: 'lower-better' },
      { key: 'cleanupMs', label: 'Cleanup', unit: 'ms', direction: 'lower-better' },
    ],
    overview: { defaultMetric: 'readinessMs', defaultLayout: 'chart' },
  },
  onComplete: outcome => writeNativeResults(outcome, 'readiness'),
});

export const task = defineTask<typeof nativeConfig.participants[number]>(ctx => runSession(ctx, async (page, startedAt, data) => {
  await ctx.step('navigate', async () => {
    await page.goto('https://www.example.com', { waitUntil: 'load' });
    data.readinessMs = performance.now() - startedAt;
    ctx.measure({ readinessMs: data.readinessMs });
  });
}));
