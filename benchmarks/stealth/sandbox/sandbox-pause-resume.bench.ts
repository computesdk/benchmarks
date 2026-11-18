/**
 * Pause/resume benchmark: creates a sandbox, writes a marker file, pauses the
 * RUNNING box (timed), resumes the SAME box (timed) and verifies the marker
 * survived and the box kept its identity.
 *
 * Pause + resume is NOT create + restore (that is sandbox-snapshot's job):
 * here the stopped box itself is the resume point. computesdk's instance
 * surface has no pause()/resume(), so the bench probes the provider's own
 * mechanism in order:
 *
 *   1. A verb on the native SDK handle behind `sandbox.getInstance()`
 *      (`.pause()`, `.hibernate()`, `.suspend()`, `.stop()` — or the same
 *      verbs on a `client.sandboxes` manager the handle carries). Resume
 *      tries `.resume()`/`.start()`/`.connect()` the same way. This covers
 *      createos, e2b, daytona and vercel.
 *   2. `compute.snapshot.create(sandboxId)` where the returned id IS the
 *      sandbox id — the box-identity hibernate model (codesandbox). Resuming
 *      reattaches via `compute.sandbox.getById`/`create({ snapshotId })`,
 *      which wakes the stopped box under its original id.
 *   3. A snapshot whose id differs from the sandbox id is an inert artifact
 *      for building NEW boxes — restore-from-snapshot is sandbox-snapshot's
 *      measurement, not pause+resume. Those providers are recorded as
 *      `pauseModel: 'artifact-snapshot'` (unsupported for this bench) and
 *      their artifact is deleted in cleanup.
 *
 * Providers with neither mechanism are recorded as unsupported but still
 * contribute creation and destroy timings.
 *
 * Declarative — exports `config` + `task`; `bench run` owns the entrypoint.
 *
 * Run:
 *   pnpm bench benchmarks/stealth/sandbox/sandbox-pause-resume.bench.ts
 *   pnpm bench benchmarks/stealth/sandbox/sandbox-pause-resume.bench.ts --provider e2b --iterations 3
 */
import { benchmarkResultsDir } from '../src/util/results.js';
import '../src/env.js';
import type { JsonObject } from '@benchsdk/client';
import { defineBenchmarkConfig, defineTask, TaskError } from '@benchsdk/runner';
import { reciprocalScoring } from '../src/util/scoring.js';
import { providers } from './providers.js';
import type { ProviderConfig } from './types.js';
import { PAUSE_RESUME_CEILINGS_MS, SUITE_CONFIG, writePauseResumeLegacyResults } from './sandbox-pause-resume.js';
import { formatError } from '../src/util/error.js';
import { sandboxId } from '../src/util/sandbox-id.js';
import { drainLateCleanups, withTimeout } from '../src/util/timeout.js';
import {
  CREATE_TIMEOUT_MS,
  DESTROY_TIMEOUT_MS,
  buildExpectedFiles,
  buildRestoreOptions,
  newRunId,
  populateFilesystem,
  resolveSnapshotDir,
  withSnapshotCreateOptions,
  verifyFiles,
  type Compute,
  type FileExpectation,
  type SnapshotSandbox,
} from '../src/util/snapshot.js';


/**
 * providers.ts runs vercel with `persistent: false` to disable
 * auto-snapshot-on-stop (cheaper teardown for suites that never resume).
 * Pause + resume needs the stopped box to keep its snapshot, so this bench
 * forces persistence back on for vercel — the only per-provider override.
 */
/**
 * Other pause-only overrides put each provider in its pausable mode:
 * - upstash `ephemeral: true` boxes cannot pause.
 * - tensorlake only suspends NAMED sandboxes.
 * - miosa's default SOMA runtime has no pause; firecracker does.
 */
function pauseParticipant(p: ProviderConfig): ProviderConfig {
  const opts: Record<string, any> = { ...p.sandboxOptions };
  if (p.name === 'vercel') opts.persistent = true;
  if (p.name === 'upstash') opts.ephemeral = false;
  if (p.name === 'tensorlake') opts.name ??= `bench-pause-${newRunId()}`;
  if (p.name === 'miosa') opts.runtime = 'firecracker';
  return { ...p, sandboxOptions: opts };
}

const participants: ProviderConfig[] = providers.map(pauseParticipant);

