# @benchsdk/runner

Benchmark framework for authoring `*.bench.ts` files and operating benchmark workers. It reports to the benchmarks platform via `@benchsdk/api`; [`@benchsdk/client`](../benchsdk) is a backwards-compatibility re-export shim.

## What it provides

- **`defineBenchmarkConfig`** / **`defineTask`** — A `*.bench.ts` file exports exactly two things: a **config** (`defineBenchmarkConfig`, the orchestration knobs + `participants` + an optional `onComplete` hook) and a **task** (`defineTask`, the workload for one iteration). There is no "mode": the orchestration shape (sequential / staggered / burst) emerges from the `iterations`, `concurrency`, and `staggerDelayMs` knobs, and `groupBy` (`'participant'` | `'round'`) selects the ordering across participants.
- **`bench run <file>`** — The CLI entrypoint. It imports the module, reads its `config` and `task`, applies CLI overrides, and drives the run. Benchmark files declare; they never call the runner themselves.
- **`bench check <file>`** — Validates environment variables, API connectivity, participant availability, and scoring weights before a run.
- **`runBenchmarkWorker(options)`** — One-shot operator helper that runs a single participant's worker without a `*.bench.ts` file.
- **`TaskError`** / **`NoAvailableParticipantsError`** — Structured errors: throw `TaskError` from a task to attach a code / data / pre-measured steps; `bench run` treats `NoAvailableParticipantsError` (every participant env-gated out) as a clean no-op exit.

## Install

```sh
pnpm add @benchsdk/runner @benchsdk/client
```

## Usage

A benchmark file exports a `config` and a `task` — nothing else:

```ts
import { defineBenchmarkConfig, defineTask } from '@benchsdk/runner';
import { providers } from './providers.js';
import { writeLegacyResults } from './legacy-results.js';

export const config = defineBenchmarkConfig({
  benchmarkSlug: 'sandbox-tti-local',
  benchmarkName: 'Sandbox TTI (local)',
  iterations: 100,       // total tasks per participant
  concurrency: 1,        // 1 = sequential, N = burst, N + staggerDelayMs = staggered
  participants: providers,
  // Aggregate post-run work (the one thing a single task can't see) lives here.
  onComplete: (outcome) => writeLegacyResults(outcome.participants),
});

export const task = defineTask(async ({ participant, step, measure, log }) => {
  log('creating sandbox', { level: 'info', meta: { participant: participant.name } });
  // Named steps via `ctx.step`: values flow between steps with closures and
  // cleanup runs in a `finally`. Each step is a first-class platform record
  // with its own timing/status. A step returning `{ stdout, stderr, exitCode }`
  // writes that output to the worker log unless `captureOutput: false` is passed.
  const sandbox = await step('create', () => participant.createCompute().sandbox.create());
  try {
    const t0 = performance.now();
    await step('exec', () => sandbox.runCommand('node -v'));
    measure({ ttiMs: performance.now() - t0 });   // metrics → the platform
  } finally {
    await step('destroy', () => sandbox.destroy());
  }
});
```

Run it with the CLI (flags override the config knobs):

```sh
bench run benchmarks/sandbox/sandbox-tti.bench.ts --iterations 100 --concurrency 20 --provider e2b,modal
```

`bench run` requires platform auth — `BENCHMARKS_PLATFORM_API_KEY`, `BENCHMARKS_PLATFORM_TOKEN`, or a token saved via `bench auth login` — even for `--dry-run` / `--no-ingest` / `BENCHSDK_NO_INGEST=1`; those flags only skip uploading, they do not skip auth.

To load a TypeScript benchmark without a build step, run the CLI under a TS loader:

```sh
tsx node_modules/@benchsdk/runner/dist/bin.js run sandbox-tti.bench.ts
```

### Context channels

Inside a task the context exposes three separate channels:

