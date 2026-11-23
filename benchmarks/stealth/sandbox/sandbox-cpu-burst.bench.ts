/**
 * CPU-burst sandbox benchmark: a single run over-tasks the CPU with more
 * worker_threads than provisioned `nproc`. If the provider grants extra vCPUs,
 * `burstDetected` is true and the provider is ranked by `burstHeadroom`
 * (effective cores / provisioned cores). Delivering the normalized allocation
 * earns the delivery share even without extra burst capacity.
 *
 * Declarative — exports `config` + `task`; `bench run` owns the entrypoint.
 *
 * Run:
 *   pnpm bench benchmarks/stealth/sandbox/sandbox-cpu-burst.bench.ts
 *   pnpm bench benchmarks/stealth/sandbox/sandbox-cpu-burst.bench.ts --provider e2b,modal --iterations 3
 */
import { benchmarkResultsDir } from '../src/util/results.js';
import { continuousScoring } from './performance-runtime-scoring.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { JsonObject } from '@benchsdk/client';
import { defineBenchmarkConfig, defineTask, TaskError } from '@benchsdk/runner';
import { namespace } from '@computesdk/namespace';
import { providers } from './providers.js';
import type { ProviderConfig } from './types.js';
import type { CpuBurstWorkloadResult } from './sandbox-cpu-burst.js';
import { classifyError, cpuBurstScore, runCpuBurstWorkload, SUITE_CONFIG } from './sandbox-cpu-burst.js';
import { recordsToCpuBurstResults, writeCpuBurstLegacyResults } from './sandbox-cpu-burst-legacy-results.js';
import { formatError } from '../src/util/error.js';
import { drainLateCleanups, withTimeout } from '../src/util/timeout.js';
import { printResultsTable } from './sandbox-cpu-burst-table.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const createTimeoutMs = 120_000;
const destroyTimeoutMs = 15_000;

/**
 * Namespace is sized exclusively through its provider factory, and the shared
 * provider registry pins that factory to the DAX 8-vCPU profile. cpu-burst
 * re-pins it to the standard 1 vCPU / 2 GiB profile so every provider starts
 * from the same baseline.
 */
function withCpuBurstNamespaceFactory(participant: ProviderConfig): ProviderConfig {
  return {
    ...participant,
    createCompute: () =>
      namespace({
        token: process.env.NSC_TOKEN!,
        virtualCpu: CPU_BURST_RESOURCE_PROFILE.cpu,
        memoryMegabytes: CPU_BURST_RESOURCE_PROFILE.memoryMb,
      }),
  };
}

interface CpuBurstSandbox {
  runCommand(
    cmd: string,
    opts?: { timeout?: number },
  ): Promise<{ exitCode: number; stdout?: string; stderr?: string }>;
  destroy(): Promise<unknown>;
}

/**
 * Standardized resource sizing for fair CPU-burst comparison.
 *
 * Providers use different option names and some expose only provider-factory
 * sizing. The map below follows the DAX benchmark pattern for per-sandbox
 * overrides merged over the shared provider registry definitions.
 * Provider definitions that hardcode DAX-sized defaults (e.g. e2b's 8-vCPU
 * template, daytona's 8-vCPU snapshot, namespace's factory sizing) are
 * re-pinned to the standard profile here.
 */
export const CPU_BURST_RESOURCE_PROFILE = {
  cpu: 1,
  memoryMb: 2048,
  label: '1 vCPU / 2 GiB',
} as const;

type CpuBurstResourceStatus =
  | 'standard'
  | 'provider-specific'
  | 'provider-default';

interface CpuBurstResourceSpec {
  status: CpuBurstResourceStatus;
  note: string;
  expectedCpu?: number;
  expectedMemoryMb?: number;
  sandboxOptions: Record<string, unknown>;
  /** Keys of the provider's sandboxOptions to drop after merging. */
  removeOptions?: string[];
}

