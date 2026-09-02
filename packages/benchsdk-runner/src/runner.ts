/**
 * CLI runner for `defineBenchmark` configs. Owns all platform orchestration
 * (upsert benchmark, create run, plan + drive workers per participant) so a
 * `*.bench.ts` file only has to declare its config and task. The orchestration
 * knobs (iterations / concurrency / staggerDelayMs / groupBy) can be overridden
 * per-invocation via CLI flags.
 *
 * Two execution orderings, chosen by `groupBy`:
 *   'participant' (default) — each participant's tasks run to completion via
 *     `runWorker(client, ...)` (with its pooled concurrency + heartbeat reporting)
 *     before the next participant starts.
 *   'round' — participants take turns: every participant runs its Nth task
 *     before anyone starts their (N+1)th, so all Nth tasks happen back-to-back
 *     under the same conditions. Driven manually via one `BenchmarkReporter`
 *     per participant.
 */
import { execSync } from 'node:child_process';
import os from 'node:os';
import { createBenchmarkClient } from '@benchsdk/api';
import { resolveAuth } from '@benchsdk/cli';
import {
  BenchmarkReporter,
  createSystemMetricsCollector,
  filterParticipantsByEnv,
  runWorker,
  selectParticipants,
} from '@benchsdk/worker';
import type { BenchmarkSystemMetricsCollector, BenchmarkSystemMetricsSample } from '@benchsdk/worker';
import { NoAvailableParticipantsError } from './no-available-participants.js';
import { higherIsBetter, lowerIsBetter, score, ScoringSpecError, scoringConfigToSpec } from './scoring.js';
import type {
  BenchmarkClient,
  BenchmarkLogOptions,
  BenchmarkStepOutcome,
  DefineStepOptions,
  JsonObject,
  RunWorkerContext,
  TaskResultRecord,
  TaskStepRecord,
} from '@benchsdk/api';
import type { BaseParticipant } from '@benchsdk/worker';
import { TaskError } from './bench-config.js';
import type {
  BenchmarkConfig,
  BenchmarkRunOutcome,
  BenchmarkShape,
  BenchmarkTask,
  GroupBy,
  ParticipantRecords,
  ResolvedRunConfig,
  TaskContext,
  TaskResult,
  TaskStepOptions,
} from './bench-config.js';
import { LogBuffer } from './log-buffer.js';

export interface CliArgs {
  /** Which platform benchmark to report as (`--benchmark`, aka the benchmark slug). */
  benchmark?: string;
  name?: string;
  /** Named variant from the bench file's `shapes` (`--shape`), swapping in its identity. */
  shape?: string;
  /**
   * Idempotency key (`--run-key`): sibling processes passing the same key share
   * one run (get-or-created), instead of each opening its own.
   */
  runKey?: string;
  iterations?: number;
  concurrency?: number;
  staggerDelayMs?: number;
  groupBy?: GroupBy;
  /** Participant names from `--provider a,b` (repeatable). */
  providers?: string[];
  /** When true, run locally and do not ingest/report to the platform. */
  noIngest?: boolean;
}

function isEnvNoIngest(): boolean {
  const v = process.env.BENCHSDK_NO_INGEST;
  return v === '1' || v?.toLowerCase() === 'true';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getErrorCode(error: unknown): string {
  if (error instanceof Error && 'code' in error && typeof (error as { code: unknown }).code === 'string' && (error as { code: string }).code) {
    return (error as { code: string }).code;
  }
  if (error instanceof Error && error.name) return error.name;
  return 'ERROR';
}

function isTaskError(error: unknown): error is TaskError {
  return error instanceof Error && (error instanceof TaskError || error.name === 'TaskError');
}

const STEP_OUTCOME_KEYS = new Set(['stdout', 'stderr', 'error', 'exitCode', 'code', 'signal', 'pid']);

function isStepOutcome(value: unknown): value is BenchmarkStepOutcome {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const o = value as Record<string, unknown>;
  const keys = Object.keys(o);
  if (keys.length === 0) return false;
  if (!keys.every((k) => STEP_OUTCOME_KEYS.has(k))) return false;
  return typeof o.stdout === 'string' || typeof o.stderr === 'string' || typeof o.error === 'string';
}

function withTimeout<T>(promise: Promise<T>, ms: number, name: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new TaskError(`Step "${name}" timed out after ${ms}ms`, { code: 'step_timeout' })),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function runStepInvocations<R>(
  name: string,
  fn: () => Promise<R> | R,
  options: TaskStepOptions | undefined,
): Promise<R | R[]> {
  const requestedConcurrency = options?.concurrency;
  if (requestedConcurrency !== undefined && (!Number.isInteger(requestedConcurrency) || requestedConcurrency < 1)) {
    throw new Error(`step "${name}" concurrency must be an integer >= 1 (got ${requestedConcurrency})`);
  }
  const timeoutMs = options?.timeoutMs;
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs < 0)) {
    throw new Error(`step "${name}" timeoutMs must be a number >= 0 (got ${timeoutMs})`);
  }

  const count = requestedConcurrency ?? 1;
  const invocations = Array.from({ length: count }, () => {
    const promise = Promise.resolve().then(() => fn());
    if (timeoutMs === undefined) return promise;
    return withTimeout(promise, timeoutMs, name);
  });

  if (count === 1) {
    return invocations[0];
  }

  const outcomes = await Promise.allSettled(invocations);
  const results: R[] = [];
  let firstError: unknown;
  for (const outcome of outcomes) {
    if (outcome.status === 'fulfilled') {
      results.push(outcome.value);
    } else if (firstError === undefined) {
      firstError = outcome.reason;
    }
  }
  if (firstError !== undefined) throw firstError;
  return results;
}

