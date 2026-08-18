/**
 * A `*.bench.ts` file is the composition of a **config** and a **task**:
 *
 *   export const config = defineBenchmarkConfig({ benchmarkSlug, participants, ... });
 *   export const task = defineTask(async (ctx) => { await ctx.step('work', () => ...); });
 *
 * `defineBenchmarkConfig` holds the orchestration knobs (including the
 * participants and an optional `onComplete` hook); `defineTask` holds the
 * workload. The `bench run <file>` binary imports the module, reads those two
 * exports, and drives the run. There is no "mode": all orchestration shapes
 * emerge from the knobs.
 *
 *   iterations       total tasks to run (default 1)
 *   concurrency      max tasks in flight at once — 1 = sequential, N = burst (default 1)
 *   staggerDelayMs   delay each task's start by taskIndex * staggerDelayMs (default 0)
 *
 * Common shapes:
 *   sequential  { iterations: N, concurrency: 1 }
 *   burst       { iterations: N, concurrency: N }
 *   staggered   { iterations: N, concurrency: N, staggerDelayMs: 200 }
 *
 * A benchmark can name these variants up front via `shapes`, so one file backs
 * several platform benchmarks (`bench run <file> --shape burst`) without
 * restating each one's slug/name in scripts and CI.
 *
 * A task is comprised of steps, declared via `ctx.step` inside a task function
 * — it supports closures, conditionals and try/finally, so values (a created
 * sandbox, say) flow naturally between steps. A task that declares no steps is
 * recorded as a single implicit `task` step. Measurements reach the platform
 * via `ctx.measure(...)`; step return values are control flow and never
 * recorded.
 */
import type {
  BenchmarkLogOptions,
  DefineStepOptions,
  JsonObject,
  TaskResultRecord,
  TaskStepRecord,
} from '@benchsdk/api';
import type { BaseParticipant } from '@benchsdk/worker';
import type { BenchmarkScoringConfig, HigherIsBetter, LowerIsBetter, ScoringSpec } from './scoring.js';

/** How tasks are ordered across participants. */
export type GroupBy = 'participant' | 'round';

/**
 * A named variant of a benchmark, selected with `--shape <name>`. A shape
 * carries only the parts that make it a distinct *benchmark* — its platform
 * identity plus any stable distinguishing knob (e.g. staggered's delay). The
 * scale knobs that vary per environment (`--iterations`, `--concurrency`) stay
 * on the invocation, so a shape never sets a value only to have the CLI
 * override it.
 */
export interface BenchmarkShape {
  /** Platform slug this shape reports under (e.g. 'sandbox-tti'). */
  slug: string;
  /** Display name shown on the platform; defaults to the slug. */
  name?: string;
  /** Default stagger delay (ms) for this shape; overridable with `--stagger-delay-ms`. */
  staggerDelayMs?: number;
}

/**
 * What a task returns: whatever it measured itself. This replaces the
 * assumption that the framework owns all timing. A plain data payload is
 * written explicitly as `{ data: {...} }`.
 */
export interface TaskResult {
  /** Free-form domain payload attached to the record (tokens, receipts, ...). */
  data?: JsonObject;
  /**
   * Pre-measured steps the task timed itself (e.g. socket phases).
   * Only honored in `groupBy: 'round'` runs, where the runner builds records
   * manually. In `groupBy: 'participant'` runs the platform worker
   * (`runWorker`) owns steps, so `steps` and `latencyMs` are ignored.
   */
  steps?: TaskStepRecord[];
  /** Task-owned overall latency; overrides framework wall-clock (round mode only). */
  latencyMs?: number;
}

/** Options for a single `ctx.step` invocation. */
export interface TaskStepOptions extends Omit<DefineStepOptions, 'concurrency' | 'stepConcurrency'> {
  /** Per-iteration timeout in milliseconds. If an invocation exceeds this, it is aborted and a `step_timeout` TaskError is thrown. */
  timeoutMs?: number;
  /** Number of times to invoke `fn` in parallel. Defaults to 1. When greater than 1, the step returns an array of results. */
  concurrency?: number;
}