- **`step(name, fn, options?)`** — returns `fn`'s value to your code (thread live objects between steps); records the step's timing/status on the platform. Return values are never auto-recorded as data. Set `captureOutput: false` to return an outcome-shaped object (`stdout`, `stderr`, `exitCode`, ...) without writing it to the worker log. Use `parallelInvocations` (formerly `concurrency`) to invoke a step multiple times in parallel.
- **`measure(data)`** — explicit metric channel. Called inside a `step()` it merges into that step's data; called at task top-level it merges into the task record. A task with no explicit steps is recorded as one implicit `'task'` step carrying its measurements.
- **`log(message, metaOrOptions?)`** — human-readable narration to the run timeline. `metaOrOptions` can be a metadata JSON object or `{ level: 'debug' | 'info' | 'warn' | 'error', meta?: JsonObject }`.

## Optional continuous scoring

The existing `config.scoring` accepts two optional fields (also supported by
`scoringConfigToSpec`, `score` and the `onScore` metric helpers):

```ts
scoring: {
  precision: 'full',
  metrics: [{
    key: 'latencyMs',
    ceiling: 2000,
    transform: { kind: 'reciprocal', reference: 2000 },
    weights: { median: 0.6, p95: 0.3, p99: 0.1 },
  }],
}
```

Absent flags preserve linear bounds and two-decimal final rounding.
`precision: 'full'` retains the final composite double, including for linear
metrics; a transform without full precision still rounds the final composite.
This does not change display formatting or guarantee unique ranks.

After the existing raw sample trimming and percentile computation, a reciprocal
metric replaces its linear floor/ceiling calculation with `100 / (1 + x / R)`
for lower-is-better, or `x === 0 ? 0 : 100 / (1 + R / x)` for higher-is-better.
`R` is the positive finite reference; the ceiling stays in the spec for existing
type compatibility. Raw percentile direction, completed-task samples, success
gates, weights, grouping and measured zero retain their existing meanings.
This is not a per-sample transform or an arbitrary nonlinear callback.

Unknown precision, unknown/extra transform fields and invalid references throw
`ScoringSpecError`. When either new field is used and success rate is positive,
every present metric must have finite, nonnegative positive-weight statistics.
A metric with no eligible samples is omitted as before and contributes zero;
no measured timing zero is invented and its weight is not redistributed.
This preserves sparse idle-resume groups and unrequested/failed concurrency
levels. Zero-weight diagnostics need not have samples. All-failed is
still observed zero; no-record rows remain skipped. Weight validation for the
new fields rejects missing, nonfinite and negative components.

For declarative `config.scoring`, `defineBenchmarkConfig` rejects invalid new
fields as a `BenchmarkConfigError`. `runBenchmark` also validates these fields
before authentication, client setup or task execution, including dry runs and
configs supplied without `defineBenchmarkConfig`. Required sample/statistic
validation still happens after measurements are collected; callback `onScore`
specs are validated when scored.

The existing summary upload saves the mathematical spec. Matching platform
support is required so ingestion recomputes the same arithmetic; suite adoption
requires a normal compatible package release and must fail fast on an old runner
that would ignore new fields. No version registry, nullable client change,
publication, historical rescore or workload is introduced here. The fixed
`src/__tests__/fixtures/continuous-scoring.json` table is shared byte-for-byte
with platform tests; it is synthetic offline evidence, not provider measurements.
The byte-identical `continuous-sparse.json` fixtures also exercise the suite's
actual idle/concurrency configurations, grouping, unsupported/no-latency cases,
requested subsets and status-filtered failures.

## Platform data commands

`bench` is a unified CLI. Besides `bench run`, it can authenticate and query the platform:

```sh
bench check <file.bench.ts>
bench auth login
bench benchmarks list
bench runs list <slug>
bench results <slug> --run <runId>
bench artifacts list <slug> <runId>
bench export <slug> --out ./exports
```

See the [benchsdk-cli skill](../../.agents/skills/benchsdk-cli/SKILL.md) for the full CLI reference, OAuth device-code login, config/credentials files, and CI use.

## Examples and full guide

For a step-by-step authoring guide and runnable examples covering every capability, see [`WRITING_BENCHMARKS.md`](../../WRITING_BENCHMARKS.md) and the [`examples/`](../../examples) directory.

## License

MIT