async function runStepWithClient<R, C extends number = 1>(
  clientStep: RunWorkerContext['step'],
  name: string,
  fn: () => Promise<R> | R,
  options?: TaskStepOptions & { concurrency?: C },
): Promise<C extends 1 ? R : R[]> {
  const { concurrency: runnerConcurrency, timeoutMs, ...clientOptions } = options ?? {};
  const clientStepOptions: DefineStepOptions = {
    ...clientOptions,
    timeoutMs,
    stepConcurrency: runnerConcurrency,
  };
  const result = await clientStep(name, () => runStepInvocations(name, fn, options), clientStepOptions);
  return result as C extends 1 ? R : R[];
}

/**
 * Parses the orchestration flags this runner understands, rejecting unknown
 * flags. Supports both `--flag value` and `--flag=value`; `--provider` accepts
 * a comma-separated list and may be repeated.
 *
 * `allowedCustomFlags` lists pass-through flags the benchmark file reads from
 * `process.argv` itself; the runner validates and skips them without choking on
 * their values.
 */
export function parseCliArgs(argv: string[], allowedCustomFlags?: readonly string[]): CliArgs {
  const args: CliArgs = {};
  const unknown: string[] = [];
  const allowed = new Set(allowedCustomFlags ?? []);

  const readValue = (raw: string, i: number): { value: string; nextIndex: number } => {
    const eq = raw.indexOf('=');
    if (eq !== -1) return { value: raw.slice(eq + 1), nextIndex: i };
    return { value: argv[i + 1] ?? '', nextIndex: i + 1 };
  };

  const intFlag = (raw: string, flag: string): number => {
    if (raw.trim() === '') throw new Error(`${flag} expects a value`);
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1) throw new Error(`${flag} expects an integer >= 1 (got "${raw}")`);
    return n;
  };

  const nonNegFlag = (raw: string, flag: string): number => {
    if (raw.trim() === '') throw new Error(`${flag} expects a value`);
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) throw new Error(`${flag} expects a number >= 0 (got "${raw}")`);
    return n;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const name = arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg;
    switch (name) {
      // `--slug` is the pre-`--benchmark` spelling, kept working for existing scripts.
      case '--slug':
      case '--benchmark': {
        const { value, nextIndex } = readValue(arg, i);
        if (!/^[a-z0-9][a-z0-9-]*$/.test(value)) {
          throw new Error(`${name} expects a lowercase benchmark slug (got "${value}")`);
        }
        args.benchmark = value;
        i = nextIndex;
        break;
      }
      case '--name': {
        const { value, nextIndex } = readValue(arg, i);
        if (value.trim() === '') throw new Error('--name expects a value');
        args.name = value;
        i = nextIndex;
        break;
      }
      case '--shape': {
        const { value, nextIndex } = readValue(arg, i);
        if (value.trim() === '') throw new Error('--shape expects a value');
        args.shape = value;
        i = nextIndex;
        break;
      }
      case '--run-key': {
        const { value, nextIndex } = readValue(arg, i);
        if (value.trim() === '') throw new Error('--run-key expects a value');
        args.runKey = value;
        i = nextIndex;
        break;
      }
      case '--iterations': {
        const { value, nextIndex } = readValue(arg, i);
        args.iterations = intFlag(value, '--iterations');
        i = nextIndex;
        break;
      }
      case '--concurrency': {
        const { value, nextIndex } = readValue(arg, i);
        args.concurrency = intFlag(value, '--concurrency');
        i = nextIndex;
        break;
      }
      case '--stagger-delay-ms': {
        const { value, nextIndex } = readValue(arg, i);
        args.staggerDelayMs = nonNegFlag(value, '--stagger-delay-ms');
        i = nextIndex;
        break;
      }
      case '--group-by': {
        const { value, nextIndex } = readValue(arg, i);
        if (value !== 'participant' && value !== 'round') {
          throw new Error(`--group-by expects 'participant' or 'round' (got "${value}")`);
        }
        args.groupBy = value;
        i = nextIndex;
        break;
      }
      case '--provider': {
        const { value, nextIndex } = readValue(arg, i);
        const names = value.split(',').map((s) => s.trim()).filter(Boolean);
        args.providers = [...(args.providers ?? []), ...names];
        i = nextIndex;
        break;
      }
      case '--no-ingest':
      case '--dry-run':
        args.noIngest = true;
        break;
      default: {
        if (allowed.has(name)) {
          // Skip the flag's value (if supplied as a separate token) so the
          // benchmark file can read it from process.argv itself.
          if (!arg.includes('=')) {
            const next = argv[i + 1];
            if (next && !next.startsWith('-')) {
              i++;
            }
          }
        } else {
          unknown.push(name);
          // Unknown flags that take a value shouldn't report the value as a
          // separate unknown flag.
          if (!arg.includes('=')) {
            const next = argv[i + 1];
            if (next && !next.startsWith('-')) {
              i++;
            }
          }
        }
        break;
      }
    }
  }

  if (unknown.length > 0) {
    throw new Error(`Unknown flag(s): ${unknown.join(', ')}`);
  }

  if (!args.noIngest && isEnvNoIngest()) {
    args.noIngest = true;
  }
  return args;
}

