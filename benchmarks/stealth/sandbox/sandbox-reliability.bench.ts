import '../src/env.js';
import { arch, hostname, platform as osPlatform, release } from 'node:os';
import {
  defineBenchmarkConfig,
  defineTask,
  TaskError,
} from '@benchsdk/runner';
import { providers } from './sandbox-reliability.providers.js';
import type { ProviderConfig } from './types.js';
import { drainLateCleanups, trackLateCleanup, withTimeout } from '../src/util/timeout.js';
import { sandboxId } from '../src/util/sandbox-id.js';

// The Sandbox Reliability benchmark — a copy of the per-minute canary from
// computesdk/benchmarks-actions-reliability, run per minute on ComputeSDK
// Actions via .computesdk/workflows/sandbox-reliability.yml. One iteration =
// the smallest real sandbox lifecycle:
//   create → probe → destroy.
//
// Each scheduled fire runs one probe per keyed provider through that
// provider's own ComputeSDK adapter — the identical create path the TTI/DAX
// benchmarks use — executes a small write/hash/verify/cleanup probe inside
// it, and destroys it. The platform's per-(participant, slot) rollup turns
// each fire into a per-provider status row for that slot.
//
// Attribution rules:
//   - Provider failure (adapter create error, timeout, probe exit != 0) →
//     that provider's slot fails; every other provider is unaffected.
//   - Driver failure (the workflow run never places or dies mid-run) → no
//     benchmark run exists for the slot, which reads as a scheduler/our
//     failure — never as provider failures.
//   - A provider with missing credentials is filtered out by
//     requiredEnvVars before the run starts — it reports nothing rather
//     than failing.
//
//   pnpm bench benchmarks/stealth/sandbox/sandbox-reliability.bench.ts --provider e2b

// The measured set: the SDK sandbox roster minus `manualOnly` entries —
// dispatch-only providers never run on a schedule. Everything else is
// probed each slot that its credentials are present.
const participants = providers.filter((p) => !p.manualOnly);

// A small, real unit of work inside the measured sandbox: write 1 MiB, hash
// it twice, require identical digests, clean up. Any step failing exits
// non-zero and fails the probe. Echoes the digest so the timeline shows the
// work really happened.
const PROBE_COMMAND = [
  'set -e',
  'f=/tmp/reliability-payload',
  'head -c 1048576 /dev/urandom > "$f"',
  'a=$(sha256sum "$f" | cut -d" " -f1)',
  'b=$(sha256sum "$f" | cut -d" " -f1)',
  '[ "$a" = "$b" ]',
  'rm -f "$f"',
  'echo "RELIABILITY_OK hash=$a"',
].join(' && ');

const CREATE_TIMEOUT_MS = 60_000;
const PROBE_COMMAND_TIMEOUT_MS = 30_000;
const DESTROY_TIMEOUT_MS = 30_000;

interface ReliabilitySandbox {
  runCommand(command: string, options: { timeout: number }): Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
    durationMs: number;
  }>;
  destroy(): Promise<unknown>;
}

export async function beforeExit(): Promise<void> {
  await drainLateCleanups();
}

export const config = defineBenchmarkConfig<ProviderConfig>({
  benchmarkSlug: process.env.BENCHMARK_SLUG ?? 'sandbox-reliability',
  benchmarkName: process.env.BENCHMARK_NAME ?? 'Sandbox Reliability',
  type: 'reliability',
  reliability: {
    // `interval` is the cadence the platform's slot grid computes uptime
    // against.
    interval: '1m',
    // Run creation lands ~60–120s after the tick: placement + clone + install.
    graceMs: 180_000,
    target: { uptime: 0.99 },
    layout: 'series',
    sections: [
      { type: 'uptime' },
      { type: 'slot-grid' },
      { type: 'metric', metric: 'createMs' },
      { type: 'metric', metric: 'workloadMs' },
      { type: 'breakdown', by: 'provider' },
      { type: 'incidents' },
    ],
    feedCard: { strip: '24h', stat: 'uptime' },
  },
  iterations: 1,
  // 'round' + one iteration fans every participant's single probe out in
  // parallel, all inside the same slot.
  groupBy: 'round',
  concurrency: participants.length,
  participants,
  display: {
    metrics: [
      { key: 'createMs', label: 'Create', unit: 'ms', direction: 'lower-better' },
      { key: 'workloadMs', label: 'Workload', unit: 'ms', direction: 'lower-better' },
    ],
    overview: { defaultMetric: 'createMs' },
    steps: [
      { key: 'create', label: 'Create sandbox' },
      { key: 'probe', label: 'Probe' },
      { key: 'destroy', label: 'Destroy' },
    ],
  },
  scoring: {
    metrics: [
      // Weights across all metrics must total 1.0 — create time is the
      // measured surface, workload time is the sanity check inside it.
      { key: 'createMs', ceiling: 60_000, weights: { median: 0.5, p95: 0.15, p99: 0.05 } },
      { key: 'workloadMs', ceiling: 10_000, weights: { median: 0.2, p95: 0.07, p99: 0.03 } },
    ],
  },
});

