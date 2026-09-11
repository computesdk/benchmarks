import { defineBenchmarkConfig, defineTask } from '../../bench-config.js';

export const config = defineBenchmarkConfig({
  benchmarkSlug: 'cli-shapes',
  benchmarkName: 'CLI shapes fixture',
  iterations: 1,
  participants: [{ name: 'local', requiredEnvVars: [] }],
  shapes: {
    burst: { slug: 'cli-shapes-burst' },
    staggered: { slug: 'cli-shapes-staggered', staggerDelayMs: 100 },
  },
});

export const task = defineTask(async () => {});