/** Merges CLI overrides over config defaults, filling in knob fallbacks. */
export function mergeConfig<T extends BaseParticipant>(
  config: BenchmarkConfig<T>,
  args: CliArgs,
): ResolvedRunConfig {
  // `--iterations` applies per phase: phases are the arms of one comparison, so
  // scaling them equally keeps the arms comparable, where splitting a total
  // between them would shrink each arm as arms are added. A benchmark that
  // sizes its arms differently (cold probes more than warm) meant that
  // difference, so its counts win over the flag.
  const phases = config.phases;
  const unevenPhases = phases !== undefined && phases.some((p) => p.iterations !== phases[0].iterations);
  if (unevenPhases && args.iterations !== undefined) {
    console.warn('--iterations is ignored because this benchmark sizes its phases individually.');
  }
  const phaseIterations = phases !== undefined && !unevenPhases ? args.iterations : undefined;
  const phaseTotal =
    phases !== undefined
      ? (phaseIterations !== undefined
          ? phaseIterations * phases.length
          : phases.reduce((sum, p) => sum + p.iterations, 0))
      : undefined;
  const resolved: ResolvedRunConfig = {
    iterations: phaseTotal ?? args.iterations ?? config.iterations ?? 1,
    phaseIterations,
    concurrency: args.concurrency ?? config.concurrency ?? 1,
    staggerDelayMs: args.staggerDelayMs ?? config.staggerDelayMs ?? 0,
    groupBy: args.groupBy ?? config.groupBy ?? 'participant',
    providers: args.providers ?? config.defaultProviders,
  };
  if (!Number.isInteger(resolved.iterations) || resolved.iterations < 1) {
    throw new Error(`iterations must be an integer >= 1 (got ${resolved.iterations})`);
  }
  if (!Number.isInteger(resolved.concurrency) || resolved.concurrency < 1) {
    throw new Error(`concurrency must be an integer >= 1 (got ${resolved.concurrency})`);
  }
  return resolved;
}

/** One scheduled task slot: which task to run and (optionally) under which phase. */
interface Slot<T extends BaseParticipant = BaseParticipant> {
  phase?: string;
  task: BenchmarkTask<T>;
}

/**
 * Flattens a config into an ordered list of task slots. With `phases`, each
 * phase contributes its own iterations' worth of slots tagged with its name
 * (framework owns the phase boundary — no index arithmetic in the task).
 * Without phases, the task is repeated `iterations` times.
 */
function buildSchedule<T extends BaseParticipant>(
  config: BenchmarkConfig<T>,
  resolved: ResolvedRunConfig,
  task: BenchmarkTask<T>,
): Slot<T>[] {
  if (config.phases?.length) {
    return config.phases.flatMap((phase) =>
      Array.from({ length: resolved.phaseIterations ?? phase.iterations }, () => ({
        phase: phase.name,
        task,
      })),
    );
  }
  return Array.from({ length: resolved.iterations }, () => ({ phase: undefined, task }));
}

type OnResult = (record: TaskResultRecord, meta: { iterations: number; participant: string }) => void;

function defaultOnResult(record: TaskResultRecord, meta: { iterations: number; participant: string }): void {
  const n = record.taskIndex + 1;
  if (record.status === 'success') {
    const data = record.data && Object.keys(record.data).length > 0 ? ` ${JSON.stringify(record.data)}` : '';
    console.log(`  [${meta.participant}] Task ${n}/${meta.iterations}: success${data}`);
  } else {
    console.log(`  [${meta.participant}] Task ${n}/${meta.iterations}: FAILED — ${record.errorCode ?? 'unknown error'}`);
  }
}

/**
 * Resolves `--shape <name>` against the config's declared `shapes`. Throws with
 * the known names if the shape is unknown, so a typo fails loudly instead of
 * silently running the base benchmark.
 */
function resolveShape<T extends BaseParticipant>(
  config: BenchmarkConfig<T>,
  shapeName: string | undefined,
): BenchmarkShape | undefined {
  if (!shapeName) return undefined;
  const shape = config.shapes?.[shapeName];
  if (!shape) {
    const known = Object.keys(config.shapes ?? {});
    throw new Error(
      known.length > 0
        ? `Unknown --shape "${shapeName}". Known shapes: ${known.join(', ')}.`
        : `Unknown --shape "${shapeName}": this benchmark declares no shapes.`,
    );
  }
  return shape;
}

/**
 * Swaps a shape's identity (and its stable knob) into the config. Only the
 * parts that make it a distinct benchmark move here; scale knobs stay on the
 * CLI, so `mergeConfig` still lets `--concurrency`/`--iterations` win.
 */
function applyShape<T extends BaseParticipant>(
  config: BenchmarkConfig<T>,
  shape: BenchmarkShape | undefined,
): BenchmarkConfig<T> {
  if (!shape) return config;
  return {
    ...config,
    benchmarkSlug: shape.slug,
    benchmarkName: shape.name ?? shape.slug,
    ...(shape.staggerDelayMs !== undefined ? { staggerDelayMs: shape.staggerDelayMs } : {}),
  };
}