function identity() {
  return {
    ciRunId: process.env.COMPUTESDK_RUN_ID ?? process.env.GITHUB_RUN_ID ?? null,
    scheduledFor: process.env.COMPUTESDK_SCHEDULED_FOR ?? null,
    host: hostname(),
    runnerPlatform: `${osPlatform()}/${arch()}`,
    kernel: release(),
    nodeVersion: process.version,
  };
}

export const task = defineTask<ProviderConfig>(async ({ participant, taskIndex, step, measure, log }) => {
  const who = identity();
  log(
    `RELIABILITY_OK ts=${new Date().toISOString()} participant=${participant.name} ` +
      `ciRun=${who.ciRunId ?? 'unknown'} slot=${who.scheduledFor ?? 'unknown'}`,
  );

  const compute = participant.createCompute();
  const createStarted = performance.now();
  let pendingCreate: Promise<ReliabilitySandbox> | undefined;
  let sandbox: ReliabilitySandbox | undefined;
  let createMs = 0;
  let workloadMs = 0;
  let probeStdout = '';
  let failed = false;
  const destroyTimeoutMs = (participant.destroyTimeoutMs ?? DESTROY_TIMEOUT_MS) + 5_000;
  const destroy = (s: ReliabilitySandbox) => withTimeout(s.destroy(), destroyTimeoutMs, 'Destroy timeout');
  const cleanupMeta = (s: ReliabilitySandbox) => ({ provider: participant.name, sandboxId: sandboxId(s) });
  try {
    sandbox = await step(
      'create',
      () => {
        pendingCreate = Promise.resolve(compute.sandbox.create(participant.sandboxOptions));
        return pendingCreate;
      },
      { timeoutMs: participant.timeout ?? CREATE_TIMEOUT_MS },
    );
    createMs = Math.round(performance.now() - createStarted);
    const active = sandbox;
    log('sandbox created', { meta: cleanupMeta(active) });
    const probe = await step(
      'probe',
      () => active.runCommand(PROBE_COMMAND, { timeout: PROBE_COMMAND_TIMEOUT_MS }),
      { timeoutMs: PROBE_COMMAND_TIMEOUT_MS + 10_000 },
    );
    workloadMs = probe.durationMs;
    probeStdout = probe.stdout.trim();
    if (probe.exitCode !== 0) {
      throw new TaskError('probe exited non-zero', {
        code: 'probe_failed',
        data: { exitCode: probe.exitCode, stderr: probe.stderr.trim().slice(0, 500) },
      });
    }
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    if (sandbox) {
      const owned = sandbox;
      try {
        await step('destroy', () => destroy(owned), { timeoutMs: destroyTimeoutMs });
        log('sandbox destroy completed', { meta: cleanupMeta(owned) });
      } catch (error) {
        const destroyError = error instanceof Error ? error.message : String(error);
        log(`destroy failed: ${destroyError}`, { level: 'warn', meta: cleanupMeta(owned) });
        if (!failed) {
          throw new TaskError('Sandbox cleanup failed', { code: 'cleanup_failed', data: { ...cleanupMeta(owned), destroyError } });
        }
      }
    } else if (pendingCreate) {
      const pending = pendingCreate;
      trackLateCleanup(() => pending.then(async (late) => {
        log('destroying late sandbox', { level: 'warn', meta: cleanupMeta(late) });
        try {
          await destroy(late);
          log('late sandbox destroy completed', { meta: cleanupMeta(late) });
        } catch (error) {
          log(`late sandbox destroy failed: ${error instanceof Error ? error.message : String(error)}`, { level: 'warn', meta: cleanupMeta(late) });
          throw error;
        }
      }, (error: unknown) => {
        log(`late create rejected: ${error instanceof Error ? error.message : String(error)}`, { level: 'warn', meta: { provider: participant.name } });
      }));
    }
  }

  log(
    `RELIABILITY_DONE task=${taskIndex} participant=${participant.name} ` +
      `createMs=${createMs} workloadMs=${workloadMs} out=${probeStdout}`,
  );

  measure({ createMs, workloadMs });
  return {
    data: {
      provider: participant.name,
      createMs,
      workloadMs,
      ...who,
    },
  };
});