/**
 * Throw this from a task to record a failure while preserving domain data and
 * any pre-measured steps (a plain thrown Error loses them).
 */
export class TaskError extends Error {
  readonly code?: string;
  readonly data?: JsonObject;
  readonly steps?: TaskStepRecord[];
  constructor(message: string, opts?: { code?: string; data?: JsonObject; steps?: TaskStepRecord[] }) {
    super(message);
    this.name = 'TaskError';
    this.code = opts?.code;
    this.data = opts?.data;
    this.steps = opts?.steps;
  }
}

/** Context handed to a benchmark `task` for a single iteration. */
export interface TaskContext<T extends BaseParticipant = BaseParticipant> {
  /** The participant this task is running for. */
  participant: T;
  /** Zero-based global task ordinal (matches the platform record's taskIndex). */
  taskIndex: number;
  /** Current phase name, when the benchmark declares `phases`. */
  phase?: string;
  /**
   * Runs `fn` as a named platform step. Mirrors `@benchsdk/worker`'s
   * `RunWorkerContext.step`; supports closures and try/finally. A `concurrency`
   * greater than 1 invokes `fn` that many times in parallel and returns an array.
   * `timeoutMs` aborts any invocation that exceeds it with a `step_timeout` TaskError.
   */
  step<R, C extends number = 1>(
    name: string,
    fn: () => Promise<R> | R,
    options?: TaskStepOptions & { concurrency?: C },
  ): Promise<C extends 1 ? R : R[]>;
  /**
   * Attaches a JSON measurement to the platform. Inside a `step` it lands on
   * that step's data; at task top-level it lands on the task record's data.
   */
  measure(data: JsonObject): void;
  /**
   * Appends a line to the worker log, uploaded as an artifact when the worker finishes.
   * `metaOrOptions` can be a metadata JSON object, or `{ level, meta }` to set a log level.
   */
  log(message: string, metaOrOptions?: JsonObject | BenchmarkLogOptions): void;
}

export type BenchmarkTask<T extends BaseParticipant = BaseParticipant> = (
  ctx: TaskContext<T>,
) => Promise<TaskResult | void> | TaskResult | void;

/**
 * A named run segment with its own iteration count. Phases run in order; each
 * record is tagged with the phase name via `data.phase`, and `ctx.phase` lets
 * the task branch on identity instead of index arithmetic.
 */
export interface Phase {
  /** Phase name, tagged onto every record produced in this phase. */
  name: string;
  /** Iterations to run in this phase. */
  iterations: number;
}

/** One participant's collected task records from a run. */
export interface ParticipantRecords {
  participant: string;
  records: TaskResultRecord[];
}

/** The orchestration knobs a run actually used, after CLI overrides. */
export interface ResolvedRunConfig {
  iterations: number;
  /**
   * Iterations each phase runs, when the benchmark declares `phases` and
   * `--iterations` overrode their configured counts. A phase is one arm of a
   * comparison (a file size), so the flag scales every arm equally rather than
   * dividing a total between them.
   */
  phaseIterations?: number;
  concurrency: number;
  staggerDelayMs: number;
  groupBy: GroupBy;
  providers?: string[];
}

/** Display metadata for a single custom metric a benchmark reports via `ctx.measure`. */
export interface BenchmarkMetricDisplay {
  /** Stable metric key, matching the key in `ctx.measure` or `data`. */
  key: string;
  /** Human-readable label shown in the platform UI. */
  label: string;
  /** Optional unit shown after the value (e.g. `Mbps`, `/s`, `ms`). */
  unit?: string;
  /** Number of decimal places when formatting numeric values. Defaults to the display format. */
  decimals?: number;
  /** Whether higher or lower values rank better. */
  direction?: 'higher-better' | 'lower-better';
  /** Optional ordering hint for metric lists. */
  order?: number;
}

