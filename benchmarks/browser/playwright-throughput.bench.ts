/** Five ten-action loops; setup and cleanup excluded from action throughput. */
import '../src/env.js';
import { defineBenchmarkConfig, defineTask, TaskError, mergeConfig } from '@benchsdk/runner';
import { runSession } from './playwright-session.js';
import { playwrightProviders, requireProviderCredentials, playwrightArgs } from './playwright-providers.js';
import type { PlaywrightProviderConfig } from './playwright-types.js';
import { distribution, writeNativeResults } from './playwright-results.js';
import { ACTIONS_PER_SESSION, loadArticleUrls, runActionLoop } from './playwright-workload.js';
import type { ActionResult } from './throughput-types.js';

// Load the frozen validated inputs before any measured provider request.
const urls = loadArticleUrls();

requireProviderCredentials();

export const config = defineBenchmarkConfig({
  benchmarkSlug: 'playwright-native-throughput',
  benchmarkName: 'Playwright-native Browser Throughput',
  iterations: 100,
  concurrency: 1,
  groupBy: 'round',
  participants: playwrightProviders,
  display: {
    metrics: [
      { key: 'actionsPerSecond', label: 'Actions/s', unit: '/s', direction: 'higher-better' },
      { key: 'actionsCompleted', label: 'Actions completed', direction: 'higher-better', decimals: 0 },
      { key: 'taskMs', label: 'Sum of action durations', unit: 'ms', direction: 'lower-better' },
      { key: 'screenshotMs', label: 'Session median screenshot', unit: 'ms', direction: 'lower-better' },
      { key: 'cleanupMs', label: 'Cleanup', unit: 'ms', direction: 'lower-better' },
    ],
    steps: [
      { key: 'provision', label: 'Provision session' },
      { key: 'connect', label: 'Connect Playwright' },
      { key: 'page', label: 'Create context and page' },
      { key: 'actions', label: 'Actions' },
      { key: 'reconcile-context', label: 'Reconcile pending context' },
      { key: 'close-context', label: 'Close context' },
      { key: 'close-browser', label: 'Close browser' },
      { key: 'release', label: 'Release session' },
    ],
    overview: { defaultMetric: 'actionsPerSecond', defaultLayout: 'chart' },
  },
  onComplete: outcome => writeNativeResults(outcome, 'throughput', urls),
});

const iterations = mergeConfig(config, playwrightArgs).iterations;
if (urls.length < iterations) throw new Error('Prepare a validated article URL for every requested iteration before measurement');

export const task = defineTask<PlaywrightProviderConfig>(ctx => {
  const url = urls[ctx.taskIndex];
  if (!url) throw new TaskError('Validated URL list is shorter than the requested run; prepare all inputs first', { code: 'MISSING_INPUT', data: { attemptStarted: false } });
  const actions: ActionResult[] = [];
  return runSession(ctx, async (page, _startedAt, data) => {
    data.articleUrl = url;
    await ctx.step('actions', async () => {
      try {
        await runActionLoop(page, url, actions);
      } finally {
        const taskMs = actions.reduce((sum, action) => sum + action.durationMs, 0);
        const actionsCompleted = actions.filter(action => action.success).length;
        const screenshotMs = distribution(actions.filter(action => action.type === 'screenshot' && action.success).map(action => action.durationMs)).median;
        const metrics = { taskMs, actionsCompleted, actionsPerSecond: taskMs > 0 ? actionsCompleted / (taskMs / 1000) : 0, ...(screenshotMs !== null ? { screenshotMs } : {}) };
        Object.assign(data, metrics, { actions });
        ctx.measure(metrics);
      }
    });
    if (data.actionsCompleted !== ACTIONS_PER_SESSION) throw new Error('Incomplete action session');
  });
});
