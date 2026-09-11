import { defineBenchmarkConfig, defineTask } from '../../bench-config.js';

export const config = defineBenchmarkConfig({
  benchmarkSlug: 'cli-bad-onscore',
  benchmarkName: 'CLI bad onScore fixture',
  iterations: 1,
  participants: [{ name: 'x', requiredEnvVars: ['CLI_TEST_MISSING_VAR'] }],
  display: {
    metrics: [{ key: 'ttiMs', label: 'TTI' }],
    overview: { defaultMetric: 'compositeScore' },
  },
  onScore: () => ({ metrics: [] }),
});

export const task = defineTask(async () => {});