const standardNote = 'Standard cpu-burst profile: 1 vCPU / 2 GiB.';

const standard = (
  sandboxOptions: Record<string, unknown> = {},
): CpuBurstResourceSpec => ({
  status: 'standard',
  note: standardNote,
  expectedCpu: CPU_BURST_RESOURCE_PROFILE.cpu,
  expectedMemoryMb: CPU_BURST_RESOURCE_PROFILE.memoryMb,
  sandboxOptions,
});

const providerSpecific = (
  note: string,
  expected: Pick<CpuBurstResourceSpec, 'expectedCpu' | 'expectedMemoryMb'> = {},
  sandboxOptions: Record<string, unknown> = {},
  removeOptions: string[] = [],
): CpuBurstResourceSpec => ({
  status: 'provider-specific',
  note,
  ...expected,
  sandboxOptions,
  ...(removeOptions.length ? { removeOptions } : {}),
});

const CPU_BURST_RESOURCE_OPTIONS: Record<string, CpuBurstResourceSpec> = {
  'run-cloud': standard({ cpu: 1, memory: 2048 }),
  beam: standard({ cpu: 1, memory: 2048 }),
  blaxel: standard({ memory: 2048 }),
  createos: standard({ cpus: 1, memoryMb: 2048 }),
  daytona: providerSpecific(
    'The shared provider registry pins daytona to an 8-vCPU snapshot (daytona-8cpu-16gb); cpu-burst drops it because daytona exposes no CPU/memory sizing at sandbox create, so provider defaults apply.',
    { expectedCpu: CPU_BURST_RESOURCE_PROFILE.cpu },
    { autoStopInterval: 15, autoDeleteInterval: 0, runtime: 'node' },
    ['snapshotId'],
  ),
  e2b: providerSpecific(
    'E2B sizes CPU/memory at template build time. The shared registry pins the 8-vCPU base-8cpu-16gb template; cpu-burst replaces it with the shared base template, so actual allocation is whatever base provides.',
    { expectedCpu: CPU_BURST_RESOURCE_PROFILE.cpu },
    { templateId: 'base', timeout: 600_000 },
  ),
  isorun: providerSpecific(
    'Isorun supports 1 vCPU / 1 GiB as its nano tier; it does not offer the 2-GiB standard profile.',
    { expectedCpu: 1, expectedMemoryMb: 1024 },
    { vcpus: 1, memMiB: 1024 },
  ),
  // Modal's cpu value establishes the baseline; omitting cpuLimit preserves
  // the burst capacity this benchmark is intended to measure.
  modal: standard({ cpu: 0.5, memoryMiB: 2048 }),
  microsandbox: standard({ cpus: 1, memoryMib: 2048 }),
  miosa: standard({ vcpus: 1, memory: 2048 }),
  // Mosaic's adapter accepts `vcpus`/`cpus`/`cpu` — a `vcpu` option is ignored
  // and the request falls back to the 2-vCPU default, an unsupported shape.
  mosaic: standard({ cpus: 1, memoryMb: 2048 }),
  namespace: providerSpecific(
    'Namespace resources are configured on its provider factory because its SDK does not apply CPU/memory create options; cpu-burst re-pins the factory to 1 vCPU / 2 GiB.',
    { expectedCpu: 1, expectedMemoryMb: 2048 },
  ),
  opencomputer: providerSpecific(
    'OpenComputer supports 1 GiB or 4 GiB at 1 vCPU; using its 1-GiB tier because 2 GiB is not an allowed size.',
    { expectedCpu: 1, expectedMemoryMb: 1024 },
    { cpuCount: 1, memoryMB: 1024 },
  ),
  runloop: standard({
    launch_parameters: {
      resource_size_request: 'CUSTOM_SIZE',
      custom_cpu_cores: 1,
      custom_gb_memory: 2,
    },
  }),
  sail: providerSpecific(
    'Sail supports 1 vCPU as its sm size, with 16 GiB (its smallest memory limit); it does not offer the 2-GiB standard profile.',
    { expectedCpu: 1, expectedMemoryMb: 16384 },
    { sizeClass: 'sm' },
  ),
  sandbox0: providerSpecific(
    'Sandbox0 exposes a memory setting but does not expose a benchmark-level CPU setting; CPU remains provider-controlled.',
    { expectedCpu: CPU_BURST_RESOURCE_PROFILE.cpu, expectedMemoryMb: CPU_BURST_RESOURCE_PROFILE.memoryMb },
    { memory: 2048 },
  ),
  luxor: standard({ cpuCores: 1, memoryMb: 2048 }),
  tensorlake: standard({ cpus: 1, memoryMb: 2048 }),
  vercel: providerSpecific(
    'Vercel requests 1 vCPU, but its sandbox API does not expose a memory setting here.',
    { expectedCpu: 1 },
    { resources: { vcpus: 1 } },
  ),
};

