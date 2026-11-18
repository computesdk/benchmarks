/**
 * OCI Boot TTI: time from sandbox.create() to the first command succeeding
 * inside the same fixed OCI image (ubuntu:24.04), per provider. Timed
 * boundary: create start → `cat /etc/os-release` exit 0 with matching output.
 * Destroy is excluded from the headline metric.
 *
 * Providers participate in one of two mechanisms, recorded per record and
 * broken out by scoring.groupBy:
 *   image    — create() takes the OCI ref directly
 *   template — create() takes an artifact materialized FROM the image
 *              (e2b template, runloop blueprint, …) by
 *              benchmarks/stealth/sandbox/oci-tti-materialize.ts
 *
 *   bench run benchmarks/stealth/sandbox/oci-tti.bench.ts
 *   bench run benchmarks/stealth/sandbox/oci-tti.bench.ts --provider e2b --iterations 3
 */
import { benchmarkResultsDir } from '../src/util/results.js';
import { continuousScoring } from './performance-runtime-scoring.js';
import {
  type BenchmarkScoringConfig,
  defineBenchmarkConfig,
  defineTask,
  TaskError,
} from '@benchsdk/runner';
import { providers } from './providers.js';
import type { ProviderConfig } from './types.js';
import {
  loadArtifacts,
  markerVerified,
  MARKER_COMMAND,
  recordContext,
  REFERENCE_IMAGE,
  ociUnsupportedReason,
  resolveOciParticipants,
} from './oci-tti.js';
import { TTI_CEILING_MS, writeOciTtiLegacyResults } from './oci-tti-legacy-results.js';
import { formatError } from '../src/util/error.js';
import { drainLateCleanups, withTimeout } from '../src/util/timeout.js';


const createTimeoutMs = 120_000;
const commandTimeoutMs = 30_000;
const destroyTimeoutMs = 15_000;

const artifacts = loadArtifacts();
const ociProviders = resolveOciParticipants(providers, artifacts);

interface OciSandbox {
  sandboxId: string;
  runCommand(command: string): Promise<{ exitCode: number; stdout?: string; stderr?: string }>;
  destroy(): Promise<unknown>;
}

interface Compute {
  sandbox: {
    create(options?: Record<string, any>): Promise<OciSandbox>;
  };
}

const scoring = continuousScoring({
  // Each record carries `mechanism` (image|template): the breakout rows
  // split raw OCI-on-create providers from materialized-artifact ones.
  groupBy: 'mechanism',
  metrics: [
    { key: 'ttiMs', label: 'TTI', unit: 'ms', ceiling: TTI_CEILING_MS, weights: { median: 0.6, p95: 0.25, p99: 0.15 } },
    { key: 'createMs', label: 'Create', unit: 'ms', ceiling: 60_000, weights: { median: 0, p95: 0, p99: 0 } },
    { key: 'markerMs', label: 'Marker exec', unit: 'ms', ceiling: 30_000, weights: { median: 0, p95: 0, p99: 0 } },
    { key: 'destroyMs', label: 'Destroy', unit: 'ms', ceiling: destroyTimeoutMs, weights: { median: 0, p95: 0, p99: 0 } },
    // Static context from the artifact registry — displayed, never scored.
    { key: 'materializeMs', label: 'Materialize', unit: 'ms', ceiling: 3_600_000, weights: { median: 0, p95: 0, p99: 0 } },
  ],
  success: {
    requireData: { verified: true },
  },
} satisfies BenchmarkScoringConfig, { ttiMs: TTI_CEILING_MS });