// Probe order for the native handle behind `sandbox.getInstance()`.
// `stop` doubles as pause on persistent models (vercel auto-snapshots).
const PAUSE_VERBS = ['pause', 'hibernate', 'suspend', 'stop'] as const;
const RESUME_VERBS = ['resume', 'start'] as const;
// `connect` is a resume verb only as a last resort (e2b auto-resumes on
// connect); on other SDK objects it just opens a client session.
const CONNECT_VERB = 'connect';
// Lifecycle-committing variants (sandbox0): the call returns once the box is
// actually paused/running, so the timed step measures the real transition.
const PAUSE_AND_WAIT_VERB = 'pauseAndWait';
const RESUME_AND_WAIT_VERB = 'resumeAndWait';
const PAUSED_WAIT_VERBS = ['waitUntilPaused', 'waitForPaused'] as const;
// Async pause APIs (sandbox0, createos) return while the box is still
// running/pausing; resuming then races the transition.
const PAUSE_POLL_INTERVAL_MS = 1_000;
const PAUSE_TRANSITIONAL = /paus|stopp|suspend|hibernat|checkpoint/i;
const PAUSE_SETTLED = /^(paused|stopped|suspended|hibernated|snapshotted|frozen|sleeping|idle)$/i;

type PauseModel = 'native' | 'snapshot-box-identity' | 'artifact-snapshot' | 'none';

/** The native SDK object behind a computesdk sandbox (GeneratedInstance.getInstance()). */
function nativeHandle(sandbox: unknown): Record<string, unknown> {
  const s = sandbox as { getInstance?: () => unknown };
  const handle = typeof s.getInstance === 'function' ? s.getInstance() : s;
  const inner = (handle as { instance?: unknown })?.instance ?? handle;
  // Some adapters wrap the SDK object as `{ config, sandbox }` (tensorlake).
  // Unwrap only when the wrapper itself has no lifecycle verb — some
  // adapters keep `.sandbox` as a plain record next to their client.
  const wrapped = (inner as { sandbox?: unknown })?.sandbox;
  if (!hasLifecycleVerb(inner) && hasLifecycleVerb(wrapped)) {
    return wrapped as Record<string, unknown>;
  }
  return inner as Record<string, unknown>;
}

function hasLifecycleVerb(target: unknown): boolean {
  return [...PAUSE_VERBS, PAUSE_AND_WAIT_VERB].some((n) => verb(target, n) !== undefined);
}

/**
 * Block until an async pause has settled. Prefers the SDK's own wait verb;
 * otherwise polls `sandbox.getInfo()` while the status is transitional (and
 * briefly while it still says `running`). Providers without a status surface
 * return immediately — their pause call is treated as synchronous.
 */
async function waitForPaused(
  sandbox: SnapshotSandbox,
  native: Record<string, unknown>,
  timeoutMs: number,
): Promise<string | undefined> {
  for (const name of PAUSED_WAIT_VERBS) {
    const fn = verb(native, name);
    if (fn) {
      await fn();
      return name;
    }
  }
  const getInfo = verb(sandbox, 'getInfo');
  if (!getInfo) return undefined;
  const start = performance.now();
  let status = '';
  while (performance.now() - start < timeoutMs) {
    try {
      const info = (await getInfo()) as { status?: unknown } | undefined;
      status = typeof info?.status === 'string' ? info.status : '';
    } catch {
      // A paused box may refuse info calls; that is as settled as it gets.
      return 'getInfo-error';
    }
    if (!status || PAUSE_SETTLED.test(status)) return status || undefined;
    // Only a transitional status (pausing, stopping, ...) is waited out.
    // Many adapters' getInfo reports a static `running`, so polling on
    // `running` would just add a fixed delay to every sync pause.
    if (!PAUSE_TRANSITIONAL.test(status)) return status;
    await new Promise((r) => setTimeout(r, PAUSE_POLL_INTERVAL_MS));
  }
  throw new Error(`pause did not settle within ${timeoutMs}ms (status ${status || 'unknown'})`);
}

function verb(
  target: unknown,
  name: string,
): ((...args: unknown[]) => Promise<unknown>) | undefined {
  if (!target || typeof target !== 'object') return undefined;
  const fn = (target as Record<string, unknown>)[name];
  return typeof fn === 'function'
    ? (fn as (...args: unknown[]) => Promise<unknown>).bind(target)
    : undefined;
}

