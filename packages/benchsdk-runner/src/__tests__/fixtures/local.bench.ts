import { defineBenchmarkConfig, defineTask } from '../../bench-config.js';

export const config = defineBenchmarkConfig({
  benchmarkSlug: 'cli-local',
  benchmarkName: 'CLI local fixture',
  iterations: 1,
  participants: [{ name: 'local', requiredEnvVars: [] }],
});

export const task = defineTask(async () => {});