/** Display metadata for a single task lifecycle step. */
export interface BenchmarkStepDisplay {
  /** Stable step name, matching the string passed to `ctx.step`. */
  key: string;
  /** Human-readable label shown in the platform UI. */
  label: string;
  /** Optional ordering hint for step lists. */
  order?: number;
}

/** Display defaults for the benchmark overview page. */
export interface BenchmarkOverviewDisplay {
  /** Metric key to rank participants by by default (falls back to overall task latency). */
  defaultMetric?: string;
  /** Default overview layout. */
  defaultLayout?: 'ranking' | 'cards' | 'chart' | 'leaderboard';
}

/**
 * Optional platform display manifest. A `*.bench.ts` file owns not only how the
 * benchmark runs, but how it should be rendered, without a platform code change.
 */
export interface BenchmarkDisplayConfig {
  /** Optional human-readable description shown on the benchmark listing. */
  description?: string;
  /** Metric catalog — labels, units, and ranking direction for `ctx.measure` keys. */
  metrics?: BenchmarkMetricDisplay[];
  /** Step catalog — human labels for lifecycle steps reported via `ctx.step`. */
  steps?: BenchmarkStepDisplay[];
  /** Overview defaults. */
  overview?: BenchmarkOverviewDisplay;
}

/**
 * Result of a benchmark run, passed to `config.onComplete`. Exposes the raw
 * per-participant records so completion hooks can write legacy local results.
 */
export interface BenchmarkRunOutcome {
  runId: string;
  /** Link to this run on the platform dashboard. */
  dashboardUrl: string;
  participants: ParticipantRecords[];
  config: ResolvedRunConfig;
}

/**
 * Orchestration config for a benchmark. Holds identity, the knobs, the
 * participants, and the optional completion hook — the workload lives in a
 * separate `defineTask`. `bench run <file>` reads the `config` and `task`
 * exports from the module and drives the run.
 */
export interface BenchmarkConfig<T extends BaseParticipant = BaseParticipant> {
  /**
   * Stable platform slug for this benchmark (e.g. 'sandbox-tti-local').
   * Selectable per run with `--shape` (or overridable with `--benchmark`), so
   * one entrypoint can report under several benchmarks.
   */
  benchmarkSlug: string;
  /** Human-readable name shown on the platform. Overridable with `--name`. */
  benchmarkName: string;
  /**
   * Named variants of this benchmark, selected with `--shape <name>`. Each
   * shape swaps in its own platform identity (and optional stable knob) while
   * reusing the same task and participants, so one bench file can back several
   * platform benchmarks without duplicating the slug/name triple across
   * package scripts and CI.
   */
  shapes?: Record<string, BenchmarkShape>;
  /**
   * Total tasks to run per participant. Default: 1. Mutually exclusive with
   * `phases` — when `phases` is set, total iterations = sum of phase iterations.
   */
  iterations?: number;
  /**
   * Named run segments (e.g. cold/warm). Runs in order; each record is tagged
   * with the phase name via `data.phase`. Mutually exclusive with `iterations`.
   */
  phases?: Phase[];
  /** Max tasks in flight at once. 1 = sequential, N = burst. Default: 1. */
  concurrency?: number;
  /** Delay each task's start by `taskIndex * staggerDelayMs`. Default: 0. */
  staggerDelayMs?: number;
  /**
   * Task ordering across participants. Default: 'participant' (run each
   * participant's tasks to completion, then the next). 'round' takes turns:
   * every participant runs its Nth task before anyone runs their (N+1)th, so
   * all participants' Nth tasks happen back-to-back under the same conditions.
   */
  groupBy?: GroupBy;
  /**
   * Default participant names to run when `--provider` is not passed. Omit to
   * run all env-available participants. `--provider` always overrides this.
   */
  defaultProviders?: string[];
  /** The participants this benchmark can run against. `--provider` selects a subset by name. */
  participants: T[];
  /**
   * Static run-level dimensions copied into the submitted summary (e.g.
   * `{ file_size: '10MB' }`). Useful for distinguishing runs of the same
   * benchmark that differ by an external parameter.
   */
  dimensions?: Record<string, unknown>;
  /**
   * Run-level scoring hook, called once with `lowerIsBetter` and `higherIsBetter`
   * primitives after the outcome is assembled but before `onComplete`. Use it to
   * define how the run should be scored and reported to the platform.
   */
  onScore?: (lowerIsBetter: LowerIsBetter, higherIsBetter: HigherIsBetter) => ScoringSpec | Promise<ScoringSpec>;
  /**
   * Run-level completion hook, called once with the full outcome after every
   * participant finishes. Use it for aggregate output (legacy JSON/SVG
   * writers). This is the run-level counterpart to per-step `ctx.measure`.
   */
  onComplete?: (outcome: BenchmarkRunOutcome) => void | Promise<void>;
  /**
   * Serializable scoring spec uploaded to the platform. When provided without
   * `onScore`, the runner computes the run summary from this spec automatically.
   * The platform can recompute `compositeScore` from the same spec at read time.
   */
  scoring?: BenchmarkScoringConfig;
  /**
   * Custom CLI flags this benchmark reads from `process.argv` (e.g. `--file-size`).
   * Declaring them lets the runner distinguish intentional pass-through flags
   * from typos and report unknown flags accurately.
   */
  customCliFlags?: readonly string[];
  /**
   * Optional display manifest. Lets the bench author configure metric labels,
   * step labels, and overview defaults without editing the platform.
   */
  display?: BenchmarkDisplayConfig;
}

function assertNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function assertPositiveInt(value: number | undefined, field: string): void {
  if (value === undefined) return;
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${field} must be an integer >= 1 (got ${value})`);
  }
}

function assertFiniteNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${field} must be a finite number (got ${value})`);
  }
  return value;
}

function validateBenchmarkScoringConfig(scoring: BenchmarkScoringConfig): void {
  if (!Array.isArray(scoring.metrics) || scoring.metrics.length === 0) {
    throw new Error('scoring.metrics must be a non-empty array');
  }
  if (scoring.success !== undefined) {
    const requireData = scoring.success.requireData;
    if (requireData === null || typeof requireData !== 'object' || Array.isArray(requireData)) {
      throw new Error('scoring.success.requireData must be a plain object');
    }
    if (Object.keys(requireData).length === 0) {
      throw new Error('scoring.success.requireData must declare at least one data field');
    }
    for (const [key, value] of Object.entries(requireData)) {
      const type = typeof value;
      if (type !== 'string' && type !== 'number' && type !== 'boolean') {
        throw new Error(
          `scoring.success.requireData.${key} must be a string, number, or boolean (got ${type})`,
        );
      }
    }
  }
  const seen = new Set<string>();
  let totalWeight = 0;
  for (let i = 0; i < scoring.metrics.length; i++) {
    const metric = scoring.metrics[i];
    if (metric === null || typeof metric !== 'object' || Array.isArray(metric)) {
      throw new Error(`scoring.metrics[${i}] must be an object`);
    }
    const key = metric.key;
    if (typeof key !== 'string' || key.trim() === '') {
      throw new Error(`scoring.metrics[${i}].key must be a non-empty string`);
    }
    if (seen.has(key)) {
      throw new Error(`duplicate scoring metric key: ${key}`);
    }
    seen.add(key);
    if (typeof metric.unit !== 'string' || metric.unit.trim() === '') {
      throw new Error(`scoring.metrics[${i}].unit must be a non-empty string`);
    }
    assertFiniteNumber(metric.ceiling, `scoring.metrics[${i}].ceiling`);
    if (metric.floor !== undefined) {
      assertFiniteNumber(metric.floor, `scoring.metrics[${i}].floor`);
    }
    if (metric.weights === null || typeof metric.weights !== 'object' || Array.isArray(metric.weights)) {
      throw new Error(`scoring.metrics[${i}].weights must be an object`);
    }
    const median = assertFiniteNumber(metric.weights.median, `scoring.metrics[${i}].weights.median`);
    const p95 = assertFiniteNumber(metric.weights.p95, `scoring.metrics[${i}].weights.p95`);
    const p99 = assertFiniteNumber(metric.weights.p99, `scoring.metrics[${i}].weights.p99`);
    if (median < 0 || p95 < 0 || p99 < 0) {
      throw new Error(`scoring.metrics[${i}].weights must be non-negative`);
    }
    totalWeight += median + p95 + p99;
    if (metric.trim !== undefined) {
      assertFiniteNumber(metric.trim, `scoring.metrics[${i}].trim`);
    }
  }
  if (Math.abs(totalWeight - 1) > 0.01) {
    throw new Error(`scoring metric weights must sum to 1.0 (got ${totalWeight.toFixed(3)})`);
  }
}