/** `client.sandboxes` manager some adapters keep on the native handle. */
function sandboxManager(native: Record<string, unknown>): unknown {
  const client = native.client as { sandboxes?: unknown } | undefined;
  return client?.sandboxes;
}

/** Idle time between pause and resume (ms); same-box latency is the default. */
function resolvePauseWaitMs(): number {
  const parsed = Number(process.env.BENCH_PAUSE_WAIT_MS);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : SUITE_CONFIG.pauseWaitMs;
}

export const config = defineBenchmarkConfig<ProviderConfig>({
  // CI mints cadence variants by exporting BENCHMARK_SLUG/BENCHMARK_NAME
  // (e.g. sandbox-pause-resume-stealth); the literals keep local runs working.
  benchmarkSlug: process.env.BENCHMARK_SLUG ?? 'sandbox-pause-resume',
  benchmarkName: process.env.BENCHMARK_NAME ?? 'Sandbox Pause Resume',
  iterations: SUITE_CONFIG.defaultIterations,
  concurrency: 1,
  groupBy: 'round',
  participants,
  scoring: reciprocalScoring({
    metrics: [
      { key: 'createMs', unit: 'ms', ceiling: PAUSE_RESUME_CEILINGS_MS.createMs, weights: { median: 0.1, p95: 0, p99: 0 } },
      { key: 'pauseMs', unit: 'ms', ceiling: PAUSE_RESUME_CEILINGS_MS.pauseMs, weights: { median: 0.35, p95: 0, p99: 0 } },
      { key: 'resumeMs', unit: 'ms', ceiling: PAUSE_RESUME_CEILINGS_MS.resumeMs, weights: { median: 0.45, p95: 0, p99: 0 } },
      { key: 'destroyMs', unit: 'ms', ceiling: PAUSE_RESUME_CEILINGS_MS.destroyMs, weights: { median: 0.1, p95: 0, p99: 0 } },
    ],
    // A provider without a verified same-box resume is not a successful
    // pause/resume run: unsupported providers (verifyPassed: false) score 0
    // and their timings stay on the record but out of the composite.
    success: {
      requireData: { verifyPassed: true },
    },
  }),
  display: {
    metrics: [
      { key: 'createMs', label: 'Create', unit: 'ms', direction: 'lower-better', decimals: 0 },
      { key: 'populateMs', label: 'Populate', unit: 'ms', direction: 'lower-better', decimals: 0 },
      { key: 'pauseMs', label: 'Pause', unit: 'ms', direction: 'lower-better', decimals: 0 },
      { key: 'resumeMs', label: 'Resume', unit: 'ms', direction: 'lower-better', decimals: 0 },
      { key: 'verifyMs', label: 'Verify', unit: 'ms', direction: 'lower-better', decimals: 0 },
      { key: 'destroyMs', label: 'Destroy', unit: 'ms', direction: 'lower-better', decimals: 0 },
      { key: 'wallClockMs', label: 'Wall clock', unit: 'ms', direction: 'lower-better', decimals: 0 },
    ],
    steps: [
      { key: 'create', label: 'Create sandbox', order: 0 },
      { key: 'populate', label: 'Populate filesystem', order: 1 },
      { key: 'pause', label: 'Pause box', order: 2 },
      { key: 'pause-wait', label: 'Pause wait', order: 3 },
      { key: 'resume', label: 'Resume box', order: 4 },
      { key: 'verify', label: 'Verify marker', order: 5 },
      { key: 'destroy-resumed', label: 'Destroy resumed box', order: 6 },
      { key: 'destroy', label: 'Destroy source', order: 7 },
      { key: 'snapshot-delete', label: 'Delete snapshot artifact', order: 8 },
    ],
    overview: { defaultMetric: 'compositeScore', defaultLayout: 'ranking' },
  },
  onComplete: (outcome): Promise<void> =>
    writePauseResumeLegacyResults(outcome.participants, {
      resultsDir: benchmarkResultsDir('sandbox_pause_resume'),
      scoring: config.scoring,
    }),
});