/** Applies the `--benchmark`/`--name` overrides, so one entrypoint can report under several benchmarks. */
function applyIdentityOverrides<T extends BaseParticipant>(
  fileConfig: BenchmarkConfig<T>,
  args: CliArgs,
): BenchmarkConfig<T> {
  return {
    ...fileConfig,
    ...(args.benchmark ? { benchmarkSlug: args.benchmark } : {}),
    ...(args.name ? { benchmarkName: args.name } : {}),
  };
}

function dashboardUrlFor(baseUrl: string, organizationSlug: string, benchmarkSlug: string, runId: string): string {
  return `${baseUrl.replace(/\/api\/v1\/?$/, '')}/${organizationSlug}/benchmarks/${benchmarkSlug}/runs/${runId}`;
}

/** The participants a run covers: `--provider` selection, minus any whose env vars are unset. */
function resolveParticipants<T extends BaseParticipant>(config: BenchmarkConfig<T>, resolved: ResolvedRunConfig): T[] {
  const { available, skipped } = filterParticipantsByEnv(selectParticipants(config.participants, resolved.providers));
  for (const s of skipped) {
    console.log(`Skipping ${s.name}: missing ${s.missing.join(', ')}`);
  }
  if (available.length === 0) throw new NoAvailableParticipantsError(skipped);
  return available;
}

/** Builds a JSON-serializable snapshot of the resolved run execution config. */
function runConfigToJson<T extends BaseParticipant>(
  config: BenchmarkConfig<T>,
  resolved: ResolvedRunConfig,
  participants: string[],
): JsonObject {
  const phases = config.phases?.map((phase) => ({
    name: phase.name,
    iterations: resolved.phaseIterations ?? phase.iterations,
  }));
  const runConfig = {
    benchmarkSlug: config.benchmarkSlug,
    benchmarkName: config.benchmarkName,
    ...(resolved.phaseIterations !== undefined ? { phaseIterations: resolved.phaseIterations } : {}),
    ...(phases ? { phases } : {}),
    ...(!config.phases ? { iterations: resolved.iterations } : {}),
    concurrency: resolved.concurrency,
    staggerDelayMs: resolved.staggerDelayMs,
    groupBy: resolved.groupBy,
    ...(config.dimensions ? { dimensions: config.dimensions } : {}),
    ...(config.scoring ? { scoring: config.scoring } : {}),
    participants,
  };
  return JSON.parse(JSON.stringify(runConfig)) as JsonObject;
}

/**
 * Runs `config`'s `task` against its participants. Selects participants by
 * `--provider` (if given), env-gates them, then drives them per the resolved
 * `groupBy`. `--shape` swaps in a declared variant's identity; `--benchmark`/
 * `--name` retarget the run at a different platform benchmark, so one entrypoint
 * can report under several slugs. With `--run-key`, sibling processes (e.g. one
 * CI job per provider) get-or-create one shared run and each registers only its
 * own participants.
 */
