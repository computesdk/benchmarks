import { defineBenchmarkConfig, defineTask } from '../../bench-config.js';

// Same as good.bench.ts (env-gates to zero participants), plus a `beforeExit`
// hook that counts its calls on globalThis.
export const config = defineBenchmarkConfig({
  benchmarkSlug: 'cli-before-exit',
  benchmarkName: 'CLI beforeExit fixture',
  iterations: 1,
  participants: [{ name: 'x', requiredEnvVars: ['CLI_TEST_MISSING_VAR'] }],
});

export const task = defineTask(async () => {});

export const beforeExit = () => {
  const g = globalThis as { __beforeExitCalls?: number };
  g.__beforeExitCalls = (g.__beforeExitCalls ?? 0) + 1;
};