export const task = defineTask<ProviderConfig>(async (ctx) => {
  const { participant, log, step, measure } = ctx;
  const p = participant;

  const compute = p.createCompute() as Compute;
  const createTimeout = p.timeout ?? CREATE_TIMEOUT_MS;
  const cleanupTimeout = p.destroyTimeoutMs ?? DESTROY_TIMEOUT_MS;

  const runId = newRunId();
  const markerContent = `verify-content-${runId}`;
  const pauseWaitMs = resolvePauseWaitMs();
  let expected: FileExpectation[] = [];

  let sandbox: SnapshotSandbox | undefined;
  let resumedSandbox: SnapshotSandbox | undefined;
  let artifactSnapshotId: string | undefined;
  let createMs = 0;
  let populateMs = 0;
  let pauseMs = 0;
  let resumeMs = 0;
  let verifyMs = 0;
  let destroyMs = 0;
  let prePauseSandboxId: string | null = null;
  let postResumeSandboxId: string | null = null;
  let pauseModel: PauseModel = 'none';
  let pauseSupported = false;
  let paused = false;
  let pauseError: string | undefined;
  let pauseVia: string | undefined;
  let pausedStatus: string | undefined;
  let sameBox = false;
  let verifyPassed = false;
  const rStart = performance.now();

  try {
    const createStart = performance.now();
    sandbox = await step('create', () =>
      withTimeout(
        compute.sandbox.create(withSnapshotCreateOptions(compute, p.sandboxOptions)),
        createTimeout,
        'Sandbox creation timed out',
        (s) => s.destroy(),
      ),
    );
    createMs = performance.now() - createStart;
    measure({ createMs });

    // Marker file only — enough to prove the resumed box preserved state.
    const populateStart = performance.now();
    await step('populate', () =>
      withTimeout(
        (async () => {
          const { dir: workdir } = await resolveSnapshotDir(sandbox!, compute, createTimeout, p.snapshotWorkdir);
          const baseDir = `${workdir}/bench-pause-resume-${runId}`;
          expected = buildExpectedFiles(baseDir, 0, 0, `${baseDir}/marker.txt`, markerContent);
          await populateFilesystem(sandbox!, baseDir, expected);
          prePauseSandboxId = sandboxId(sandbox);
        })(),
        createTimeout,
        'Filesystem population timed out',
      ),
    );
    populateMs = performance.now() - populateStart;
    measure({ populateMs });

    try {
      const native = nativeHandle(sandbox);
      const manager = sandboxManager(native);
      const pauseStart = performance.now();

      // Probe the provider's pause mechanism: a shared computesdk
      // `sandbox.pause()` when the installed SDK has one, then a
      // wait-variant / plain verb on the native handle (or its
      // client.sandboxes manager), then a box-identity snapshot.
      const id = prePauseSandboxId;
      const pauseCandidates: Array<{ name: string; via: 'shared' | 'native' | 'manager'; call: () => Promise<unknown> }> = [];
      const shared = verb(sandbox, 'pause');
      if (shared && verb(sandbox, 'resume')) pauseCandidates.push({ name: 'pause', via: 'shared', call: () => shared() });
      for (const name of [PAUSE_AND_WAIT_VERB, ...PAUSE_VERBS]) {
        const fn = verb(native, name);
        if (fn) pauseCandidates.push({ name, via: 'native', call: () => fn() });
      }
      for (const name of [PAUSE_AND_WAIT_VERB, ...PAUSE_VERBS]) {
        const fn = verb(manager, name);
        if (fn && id) pauseCandidates.push({ name, via: 'manager', call: () => fn(id) });
      }
      const pauseVerb = pauseCandidates[0];

      if (pauseVerb) {
        pauseModel = 'native';
        pauseSupported = true;
        pauseVia = `${pauseVerb.via}.${pauseVerb.name}`;
        await step('pause', () =>
          withTimeout(
            (async () => {
              await pauseVerb.call();
              // pauseAndWait already committed; everything else may be async.
              if (pauseVerb.name !== PAUSE_AND_WAIT_VERB) {
                pausedStatus = await waitForPaused(sandbox!, native, createTimeout);
              }
            })(),
            createTimeout,
            'Pause timed out',
          ),
        );
        pauseMs = performance.now() - pauseStart;
        paused = true;
        measure({ pauseMs, pauseModel, pauseVia, pausedStatus: pausedStatus ?? null });
      } else if (compute.snapshot) {
        // No native pause surface — try the snapshot API. When the snapshot
        // id IS the sandbox id, the stopped box is the resume point
        // (codesandbox hibernate). A different id means an inert artifact
        // for building new boxes — create+restore, not pause+resume.
        const snapshot = await step('pause', () =>
          withTimeout(
            compute.snapshot!.create(sandbox!.sandboxId, { name: `pause-${runId}` }),
            createTimeout,
            'Pause timed out',
          ),
        );
        pauseMs = performance.now() - pauseStart;
        if (snapshot.id === sandbox!.sandboxId) {
          pauseModel = 'snapshot-box-identity';
          pauseSupported = true;
          paused = true;
        } else {
          pauseModel = 'artifact-snapshot';
          artifactSnapshotId = snapshot.id;
          log('snapshot is an inert artifact, not a paused box; skipping resume', {
            level: 'info',
          });
        }
        measure({ pauseMs, pauseModel });
      } else {
        pauseModel = 'none';
        measure({ pauseModel });
        log('pause not supported by provider', { level: 'info' });
      }

      if (paused) {
        // Optional idle wait between pause and resume — same-box latency is
        // the headline, so the default is 0.
        if (pauseWaitMs > 0) {
          await step(
            'pause-wait',
            () => new Promise<void>((resolve) => setTimeout(resolve, pauseWaitMs)),
            { reportConcurrency: false },
          );
        }

        const resumeStart = performance.now();
        resumedSandbox = await step('resume', () =>
          withTimeout(
            (async () => {
              let resumed: SnapshotSandbox | undefined;

              if (pauseVia === 'shared.pause') {
                await verb(sandbox, 'resume')!();
                resumed = sandbox;
              }
              if (!resumed && pauseVia?.endsWith(PAUSE_AND_WAIT_VERB)) {
                const fn = pauseVia.startsWith('manager')
                  ? verb(manager, RESUME_AND_WAIT_VERB)
                  : verb(native, RESUME_AND_WAIT_VERB);
                if (fn) {
                  await (pauseVia.startsWith('manager') ? fn(prePauseSandboxId) : fn());
                  resumed = sandbox;
                }
              }
              if (!resumed && pauseModel === 'native') {
                // Pair the verb that paused the box: resume/start on the same
                // handle (instance methods take no args), then on its
                // client.sandboxes manager (manager methods take the id).
                for (const name of RESUME_VERBS) {
                  const fn = verb(native, name);
                  if (!fn) continue;
                  await fn();
                  resumed = sandbox;
                  break;
                }
                if (!resumed) {
                  for (const name of RESUME_VERBS) {
                    const fn = verb(manager, name);
                    if (!fn || !prePauseSandboxId) continue;
                    await fn(prePauseSandboxId);
                    resumed = sandbox;
                    break;
                  }
                }
                // Attach path — some SDKs resume lazily on reattach (vercel
                // Sandbox.get auto-resumes the persistent snapshot).
                if (!resumed && compute.sandbox.getById && prePauseSandboxId) {
                  resumed =
                    (await compute.sandbox.getById(prePauseSandboxId)) ?? undefined;
                }
                if (!resumed) {
                  const fn = verb(native, CONNECT_VERB);
                  if (fn) {
                    const connected = await fn();
                    resumed = (connected as SnapshotSandbox) ?? sandbox;
                  }
                }
                if (!resumed && prePauseSandboxId) {
                  const fn = verb(manager, CONNECT_VERB);
                  if (fn) {
                    const connected = await fn(prePauseSandboxId);
                    resumed = (connected as SnapshotSandbox) ?? sandbox;
                  }
                }
              } else if (!resumed) {
                // pauseModel === 'snapshot-box-identity': the stopped box is
                // the restore point; reattaching wakes it under its own id.
                if (compute.sandbox.getById && prePauseSandboxId) {
                  resumed =
                    (await compute.sandbox.getById(prePauseSandboxId)) ?? undefined;
                }
                if (!resumed && prePauseSandboxId) {
                  resumed = await compute.sandbox.create(
                    buildRestoreOptions(p.sandboxOptions, prePauseSandboxId),
                  );
                }
              }

              if (!resumed) {
                throw new Error('no resume path succeeded');
              }

              // A first command forces lazy resumes to complete inside the
              // timed step and proves the box accepts work again.
              await (verb(native, 'waitUntilRunning')?.() ?? Promise.resolve());
              const ready = await resumed.runCommand('true', { timeout: createTimeout });
              if (ready.exitCode !== 0) {
                throw new Error(`resumed box not ready (exit ${ready.exitCode})`);
              }
              return resumed;
            })(),
            createTimeout,
            'Resume timed out',
          ),
        );
        resumeMs = performance.now() - resumeStart;
        postResumeSandboxId = sandboxId(resumedSandbox);
        sameBox = postResumeSandboxId !== null && postResumeSandboxId === prePauseSandboxId;
        measure({ resumeMs, sameBox, prePauseSandboxId, postResumeSandboxId });

        const verifyStart = performance.now();
        const verification = await step('verify', () =>
          withTimeout(
            verifyFiles(resumedSandbox!, expected),
            createTimeout,
            'Verify timed out',
          ),
        );
        verifyMs = performance.now() - verifyStart;
        verifyPassed = verification.allMatched && sameBox;
        measure({ verifyMs, verifyPassed });

        if (!verifyPassed) {
          throw new Error(
            sameBox
              ? 'Pause/resume verification failed: marker file did not survive resume'
              : `Pause/resume did not return the same box (${prePauseSandboxId} -> ${postResumeSandboxId})`,
          );
        }
      }
    } catch (err) {
      pauseError = formatError(err);
      log('pause/resume lifecycle failed', { level: 'warn', meta: { error: pauseError } });
    }
  } finally {
    if (resumedSandbox && resumedSandbox !== sandbox) {
      const destroyStart = performance.now();
      await step(
        'destroy-resumed',
        () => withTimeout(resumedSandbox!.destroy(), cleanupTimeout, 'Destroy resumed timeout'),
        { reportConcurrency: false },
      ).catch((err: unknown) =>
        log('destroy resumed failed', { level: 'warn', meta: { error: formatError(err) } }),
      );
      destroyMs = performance.now() - destroyStart;
      measure({ destroyMs });
    }

    // Never snapshot.delete a box-identity "snapshot" — that deletes the
    // paused box itself. Same-box teardown goes through sandbox.destroy().
    if (sandbox) {
      const destroyStart = performance.now();
      await step(
        'destroy',
        () => withTimeout(sandbox!.destroy(), cleanupTimeout, 'Destroy timeout'),
        { reportConcurrency: false },
      ).catch((err: unknown) =>
        log('destroy failed', { level: 'warn', meta: { error: formatError(err) } }),
      );
      if (destroyMs === 0) {
        destroyMs = performance.now() - destroyStart;
        measure({ destroyMs });
      }
    }

    // Only genuinely inert snapshot artifacts are deleted here.
    if (artifactSnapshotId && compute.snapshot) {
      await step(
        'snapshot-delete',
        () =>
          withTimeout(compute.snapshot!.delete(artifactSnapshotId!), cleanupTimeout, 'Snapshot delete timeout'),
        { reportConcurrency: false },
      ).catch((err: unknown) =>
        log('snapshot delete failed', { level: 'warn', meta: { error: formatError(err) } }),
      );
    }
  }

  const wallClockMs = performance.now() - rStart;

  const baseMeta = {
    createMs,
    populateMs,
    pauseMs,
    pauseWaitMs,
    resumeMs,
    verifyMs,
    destroyMs,
    pauseSupported,
    pauseModel,
    pauseVia: pauseVia ?? null,
    sameBox,
    verifyPassed,
    prePauseSandboxId,
    postResumeSandboxId,
    wallClockMs,
  };

  if (pauseSupported && pauseError) {
    const data = {
      ...baseMeta,
      pauseError,
      replicateMs: [wallClockMs],
    } as unknown as JsonObject;
    throw new TaskError('pause/resume workload failed: ' + pauseError, {
      code: 'pause_resume_workload_failed',
      data,
    });
  }

  measure({ wallClockMs });

  const meta: JsonObject = Object.fromEntries(
    Object.entries({
      provider: p.name,
      ...baseMeta,
      pauseError: pauseError ?? null,
    }).filter(([, v]) => v !== undefined),
  ) as JsonObject;

  log('pause/resume workload completed', {
    level: 'info',
    meta,
  });

  return {
    data: { ...meta, replicateMs: [wallClockMs] } as unknown as JsonObject,
    latencyMs: pauseSupported ? resumeMs || pauseMs : populateMs,
  };
});

export const beforeExit = () => drainLateCleanups();