export const config = defineBenchmarkConfig({
  benchmarkSlug: process.env.BENCHMARK_SLUG ?? 'oci-tti',
  benchmarkName: process.env.BENCHMARK_NAME ?? 'OCI Boot TTI',
  iterations: 5,
  concurrency: 1,
  // Round-interleave participants so back-to-back iterations compare fairly.
  groupBy: 'round',
  participants: ociProviders,
  dimensions: {
    image: REFERENCE_IMAGE,
  },
  scoring,
  display: {
    metrics: [
      { key: 'ttiMs', label: 'TTI', unit: 'ms', direction: 'lower-better' as const, decimals: 0 },
      { key: 'createMs', label: 'Create', unit: 'ms', direction: 'lower-better' as const, decimals: 0 },
      { key: 'markerMs', label: 'Marker exec', unit: 'ms', direction: 'lower-better' as const, decimals: 0 },
      { key: 'materializeMs', label: 'Materialize', unit: 'ms', direction: 'lower-better' as const, decimals: 0 },
      { key: 'destroyMs', label: 'Destroy', unit: 'ms', direction: 'lower-better' as const, decimals: 0 },
    ],
    steps: [
      { key: 'create', label: 'Create sandbox' },
      { key: 'marker', label: 'Run marker command' },
      { key: 'destroy', label: 'Destroy sandbox' },
    ],
    overview: { defaultMetric: 'compositeScore', defaultLayout: 'ranking' as const },
  },
  onComplete: (outcome) =>
    writeOciTtiLegacyResults(outcome, {
      resultsDir: benchmarkResultsDir('oci_tti'),
      scoring,
      metricKeys: ['ttiMs', 'createMs', 'markerMs', 'materializeMs', 'destroyMs'],
    }),
});

export const task = defineTask<ProviderConfig>(async (ctx) => {
  const { participant, log, step, measure } = ctx;
  const p = participant;

  const unsupported = ociUnsupportedReason(p.name, artifacts);
  if (unsupported) {
    throw new TaskError(unsupported, {
      code: 'oci_tti_unsupported',
      data: { ...recordContext(p.name, artifacts), reference_image: REFERENCE_IMAGE, verified: false },
    });
  }

  const compute = p.createCompute() as Compute;
  const createTimeout = p.timeout ?? createTimeoutMs;
  const cleanupTimeout = p.destroyTimeoutMs ?? destroyTimeoutMs;

  const context = recordContext(p.name, artifacts);
  measure({ ...context, reference_image: REFERENCE_IMAGE });

  const createStart = performance.now();
  let sandbox: OciSandbox | undefined;
  let createMs = 0;
  let markerMs = 0;
  let destroyMs = 0;
  let verified = false;

  try {
    sandbox = await step('create', () =>
      withTimeout(
        compute.sandbox.create(p.sandboxOptions),
        createTimeout,
        'Sandbox creation timed out',
        (s) => s.destroy(),
      ),
    );
    if (sandbox === undefined) {
      throw new TaskError('create step did not return a sandbox', { code: 'oci_tti_no_sandbox' });
    }
    createMs = performance.now() - createStart;
    measure({ createMs });
    log('sandbox created', { meta: { sandboxId: sandbox.sandboxId, createMs } });

    const commandSandbox = sandbox;
    const markerStart = performance.now();
    const result = await step('marker', async () => {
      const r = await withTimeout(
        commandSandbox.runCommand(MARKER_COMMAND),
        commandTimeoutMs,
        'Marker command timed out',
      );
      if (r.exitCode !== 0) {
        throw new TaskError(`Marker command exited ${r.exitCode}`, {
          code: 'oci_tti_marker_failed',
          data: { exitCode: r.exitCode, stderr: r.stderr ?? null },
        });
      }
      return r;
    });
    markerMs = performance.now() - markerStart;
    verified = markerVerified(result.stdout ?? '');
    measure({ markerMs, verified });
    if (!verified) {
      throw new TaskError('marker output did not match the reference image', {
        code: 'oci_tti_verify_failed',
        data: { imageRef: context.image_ref, stdout: result.stdout ?? null },
      });
    }
    measure({ ttiMs: createMs + markerMs });
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
});

export const beforeExit = () => drainLateCleanups();
