/**
 * CPU-node sandbox benchmark: runs the node-web-tooling build inside a fresh
 * sandbox once per iteration and measures the build duration.
 * Declarative — exports `config` + `task`; `bench run` owns the entrypoint.
 *
 * Run:
 *   bench run benchmarks/sandbox/cpu-node.bench.ts
 *   bench run benchmarks/sandbox/cpu-node.bench.ts --provider e2b,modal --iterations 3
 */
import '../src/env.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { JsonObject } from '@benchsdk/client';
import { defineBenchmarkConfig, defineTask, TaskError } from '@benchsdk/runner';
import { providers } from './providers.js';
import type { ProviderConfig } from './types.js';
import { runCpuNodeBenchmark, SUITE_CONFIG } from './cpu-node.js';
import { writeCpuNodeLegacyResults } from './cpu-node-legacy-results.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const config = defineBenchmarkConfig({
  benchmarkSlug: `sandbox-cpu-node${process.env.DAILY_BENCH_SLUG ? `-${process.env.DAILY_BENCH_SLUG}` : ''}`,
  benchmarkName: `Sandbox CPU node${process.env.DAILY_BENCH_NAME ? ` - ${process.env.DAILY_BENCH_NAME}` : ''}`,
  iterations: 3,
  concurrency: 1,
  groupBy: 'round',
  participants: providers,
  onScore: (lowerIsBetter) => ({
    metrics: [
      lowerIsBetter('buildMs', {
        unit: 'ms',
        ceiling: SUITE_CONFIG.ceiling,
        value: (record) => record.latencyMs,
        weights: { median: 1, p95: 0, p99: 0 },
      }),
    ],
  }),
  onComplete: (outcome) =>
    writeCpuNodeLegacyResults(outcome.participants, {
      resultsDir: path.resolve(__dirname, '../../results/cpu_node'),
    }),
});

export const task = defineTask<ProviderConfig>(async (ctx) => {
  const { participant } = ctx;
  const result = await runCpuNodeBenchmark({ ...participant, replicas: 1 });
  const data = result as unknown as JsonObject;

  if (result.skipped) {
    return { data };
  }

  const workload = result.iterations[0];
  if (!workload || workload.ok === false) {
    const message = workload?.error ?? 'cpu-node workload failed';
    throw new TaskError(message, {
      code: 'cpu_node_workload_failed',
      data: { ...result, errorMessage: message } as unknown as JsonObject,
    });
  }

  return { data, latencyMs: workload.metric.value };
});