/** Validates `config` at file-evaluation time so mistakes surface immediately. */
export function defineBenchmarkConfig<T extends BaseParticipant = BaseParticipant>(
  config: BenchmarkConfig<T>,
): BenchmarkConfig<T> {
  if (!config.benchmarkSlug || typeof config.benchmarkSlug !== 'string') {
    throw new Error('benchmarkSlug is required');
  }
  if (!config.benchmarkName || typeof config.benchmarkName !== 'string') {
    throw new Error('benchmarkName is required');
  }
  if (config.phases !== undefined) {
    if (config.iterations !== undefined) {
      throw new Error('phases and iterations are mutually exclusive');
    }
    if (!Array.isArray(config.phases) || config.phases.length === 0) {
      throw new Error('phases must be a non-empty array');
    }
    const seen = new Set<string>();
    for (const phase of config.phases) {
      if (!phase.name || typeof phase.name !== 'string') {
        throw new Error('each phase requires a non-empty name');
      }
      if (seen.has(phase.name)) {
        throw new Error(`duplicate phase name: ${phase.name}`);
      }
      seen.add(phase.name);
      assertPositiveInt(phase.iterations, `phase '${phase.name}' iterations`);
    }
  }
  assertPositiveInt(config.iterations, 'iterations');
  assertPositiveInt(config.concurrency, 'concurrency');
  if (config.staggerDelayMs !== undefined && (!Number.isFinite(config.staggerDelayMs) || config.staggerDelayMs < 0)) {
    throw new Error(`staggerDelayMs must be a number >= 0 (got ${config.staggerDelayMs})`);
  }
  if (config.groupBy !== undefined && config.groupBy !== 'participant' && config.groupBy !== 'round') {
    throw new Error(`groupBy must be 'participant' or 'round' (got ${config.groupBy})`);
  }
  if (config.shapes !== undefined) {
    for (const [shapeName, shape] of Object.entries(config.shapes)) {
      if (!shape.slug || !/^[a-z0-9][a-z0-9-]*$/.test(shape.slug)) {
        throw new Error(`shape '${shapeName}' needs a lowercase slug (got ${JSON.stringify(shape.slug)})`);
      }
      if (shape.name !== undefined && (typeof shape.name !== 'string' || shape.name.trim() === '')) {
        throw new Error(`shape '${shapeName}' name must be a non-empty string`);
      }
      if (shape.staggerDelayMs !== undefined && (!Number.isFinite(shape.staggerDelayMs) || shape.staggerDelayMs < 0)) {
        throw new Error(`shape '${shapeName}' staggerDelayMs must be a number >= 0 (got ${shape.staggerDelayMs})`);
      }
    }
  }
  if (config.dimensions !== undefined) {
    if (config.dimensions === null || typeof config.dimensions !== 'object' || Array.isArray(config.dimensions)) {
      throw new Error('dimensions must be a plain object');
    }
  }
  if (config.scoring !== undefined) {
    validateBenchmarkScoringConfig(config.scoring);
  }
  if (config.customCliFlags !== undefined) {
    if (!Array.isArray(config.customCliFlags) || !config.customCliFlags.every((f) => typeof f === 'string' && f.startsWith('--'))) {
      throw new Error('customCliFlags must be an array of strings starting with "--"');
    }
  }
  if (config.display !== undefined) {
    if (typeof config.display !== 'object' || config.display === null || Array.isArray(config.display)) {
      throw new Error('display must be an object');
    }
    if (config.display.metrics !== undefined) {
      if (!Array.isArray(config.display.metrics)) {
        throw new Error('display.metrics must be an array');
      }
      const seenMetricKeys = new Set<string>();
      for (let i = 0; i < config.display.metrics.length; i++) {
        const metric = config.display.metrics[i];
        if (metric === null || typeof metric !== 'object' || Array.isArray(metric)) {
          throw new Error(`display.metrics[${i}] must be an object`);
        }
        const key = assertNonEmptyString(metric.key, `display.metrics[${i}].key`);
        if (seenMetricKeys.has(key)) {
          throw new Error(`duplicate display metric key: ${key}`);
        }
        seenMetricKeys.add(key);
        assertNonEmptyString(metric.label, `display.metrics[${i}].label`);
        if (metric.direction !== undefined && metric.direction !== 'higher-better' && metric.direction !== 'lower-better') {
          throw new Error(`display.metrics[${i}].direction must be 'higher-better' or 'lower-better'`);
        }
        if (metric.decimals !== undefined && (!Number.isInteger(metric.decimals) || metric.decimals < 0)) {
          throw new Error(`display.metrics[${i}].decimals must be a non-negative integer`);
        }
        if (metric.order !== undefined && (!Number.isInteger(metric.order) || metric.order < 0)) {
          throw new Error(`display.metrics[${i}].order must be a non-negative integer`);
        }
      }
    }
    if (config.display.steps !== undefined) {
      if (!Array.isArray(config.display.steps)) {
        throw new Error('display.steps must be an array');
      }
      const seenStepKeys = new Set<string>();
      for (let i = 0; i < config.display.steps.length; i++) {
        const step = config.display.steps[i];
        if (step === null || typeof step !== 'object' || Array.isArray(step)) {
          throw new Error(`display.steps[${i}] must be an object`);
        }
        const key = assertNonEmptyString(step.key, `display.steps[${i}].key`);
        if (seenStepKeys.has(key)) {
          throw new Error(`duplicate display step key: ${key}`);
        }
        seenStepKeys.add(key);
        assertNonEmptyString(step.label, `display.steps[${i}].label`);
        if (step.order !== undefined && (!Number.isInteger(step.order) || step.order < 0)) {
          throw new Error(`display.steps[${i}].order must be a non-negative integer`);
        }
      }
    }
    if (config.display.overview !== undefined) {
      if (typeof config.display.overview !== 'object' || config.display.overview === null || Array.isArray(config.display.overview)) {
        throw new Error('display.overview must be an object');
      }
      const { defaultLayout } = config.display.overview;
      if (defaultLayout !== undefined && !['ranking', 'cards', 'chart', 'leaderboard'].includes(defaultLayout)) {
        throw new Error("display.overview.defaultLayout must be 'ranking', 'cards', 'chart', or 'leaderboard'");
      }
    }
  }
  return config;
}

/**
 * Declares the workload for a benchmark: a function invoked once per iteration.
 * Steps are named via `ctx.step`, which supports closures and try/finally so
 * values flow naturally between steps.
 *
 *   export const task = defineTask(async (ctx) => {
 *     const sandbox = await ctx.step('create', () => provider.create());
 *     try { await ctx.step('exec', () => sandbox.run('node -v')); }
 *     finally { await ctx.step('destroy', () => sandbox.destroy()); }
 *   });
 */
export function defineTask<T extends BaseParticipant = BaseParticipant>(
  task: BenchmarkTask<T>,
): BenchmarkTask<T> {
  if (typeof task !== 'function') {
    throw new Error('defineTask requires a task function.');
  }
  return task;
}
