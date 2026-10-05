/** Five ten-action loops; setup and cleanup excluded from action throughput. */
import '../src/env.js';
import { defineBenchmarkConfig, defineTask, TaskError, parseCliArgs } from '@benchsdk/runner';
import { nativeConfig, runSession } from './playwright-native/session.js';
import { distribution, writeNativeResults } from './playwright-native/results.js';
import { ACTIONS_PER_SESSION, loadArticleUrls, runActionLoop } from './playwright-native/workload.js';
import type { ActionResult } from './throughput-types.js';

// Load the frozen validated inputs before any measured provider request.
const urls = loadArticleUrls();
const iterationArgs = process.argv.flatMap((arg, index) => arg.startsWith('--iterations=') ? [arg] : arg === '--iterations' ? [arg, process.argv[index + 1] ?? ''] : []);
const iterations = parseCliArgs(iterationArgs).iterations ?? nativeConfig.iterations;
if (urls.length < iterations) throw new Error('Prepare a validated article URL for every requested iteration before measurement');

export const config = defineBenchmarkConfig({
  ...nativeConfig,
  benchmarkSlug: 'playwright-native-throughput',
  benchmarkName: 'Playwright-native Browser Throughput',
  display: {
    metrics: [
      { key: 'actionsPerSecond', label: 'Actions/s', unit: '/s', direction: 'higher-better' },
      { key: 'taskMs', label: 'Sum of action durations', unit: 'ms', direction: 'lower-better' },
      { key: 'screenshotMs', label: 'Session median screenshot', unit: 'ms', direction: 'lower-better' },
      { key: 'cleanupMs', label: 'Cleanup', unit: 'ms', direction: 'lower-better' },
    ],
    overview: { defaultMetric: 'actionsPerSecond', defaultLayout: 'chart' },
  },
  onComplete: outcome => { writeNativeResults(outcome, 'throughput', urls); },
});

export const task = defineTask<typeof nativeConfig.participants[number]>(async ctx => {
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
        Object.assign(data, { actions: actions.map(action => ({ ...action })) }, metrics);
        ctx.measure(metrics);
      }
    });
    if (data.actionsCompleted !== ACTIONS_PER_SESSION) throw new Error('Incomplete action session');
  });
});