function getCpuBurstResourceSpec(
  providerName: string,
  baseOptions?: Record<string, any>,
): CpuBurstResourceSpec {
  const resourceOpts = CPU_BURST_RESOURCE_OPTIONS[providerName];
  if (!resourceOpts) {
    return {
      status: 'provider-default',
      note: 'No benchmark-level CPU/memory override; provider defaults are used.',
      // Keep the normalized one-CPU reference so default providers do not
      // change worker counts merely because their actual nproc is larger.
      // This does not claim that the provider allocated exactly one CPU.
      expectedCpu: CPU_BURST_RESOURCE_PROFILE.cpu,
      sandboxOptions: baseOptions ?? {},
    };
  }

  const merged = { ...baseOptions, ...resourceOpts.sandboxOptions };
  // Drop base options that pin DAX-sized resources (e.g. daytona's 8-vCPU
  // snapshot) so cpu-burst's standard profile is not overridden by them.
  for (const key of resourceOpts.removeOptions ?? []) {
    delete merged[key];
  }

  return {
    status: resourceOpts.status,
    note: resourceOpts.note,
    expectedCpu: resourceOpts.expectedCpu,
    expectedMemoryMb: resourceOpts.expectedMemoryMb,
    // Preserve provider-specific settings such as images and hard TTLs.
    sandboxOptions: merged,
  };
}

const participants = providers.map((p) =>
  p.name === 'namespace' ? withCpuBurstNamespaceFactory(p) : p,
);

const config = defineBenchmarkConfig({
  benchmarkSlug: process.env.BENCHMARK_SLUG || 'sandbox-cpu-burst',
  benchmarkName: process.env.BENCHMARK_NAME || 'Sandbox CPU Burst',
  iterations: 5,
  concurrency: 1,
  groupBy: 'round',
  participants,
  scoring: continuousScoring({
    metrics: [
      {
        key: 'cpuBurstScore',
        unit: '/100',
        ceiling: 100,
        higherIsBetter: true,
        weights: { median: 1, p95: 0, p99: 0 },
      },
      // Retain uncapped raw headroom in platform summaries for candidate
      // evaluation. This diagnostic contributes no v1 score weight.
      {
        key: 'burstHeadroom',
        unit: SUITE_CONFIG.unit,
        ceiling: SUITE_CONFIG.ceiling,
        higherIsBetter: true,
        weights: { median: 0, p95: 0, p99: 0 },
      },
    ],
  }),
  display: {
    metrics: [
      {
        key: 'cpuBurstScore',
        label: 'Score',
        unit: '/100',
        decimals: 1,
        direction: 'higher-better',
        order: 0,
      },
      {
        key: 'burstHeadroom',
        label: 'Burst headroom',
        unit: SUITE_CONFIG.unit,
        decimals: 2,
        direction: 'higher-better',
        order: 1,
      },
      { key: 'effectiveCores', label: 'Effective cores', decimals: 2, direction: 'higher-better', order: 2 },
      { key: 'burstOpsPerSec', label: 'Burst throughput', unit: 'ops/s', decimals: 2, direction: 'higher-better', order: 3 },
      { key: 'baselineOpsPerSec', label: 'Baseline throughput', unit: 'ops/s', decimals: 2, direction: 'higher-better', order: 4 },
      { key: 'numWorkers', label: 'Worker threads', decimals: 0, direction: 'higher-better', order: 5 },
    ],
    steps: [
      { key: 'create', label: 'Create', order: 1 },
      { key: 'burst', label: 'Burst', order: 2 },
      { key: 'destroy', label: 'Destroy', order: 3 },
    ],
    overview: { defaultMetric: 'burstHeadroom' },
  },
  onComplete: async (outcome) => {
    await writeCpuBurstLegacyResults(outcome.participants, {
      // Repo-root results tree (the collect job merges artifacts from
      // `results/` and commits back to it); __dirname is benchmarks/stealth/sandbox.
      resultsDir: benchmarkResultsDir('sandbox_cpu_burst'),
    });

    const results = recordsToCpuBurstResults(outcome.participants);
    printResultsTable(results);
  },
});