export async function runBenchmark<T extends BaseParticipant>(
  fileConfig: BenchmarkConfig<T>,
  task: BenchmarkTask<T>,
  argv: string[] = [],
): Promise<BenchmarkRunOutcome> {
  const args = parseCliArgs(argv, fileConfig.customCliFlags);
  const noIngest = args.noIngest ?? isEnvNoIngest();
  const shaped = applyShape(fileConfig, resolveShape(fileConfig, args.shape));
  const config = applyIdentityOverrides(shaped, args);
  const resolved = mergeConfig(config, args);

  const auth = await resolveAuth();
  const client = createBenchmarkClient({
    baseUrl: auth.apiBaseUrl,
    apiKey: auth.apiKey,
    token: auth.token,
    orgSlug: auth.orgSlug,
    orgId: auth.orgId,
  });

  const available = resolveParticipants(config, resolved);

  const schedule = buildSchedule(config, resolved, task);
  const totalTasks = schedule.length;

  const concurrencyLabel = resolved.groupBy === 'round' ? 'n/a (round mode)' : String(resolved.concurrency);
  console.log(`${config.benchmarkName} (self-contained)`);
  console.log(`Date: ${new Date().toISOString()}`);
  if (noIngest) {
    console.log('Dry run: no platform ingest or reporting.\n');
  }
  console.log(
    `Knobs: iterations=${totalTasks}, concurrency=${concurrencyLabel}, ` +
      `staggerDelayMs=${resolved.staggerDelayMs}, groupBy=${resolved.groupBy}\n`,
  );

  // Declaratively materialize the benchmark from the file/shape identity, which
  // is authoritative (its name lives in the file). A bare `--benchmark X` only
  // *retargets* reporting at a benchmark this file doesn't name, so we don't
  // upsert it — that would rename it to the file's own name.
  const identityIsOurs =
    args.shape !== undefined ||
    args.name !== undefined ||
    !args.benchmark ||
    args.benchmark === fileConfig.benchmarkSlug;

  let runId: string;
  let dashboardUrl: string;
  if (noIngest) {
    runId = 'no-ingest';
    dashboardUrl = '';
  } else {
    if (identityIsOurs) {
      const benchmarkConfig: JsonObject = config.scoring
        ? { scoring: config.scoring as unknown as JsonObject }
        : {};
      await client!.upsertBenchmark(config.benchmarkSlug, {
        name: config.benchmarkName,
        ...(Object.keys(benchmarkConfig).length > 0 ? { config: benchmarkConfig } : {}),
      });
    }

    const runConfig = client
      ? runConfigToJson(config, resolved, available.map((p) => p.name))
      : {};

    if (args.runKey) {
      // Shared run: get-or-created by key, so sibling processes (one per provider)
      // converge on one run. Opened participant-sized — register only the
      // providers this process runs and let each sibling register its own, so the
      // run lists exactly who's benchmarked and each brings its own task count.
      const { run, organizationSlug } = await client!.createRun(config.benchmarkSlug, {
        runKey: args.runKey,
        config: runConfig,
      });
      runId = run.id;
      dashboardUrl = dashboardUrlFor(auth.apiBaseUrl, organizationSlug, config.benchmarkSlug, run.id);
      for (const participant of available) {
        await client!.upsertParticipant(config.benchmarkSlug, runId, participant.name, { totalTasks });
      }
      console.log(`Shared run (key "${args.runKey}"): ${run.name} (${runId})`);
      console.log(`View at: ${dashboardUrl}\n`);
    } else {
      const { run, organizationSlug } = await client!.createRun(config.benchmarkSlug, {
        totalTasks,
        workerCount: 1,
        participants: available.map((p) => p.name),
        config: runConfig,
      });
      runId = run.id;
      dashboardUrl = dashboardUrlFor(auth.apiBaseUrl, organizationSlug, config.benchmarkSlug, run.id);
      console.log(`Run created: ${run.name} (${runId})`);
      console.log(`View at: ${dashboardUrl}\n`);
    }
  }

  const onResult = defaultOnResult;

  let participantRecords: ParticipantRecords[];
  if (resolved.groupBy === 'round') {
    participantRecords = await runGroupedByRound(config, schedule, available, resolved, client, runId, auth.apiBaseUrl, auth.apiKey, auth.token, auth.orgSlug, auth.orgId, onResult, noIngest);
  } else {
    participantRecords = await runGroupedByParticipant(config, schedule, available, resolved, client, runId, onResult, noIngest);
  }

  console.log(`All done. ${noIngest ? 'No platform run created.' : `View at: ${dashboardUrl}`}`);
  const outcome: BenchmarkRunOutcome = {
    runId,
    dashboardUrl,
    participants: participantRecords,
    config: resolved,
  };
  if (!noIngest && (config.onScore || config.scoring)) {
    try {
      const spec = config.onScore
        ? await config.onScore(lowerIsBetter, higherIsBetter)
        : scoringConfigToSpec(config.scoring!, config.dimensions);
      const scored = score(outcome, spec);
      const run = {
        gitSha: process.env.GITHUB_SHA ?? getGitSha(),
        gitRef: process.env.GITHUB_REF_NAME ?? process.env.GITHUB_REF ?? getGitRef(),
        triggeredBy: process.env.GITHUB_EVENT_NAME ?? 'manual',
        nodeVersion: process.version,
        platform: os.platform(),
        arch: os.arch(),
      };
      await client.submitRunSummary(config.benchmarkSlug, runId, {
        run,
        results: scored,
        ...(config.scoring ? { scoring: config.scoring as unknown as JsonObject } : {}),
      });
    } catch (err) {
      // A ScoringSpecError means the scoring spec is misconfigured (e.g. metric
      // weights don't sum to 1.0) — an authoring bug, not a transient submit
      // failure, so it must fail the run rather than degrade to a warning.
      if (err instanceof ScoringSpecError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[benchsdk-runner] failed to submit run summary: ${message}`);
    }
  }
  if (config.onComplete) await config.onComplete(outcome);
  return outcome;
}

function getGitSha(): string | undefined {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf8', stdio: 'pipe' }).trim();
  } catch {
    return undefined;
  }
}

function getGitRef(): string | undefined {
  if (process.env.GITHUB_REF_NAME) return process.env.GITHUB_REF_NAME;
  if (process.env.GITHUB_REF) return process.env.GITHUB_REF;
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8', stdio: 'pipe' }).trim();
  } catch {
    return undefined;
  }
}

/**
 * 'participant' ordering: one `runWorker` call per participant, in turn.
 * `staggerDelayMs` here launches task N at `workerStart + N * staggerDelayMs`
 * (vs. round mode's fixed delay between rounds — intentionally different).
 * `TaskResult.steps`/`latencyMs` are ignored in this path: the platform
 * worker owns step timing and latency.
 */
async function runGroupedByParticipant<T extends BaseParticipant>(
  config: BenchmarkConfig<T>,
  schedule: Slot<T>[],
  available: T[],
  resolved: ResolvedRunConfig,
  client: BenchmarkClient | null,
  runId: string,
  onResult: OnResult,
  noIngest: boolean,
): Promise<ParticipantRecords[]> {
  const participantRecords: ParticipantRecords[] = [];
  for (const participant of available) {
    console.log(`${'='.repeat(70)}`);
    console.log(`  Participant: ${participant.name}`);
    console.log('='.repeat(70));

    // When running without platform ingest, execute the schedule locally.
    if (noIngest || !client) {
      const records: TaskResultRecord[] = [];
      let rampStartMs: number | undefined;
      let nextIndex = 0;
      const logBuffer = new LogBuffer();

      const runSlot = async (scheduleIndex: number) => {
        if (resolved.staggerDelayMs > 0) {
          rampStartMs ??= Date.now();
          const waitMs = rampStartMs + scheduleIndex * resolved.staggerDelayMs - Date.now();
          if (waitMs > 0) await sleep(waitMs);
        }
        const slot = schedule[scheduleIndex];
        const record = await runTaskRecord(slot.task, participant, scheduleIndex, scheduleIndex, slot.phase, logBuffer);
        onResult(record, { iterations: schedule.length, participant: participant.name });
        records.push(record);
      };

      const worker = async () => {
        while (nextIndex < schedule.length) {
          const index = nextIndex++;
          await runSlot(index);
        }
      };

      await Promise.all(Array.from({ length: resolved.concurrency }, () => worker()));
      records.sort((a, b) => a.taskIndex - b.taskIndex);

      const ok = records.filter((r) => r.status === 'success').length;
      console.log(`  Done: ${ok}/${records.length} succeeded.\n`);
      participantRecords.push({ participant: participant.name, records });
      continue;
    }

    // Anchors the ramp to the worker's start, so a pool narrower than the task
    // count can't inflate launch offsets: a task whose slot frees after its
    // scheduled launch time starts immediately instead of sleeping index*delay.
    let rampStartMs: number | undefined;
    await client.planWorkers(config.benchmarkSlug, runId, participant.name);

    const result = await runWorker(client, {
      benchmarkSlug: config.benchmarkSlug,
      runId: runId,
      participantSlug: participant.name,
      concurrency: resolved.concurrency,
      task: async (ctx: RunWorkerContext) => {
        // `ctx.taskIndex` is the platform's global index; the schedule is
        // indexed from the worker's own task range start.
        const scheduleIndex = ctx.taskIndex - ctx.assignment.taskRange.start;
        if (resolved.staggerDelayMs > 0) {
          rampStartMs ??= Date.now();
          const waitMs = rampStartMs + scheduleIndex * resolved.staggerDelayMs - Date.now();
          if (waitMs > 0) await sleep(waitMs);
        }
        const slot = schedule[scheduleIndex];
        // The client owns step timing, `measure` attribution, and worker-log
        // upload; the runner just threads them onto the task context. The runner
        // wraps `ctx.step` so per-step `timeoutMs` and `concurrency` work in
        // participant mode as well.
        // Tagged before the task runs, not after: measures survive a thrown
        // task, so a failed record still carries its phase and can be grouped
        // (and filtered) alongside the successful records of that phase.
        if (slot.phase) ctx.measure({ phase: slot.phase });
        try {
          const taskResult = await slot.task({
            participant,
            taskIndex: scheduleIndex,
            phase: slot.phase,
            step: (name, fn, options) => runStepWithClient(ctx.step, name, fn, options),
            measure: ctx.measure,
            log: ctx.log,
          });
          return taskResult?.data;
        } catch (error) {
          // Mirrors the 'round' path: a TaskError's domain data is preserved on
          // the failure record instead of being dropped for the error message.
          if (isTaskError(error) && error.data) ctx.measure(error.data);
          throw error;
        }
      },
      onResult: (record) => onResult(record, { iterations: schedule.length, participant: participant.name }),
    });

    if (!result.assignment) {
      console.error(`  No pending worker to claim for run ${runId} — it may already be fully claimed.`);
      participantRecords.push({ participant: participant.name, records: result.records ?? [] });
      continue;
    }

    const ok = result.records.filter((r) => r.status === 'success').length;
    console.log(`  Done: ${ok}/${result.records.length} succeeded.\n`);
    participantRecords.push({ participant: participant.name, records: result.records });
  }

  return participantRecords;
}

/**
 * 'round' ordering: claim one `BenchmarkReporter` per participant up front,
 * then loop rounds, running one task per participant per round and streaming
 * each result to its reporter. Steps are built manually (no `runWorker`
 * to own them) via a shim that mirrors the platform's record shape.
 */
async function runGroupedByRound<T extends BaseParticipant>(
  config: BenchmarkConfig<T>,
  schedule: Slot<T>[],
  available: T[],
  resolved: ResolvedRunConfig,
  client: BenchmarkClient | null,
  runId: string,
  baseUrl: string,
  apiKey: string | undefined,
  token: string | undefined,
  orgSlug: string | undefined,
  orgId: string | undefined,
  onResult: OnResult,
  noIngest: boolean = false,
): Promise<ParticipantRecords[]> {
  const reporters = new Map<string, BenchmarkReporter | null>();
  const logBuffers = new Map<string, LogBuffer>();
  const failed = new Map<string, boolean>();
  const recordsByParticipant = new Map<string, TaskResultRecord[]>();
  // A single collector for the whole run: round mode interleaves every
  // participant in this one shared Node process, so per-participant CPU/memory
  // can't be isolated — a sample reflects the whole process, not one slice of
  // it. We therefore sample once per round (not once per participant) and
  // upload a single `system-metrics` artifact, rather than N duplicates that
  // would falsely imply isolated per-participant usage. (Separate artifacts
  // only make sense when workers genuinely run on separate VMs, one per
  // participant, as the client `runWorker` path does.) Created only when at
  // least one participant has a reporter to upload to — nothing else reads it.
  let metricsCollector: BenchmarkSystemMetricsCollector | undefined;
  const metricsSamples: BenchmarkSystemMetricsSample[] = [];

  for (const participant of available) {
    logBuffers.set(participant.name, new LogBuffer());
    failed.set(participant.name, false);
    if (noIngest || !client) {
      reporters.set(participant.name, null);
      continue;
    }
    // One worker per participant drives every round sequentially. The platform
    // reads `targetConcurrency` as tasks-per-worker, so it must be the full
    // schedule length — otherwise only one task is planned and every record
    // past the first falls outside the worker's task range.
    await client.planWorkers(config.benchmarkSlug, runId, participant.name, {
      workerCount: 1,
      targetConcurrency: schedule.length,
    });
    let reporter: BenchmarkReporter | null = null;
    try {
      reporter = await BenchmarkReporter.claim({
        baseUrl,
        apiKey,
        token,
        orgSlug,
        orgId,
        benchmarkSlug: config.benchmarkSlug,
        runId: runId,
        participantSlug: participant.name,
        processKind: 'process',
        processKey: process.env.HOSTNAME ?? 'local',
      });
    } catch (error) {
      console.warn(`  ${participant.name}: reporter claim failed (${error instanceof Error ? error.message : String(error)}) — running without platform reporting.`);
    }
    if (!reporter) {
      console.warn(`  ${participant.name}: could not claim a platform worker — running without platform reporting.`);
    }
    reporters.set(participant.name, reporter);
    // First reporter to appear starts the one shared collector, with an
    // immediate baseline sample so a run that finishes inside one round still
    // uploads metrics.
    if (reporter && !metricsCollector) {
      metricsCollector = createSystemMetricsCollector();
      metricsSamples.push(metricsCollector.sample());
    }
  }

  console.log(`Interleaving ${available.length} participant(s), ${schedule.length} round(s) each.\n`);

  for (let i = 0; i < schedule.length; i++) {
    const slot = schedule[i];
    // Round mode staggers a fixed delay between rounds (vs. participant mode's per-task stagger).
    if (resolved.staggerDelayMs > 0 && i > 0) {
      await sleep(resolved.staggerDelayMs);
    }
    for (const participant of available) {
      const reporter = reporters.get(participant.name) ?? null;
      const logBuffer = logBuffers.get(participant.name)!;
      const record = await runTaskRecord(
        slot.task,
        participant,
        i,
        (reporter?.taskIndexStart ?? 0) + i,
        slot.phase,
        logBuffer,
      );
      if (record.status !== 'success') failed.set(participant.name, true);
      onResult(record, { iterations: schedule.length, participant: participant.name });
      reporter?.recordResult(record);
      if (!recordsByParticipant.has(participant.name)) {
        recordsByParticipant.set(participant.name, []);
      }
      const participantRecords = recordsByParticipant.get(participant.name)!;
      participantRecords.push(record);
      // Round mode drives the worker by hand, so nothing reports progress
      // unless we do: without this the platform shows 0 done for the whole run.
      if (reporter) {
        reporter.setProgress({
          done: participantRecords.length,
          inFlight: 0,
          errors: participantRecords.filter((item) => item.status !== 'success').length,
          total: schedule.length,
        });
        await reporter.heartbeat();
      }
    }
    // Sampled once per round rather than on a wall-clock timer: round mode runs
    // everything sequentially in this one loop, so a round boundary is the
    // natural, already-existing cadence. Taken after the whole round (not per
    // participant) since the sample covers the shared process, not one slice.
    if (metricsCollector) metricsSamples.push(metricsCollector.sample());
  }

  // One shared collector for the whole process — a final sample (before stop,
  // which disables the event-loop monitor), then upload a single
  // `system-metrics` artifact via any one reporter (all participants ran in
  // this process, so the metrics belong to the run, not to any one of them).
  if (metricsCollector) metricsSamples.push(metricsCollector.sample());
  metricsCollector?.stop();
  // The SDK only has a worker-scoped artifact API, so this single artifact is
  // necessarily filed under one reporter's worker. Tag it as process-scoped
  // with the full participant list so consumers don't mistake it for that one
  // participant's isolated usage — the metrics cover every participant that ran
  // in this shared process, not just the reporter it happened to upload through.
  const metricsReporter = available.map((p) => reporters.get(p.name)).find((r): r is BenchmarkReporter => Boolean(r));
  if (metricsReporter && metricsSamples.length > 0) {
    await metricsReporter
      .uploadArtifact({
        kind: 'system-metrics',
        contentType: 'application/x-ndjson',
        name: 'metrics.jsonl',
        metadata: { scope: 'shared-process', participants: available.map((p) => p.name) },
        body: metricsSamples.map((sample) => JSON.stringify(sample)).join('\n') + '\n',
      })
      .catch(() => {});
  }

  for (const participant of available) {
    const reporter = reporters.get(participant.name) ?? null;
    const logBuffer = logBuffers.get(participant.name)!;
    if (reporter && !logBuffer.isEmpty()) {
      await reporter
        .uploadArtifact({ kind: 'coordinator.log', contentType: 'text/plain', name: 'worker.log', body: logBuffer.toText() })
        .catch(() => {});
    }
    await reporter?.finish(failed.get(participant.name) ?? false);
    console.log(`  ${participant.name}: done${failed.get(participant.name) ? ' (with errors)' : ''}.`);
  }

  return available.map((p) => ({ participant: p.name, records: recordsByParticipant.get(p.name) ?? [] }));
}

/** Merges a task's data payload with the current phase tag (if any). */
function mergeData(data: JsonObject | undefined, phase: string | undefined): JsonObject | undefined {
  const merged = { ...(data ?? {}), ...(phase ? { phase } : {}) };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

/**
 * Runs one task for the manual 'round' path, building its `TaskResultRecord`.
 * Honors the full `TaskResult` (task-owned data/steps/latency) and `TaskError`
 * (preserves domain data + steps on failure). Framework-timed `ctx.step` calls
 * and task-owned `result.steps` are both recorded.
 */
async function runTaskRecord<T extends BaseParticipant>(
  task: BenchmarkTask<T>,
  participant: T,
  scheduleIndex: number,
  taskIndex: number,
  phase: string | undefined,
  logBuffer: LogBuffer,
): Promise<TaskResultRecord> {
  const startedAtMs = Date.now();
  const record: TaskResultRecord = {
    taskIndex,
    status: 'success',
    startedAt: new Date(startedAtMs).toISOString(),
  };
  const frameworkSteps: TaskStepRecord[] = [];
  const taskMeasures: JsonObject = {};
  // Mirrors the client worker: `measure` lands on the active step (if any),
  // else on task-level measurements folded into `record.data`.
  let activeStep: TaskStepRecord | null = null;

  const ctx: TaskContext<T> = {
    participant,
    taskIndex: scheduleIndex,
    phase,
    async step<R, C extends number = 1>(
      name: string,
      fn: () => Promise<R> | R,
      options?: TaskStepOptions & { concurrency?: C },
    ): Promise<C extends 1 ? R : R[]> {
      const stepStartedAtMs = Date.now();
      const stepRecord: TaskStepRecord = {
        name,
        status: 'success',
        startedAt: new Date(stepStartedAtMs).toISOString(),
        completedAt: new Date(stepStartedAtMs).toISOString(),
        latencyMs: 0,
      };
      if (options?.concurrency !== undefined) stepRecord.concurrency = options.concurrency;
      if (options?.timeoutMs !== undefined) stepRecord.timeoutMs = options.timeoutMs;
      const previousStep = activeStep;
      activeStep = stepRecord;
      try {
        const result = await runStepInvocations<R>(name, fn, options);
        const outcome: BenchmarkStepOutcome =
          options?.captureOutput !== false && !Array.isArray(result) && isStepOutcome(result)
            ? (result as BenchmarkStepOutcome)
            : {};
        logBuffer.step(taskIndex, name, outcome);
        return result as C extends 1 ? R : R[];
      } catch (error) {
        stepRecord.status = 'error';
        stepRecord.errorCode = isTaskError(error) ? error.code ?? error.name : getErrorCode(error);
        logBuffer.step(taskIndex, name, { error: error instanceof Error ? error.message : String(error) });
        throw error;
      } finally {
        activeStep = previousStep;
        stepRecord.completedAt = new Date().toISOString();
        stepRecord.latencyMs = Date.now() - stepStartedAtMs;
        frameworkSteps.push(stepRecord);
      }
    },
    measure(data) {
      if (activeStep) {
        activeStep.data = { ...(activeStep.data ?? {}), ...data };
      } else {
        Object.assign(taskMeasures, data);
      }
    },
    log(message, metaOrOptions) {
      logBuffer.line(`[task ${taskIndex}] ${message}`, metaOrOptions);
    },
  };

  let result: TaskResult | void = undefined;
  try {
    result = await task(ctx);
    record.data = mergeData({ ...taskMeasures, ...(result?.data ?? {}) }, phase);
  } catch (error) {
    record.status = 'error';
    if (isTaskError(error)) {
      record.errorCode = error.code ?? error.name;
      record.data = mergeData({ ...taskMeasures, ...(error.data ?? {}) }, phase);
      if (error.steps?.length) frameworkSteps.push(...error.steps);
    } else {
      record.errorCode = getErrorCode(error);
      record.data = mergeData(
        { ...taskMeasures, errorMessage: error instanceof Error ? error.message : String(error) },
        phase,
      );
    }
  } finally {
    const endMs = Date.now();
    record.completedAt = new Date(endMs).toISOString();
    record.latencyMs =
      record.status === 'success' && result && typeof result.latencyMs === 'number'
        ? result.latencyMs
        : endMs - startedAtMs;
    const taskSteps = record.status === 'success' && result?.steps ? result.steps : [];
    const allSteps = [...frameworkSteps, ...taskSteps];
    // A task that declared no steps is recorded as a single implicit 'task'
    // step, matching the client worker's behavior.
    if (allSteps.length === 0) {
      allSteps.push({
        name: 'task',
        status: record.status === 'success' ? 'success' : 'error',
        startedAt: record.startedAt,
        completedAt: record.completedAt,
        latencyMs: record.latencyMs,
        errorCode: record.errorCode ?? null,
        data: Object.keys(taskMeasures).length > 0 ? { ...taskMeasures } : undefined,
      });
    }
    record.steps = allSteps;
  }

  return record;
}