// @benchsdk/runner@0.3.0 validates the older display shape before the
// platform's iterations defaults were added. Inject the new manifest section
// after that validation so it is serialized by the runner's existing
// `config.display` upload path.
type IterationDisplayConfig = NonNullable<typeof config.display> & {
  iterations: { defaultMetric: string };
};

if (config.display) {
  (config.display as IterationDisplayConfig).iterations = {
    defaultMetric: 'burstHeadroom',
  };
}

export { config };

export const task = defineTask<ProviderConfig>(async (ctx) => {
  const { participant, log, step, measure } = ctx;
  const p = participant;

  const resource = getCpuBurstResourceSpec(p.name, p.sandboxOptions);
  const resourceMeta = {
    resourceProfile: CPU_BURST_RESOURCE_PROFILE.label,
    resourceStatus: resource.status,
    resourceNote: resource.note,
  };
  measure(resourceMeta);
  log('cpu-burst resource profile', {
    level: 'info',
    meta: { provider: p.name, ...resourceMeta },
  });

  const compute = p.createCompute();
  const createTimeout = p.timeout ?? createTimeoutMs;
  const cleanupTimeout = p.destroyTimeoutMs ?? destroyTimeoutMs;

  let sandbox: CpuBurstSandbox | undefined;
  let workload: CpuBurstWorkloadResult | undefined;
  let createMs = 0;
  let destroyMs = 0;
  const rStart = performance.now();

  try {
    const createStart = performance.now();
    sandbox = await step('create', () =>
      withTimeout(
        compute.sandbox.create(resource.sandboxOptions),
        createTimeout,
        'Sandbox creation timed out',
        (s) => s?.destroy(),
      ),
    );
    createMs = performance.now() - createStart;
    measure({ createMs });

    workload = await step('burst', async () => {
      const result = await runCpuBurstWorkload(sandbox!, {
        providerName: p.name,
        provisionedCpu: resource.expectedCpu,
        provisionedMemoryMb: resource.expectedMemoryMb,
      });
      // The platform sources its per-metric views from each step's data, so the
      // burst metrics have to be measured inside the step. A `measure` call at
      // task top-level lands on the task record instead and stays invisible there.
      if (result.ok) {
        measure({
          burstHeadroom: result.metric.value,
          cpuBurstScore: cpuBurstScore(result.metric.value, SUITE_CONFIG),
          effectiveCores: result.meta?.effectiveCores ?? 0,
          burstOpsPerSec: result.meta?.burstOpsPerSec ?? 0,
          baselineOpsPerSec: result.meta?.baselineOpsPerSec ?? 0,
          numWorkers: result.meta?.numWorkers ?? 0,
          burstDetected: result.meta?.burstDetected ?? false,
        });
      }
      return result;
    });
  } catch (err) {
    const message = formatError(err);
    // The runner records a thrown task error on the task record but writes
    // nothing to the worker log, so without this the platform's log panel shows
    // step lines and no reason the task died.
    log('cpu-burst task failed', {
      level: 'error',
      meta: {
        provider: p.name,
        phase: sandbox ? 'burst' : 'create',
        error: message,
      },
    });
    const failedWallClockMs = performance.now() - rStart;
    // A plain thrown error records no iteration in the results JSON — the
    // failure reason survives only in logs and the leg reads "0/0 OK". Wrap it
    // like the workload-failure path below so results consumers see the cause.
    throw new TaskError(message, {
      code: err instanceof TaskError && err.code ? err.code : 'cpu_burst_task_failed',
      steps: err instanceof TaskError ? err.steps : undefined,
      data: {
        ok: false,
        suite: SUITE_CONFIG.id,
        reason: classifyError(message),
        error: message,
        phase: sandbox ? 'burst' : 'create',
        ...resourceMeta,
        createMs,
        replicateMs: [failedWallClockMs],
        wallClockMs: failedWallClockMs,
        meta: resourceMeta,
      } as JsonObject,
    });
  } finally {
    if (sandbox) {
      const destroyStart = performance.now();
      await step(
        'destroy',
        () => withTimeout(sandbox!.destroy(), cleanupTimeout, 'Destroy timeout'),
        { reportConcurrency: false },
      ).catch((err: unknown) =>
        log('destroy failed', { level: 'warn', meta: { error: formatError(err) } }),
      );
      destroyMs = performance.now() - destroyStart;
      measure({ destroyMs });
    }
  }

  const wallClockMs = performance.now() - rStart;

  if (!workload || !workload.ok) {
    const message = workload?.error ?? 'cpu-burst workload failed';
    log('cpu-burst workload failed', {
      level: 'error',
      meta: {
        provider: p.name,
        reason: workload && !workload.ok ? workload.reason : 'unexpected',
        error: message,
        createMs,
        destroyMs,
      },
    });
    const data = workload
      ? ({
          ...workload,
          ...resourceMeta,
          createMs,
          destroyMs,
          replicateMs: [wallClockMs],
          wallClockMs,
          meta: { ...workload.meta, ...resourceMeta },
        } as unknown as JsonObject)
      : ({
          error: message,
          ...resourceMeta,
          createMs,
          destroyMs,
          replicateMs: [wallClockMs],
          wallClockMs,
        } as JsonObject);
    throw new TaskError(message, { code: 'cpu_burst_workload_failed', data });
  }

  // Task-level copy: `scoring` samples metrics from the task record's data, so
  // burstHeadroom has to exist here too, alongside the step-scoped measure above.
  measure({
    ...resourceMeta,
    burstHeadroom: workload.metric.value,
    cpuBurstScore: cpuBurstScore(workload.metric.value, SUITE_CONFIG),
    effectiveCores: workload.meta?.effectiveCores ?? 0,
    baselineOpsPerSec: workload.meta?.baselineOpsPerSec ?? 0,
    burstOpsPerSec: workload.meta?.burstOpsPerSec ?? 0,
    burstMs: workload.meta?.burstMs ?? 0,
    burstDetected: workload.meta?.burstDetected ?? false,
  });

  log('cpu-burst workload completed', {
    level: 'info',
    meta: { provider: p.name, burstHeadroom: workload.metric.value, burstDetected: workload.meta?.burstDetected ?? false, createMs, destroyMs },
  });

  return {
    data: {
      ...workload,
      ...resourceMeta,
      burstHeadroom: workload.metric.value,
      cpuBurstScore: cpuBurstScore(workload.metric.value, SUITE_CONFIG),
      createMs,
      destroyMs,
      replicateMs: [wallClockMs],
      wallClockMs,
      meta: { ...workload.meta, ...resourceMeta, createMs, destroyMs },
    } as unknown as JsonObject,
  };
});

export const beforeExit = () => drainLateCleanups();
