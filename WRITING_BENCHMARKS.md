# Writing and Running Benchmarks with benchsdk

This guide explains how to write, run, and report benchmarks using `@benchsdk/runner` and the ComputeSDK benchmarks platform.

If you just want the finished code, jump to the [`examples/`](./examples) directory.

## Quick start

The fastest way to scaffold a new benchmark project is with `create-bench`:

```bash
npx create-bench my-benchmark
cd my-benchmark
pnpm install
pnpm bench
```

That gives you a single `bench.ts` file, a `package.json`, and an `.env.example`.

If you are working inside this repo, you can run any `*.bench.ts` file directly:

```bash
# 1. Build the workspace packages once (packages/*/dist is not committed)
pnpm -r --filter "./packages/**" build

# 2. Run a benchmark locally without uploading to the platform
BENCHMARKS_PLATFORM_API_KEY=bp-... pnpm exec bench run examples/01-hello.bench.ts --dry-run
```

## Platform credentials

To report results to the platform, authenticate with one of:

- `BENCHMARKS_PLATFORM_API_KEY` — a ComputeSDK benchmarks platform API key (an org-scoped `bp_...` key).
- `BENCHMARKS_PLATFORM_TOKEN` — an OAuth session/bearer token (used by the CLI and low-level client).

You can also log in interactively with `bench auth login` to store an OAuth token in `~/.benchsdk/credentials.json`.

To point at a different platform endpoint (for example, a staging environment or local development proxy), also set `BENCHMARKS_PLATFORM_URL` to the root URL (no `/api/v1` suffix; the runner appends it). The default is `https://platform.computesdk.com`.

`--dry-run` / `--no-ingest` / `BENCHSDK_NO_INGEST=1` skip platform uploading/reporting, but a platform API key or OAuth token is still required for every `bench run` invocation.

## Anatomy of a benchmark file

A benchmark file is declarative. It exports **exactly two things**:

```ts
import { defineBenchmarkConfig, defineTask } from '@benchsdk/runner';

export const config = defineBenchmarkConfig({
  benchmarkSlug: 'hello',
  benchmarkName: 'Hello benchmark',
  iterations: 10,
  participants: [{ name: 'local', requiredEnvVars: [] }],
  scoring: {
    metrics: [
      { key: 'durationMs', unit: 'ms', ceiling: 1000, weights: { median: 0.7, p95: 0.2, p99: 0.1 } },
    ],
  },
});

export const task = defineTask(async ({ participant, step, measure, log }) => {
  log('running', { level: 'info', meta: { participant: participant.name } });
  const start = performance.now();
  await step('work', async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  measure({ durationMs: performance.now() - start });
});
```

`bench run <file>` imports the module, reads `config` and `task`, and drives the run. The benchmark file never calls the runner itself.

## `config` — orchestration knobs

| Field | Purpose |
|-------|---------|
| `benchmarkSlug` | Stable platform identifier, e.g. `sandbox-tti`. |
| `benchmarkName` | Human-readable name shown in the dashboard. |
| `shapes` | Named variants (`--shape <name>`) that swap in a different slug/name and a default `staggerDelayMs`. |
| `iterations` | Total tasks per participant. Default `1`. Mutually exclusive with `phases`. |
| `phases` | Named run segments. Total iterations = sum of phase iterations. `ctx.phase` is set inside the task. |
| `concurrency` | Max tasks in flight. `1` = sequential, `N` = burst. Default `1`. |
| `staggerDelayMs` | Delay each task launch by `taskIndex * staggerDelayMs`. Default `0`. |
| `groupBy` | `'participant'` (default) or `'round'`. Round mode interleaves participants so each round runs back-to-back. |
| `participants` | Array of participants with `name`, `requiredEnvVars`, and any custom fields the task needs. |
| `defaultProviders` | Participant names to run when `--provider` is omitted. Omit to run all env-available participants. |
| `dimensions` | Static run-level metadata copied into the run config, e.g. `{ fileSize: '10MB' }`. |
| `scoring` | Serializable scoring spec: metrics, weights, `higherIsBetter`, `floor`, `success.requireData`. |
| `onScore` | Optional run-level hook that returns a `ScoringSpec` using `lowerIsBetter` / `higherIsBetter` helpers. Use when you need function-based value extraction. |
| `onComplete` | Optional run-level hook for aggregate output, e.g. writing legacy JSON. Receives `BenchmarkRunOutcome`. |
| `customCliFlags` | Extra CLI flags the benchmark file reads itself, e.g. `['--file-size']`. Prevents the runner from rejecting them as unknown. |

### Shapes: one file, many benchmark identities

A shape carries the parts of a benchmark that make it a distinct platform benchmark: its slug, display name, and any stable distinguishing knob.

```ts
export const config = defineBenchmarkConfig({
  benchmarkSlug: 'sandbox-tti',
  benchmarkName: 'Sandbox TTI',
  iterations: 1,
  concurrency: 1,
  participants: providers,
  shapes: {
    sequential: { slug: 'sandbox-tti-sequential', name: 'Sandbox TTI (Sequential)' },
    burst: { slug: 'sandbox-tti-burst', name: 'Sandbox TTI (Burst)' },
    staggered: { slug: 'sandbox-tti-staggered', name: 'Sandbox TTI (Staggered)', staggerDelayMs: 200 },
  },
  scoring: { /* ... */ },
});
```

Then run:

```bash
bench run my.bench.ts --shape burst --iterations 100 --concurrency 100
```

`iterations` and `concurrency` are still CLI-overridable scale knobs; a shape should never set them.

### Phases: compare cold vs warm

```ts
export const config = defineBenchmarkConfig({
  benchmarkSlug: 'cache-warmup',
  benchmarkName: 'Cache Warmup',
  phases: [
    { name: 'cold', iterations: 5 },
    { name: 'warm', iterations: 5 },
  ],
  participants: providers,
  scoring: { /* ... */ },
});

export const task = defineTask(async ({ participant, phase, step, measure }) => {
  // phase === 'cold' or 'warm'
  const start = performance.now();
  await step('request', () => makeRequest(participant, { fresh: phase === 'cold' }));
  measure({ durationMs: performance.now() - start });
});
```

The framework automatically tags every record with `data.phase`, so you can group and filter by phase in the platform.

### `groupBy: 'round'` — fair back-to-back comparisons

The default `groupBy: 'participant'` runs one participant to completion, then the next. `groupBy: 'round'` takes turns:

- Participant A task 1
- Participant B task 1
- Participant A task 2
- Participant B task 2

This is useful when you want every participant's Nth iteration to run under the same external conditions (network, time of day, etc.).

```ts
export const config = defineBenchmarkConfig({
  benchmarkSlug: 'ai-gateway',
  benchmarkName: 'AI Gateway Latency',
  iterations: 20,
  groupBy: 'round',
  participants: providers,
  scoring: { /* ... */ },
});
```

## `task` — the workload for one iteration

The task function receives a `TaskContext`:

```ts
import type { BenchmarkLogOptions } from '@benchsdk/api';

interface TaskContext<T extends BaseParticipant> {
  participant: T;
  taskIndex: number;
  phase?: string;
  step: (name, fn, options?) => Promise<R>;
  measure: (data: JsonObject) => void;
  log: (message: string, metaOrOptions?: JsonObject | BenchmarkLogOptions) => void;
}
```

### `step(name, fn, options?)`

Runs `fn` as a named platform step and records its timing and status. Return values flow through closures, so you can use the created resource in later steps.

```ts
const sandbox = await step('create', () => provider.create());
try {
  await step('exec', () => sandbox.runCommand('node -v'));
} finally {
  await step('destroy', () => sandbox.destroy());
}
```

Step options:

| Option | Description |
|--------|-------------|
| `timeoutMs` | Abort and throw a `step_timeout` `TaskError` if the step exceeds this time. |
| `concurrency` | Run `fn` this many times in parallel and return an array. |
| `reportConcurrency` | Whether to include this step in worker heartbeat concurrency samples. Default `true`. |
| `captureOutput` | When `true` (default), a step returning a `BenchmarkStepOutcome`-shaped object (`stdout`, `stderr`, `error`, `exitCode`, `code`, `signal`, `pid`) is captured as step output and appended to the worker log. Set to `false` to return such an object as a normal result. |

### `measure(data)`

Attaches JSON metrics to the current `step` if called inside one, or to the task record if called at the top level.

```ts
await step('upload', async () => {
  const start = performance.now();
  await storage.upload(key, bytes);
  const uploadMs = performance.now() - start;
  measure({ uploadMs, bytes });
});
```

### `log(message, metaOrOptions?)`

Appends a line to the worker log, which is uploaded as an artifact when the worker finishes.

`metaOrOptions` can be a plain JSON metadata object (default level `info`) or `{ level, meta }` with `level: 'debug' | 'info' | 'warn' | 'error'`:

```ts
log('cold start complete', { level: 'info' });
log('skipping remote participant', { level: 'debug', meta: { reason: 'missing env var' } });
```

The worker's `BENCHMARK_LOG_LEVEL` environment variable filters which levels are recorded (default `info`).

### Step return values and `isStepOutcome`

The runner and platform worker inspect each step's return value. If it matches the `BenchmarkStepOutcome` shape, it is captured as step output and appended to the worker log instead of being returned to the task. The guard is strict: the object may contain only the keys `stdout`, `stderr`, `error`, `exitCode`, `code`, `signal`, and `pid`, and at least one of `stdout`, `stderr`, or `error` must be a string.

Use this to capture the output of a spawned command:

```ts
const { stdout, stderr, exitCode } = await step('version', () => ({
  stdout: 'v20.0.0',
  stderr: '',
  exitCode: 0,
}));
```

If you want to return an outcome-shaped object as a normal result, either wrap it or pass `captureOutput: false`:

```ts
const result = await step('version', () => ({
  stdout: 'v20.0.0',
  stderr: '',
  exitCode: 0,
}), { captureOutput: false });

const parsed = await step('parse-version', () => ({ version: '20.0.0' })); // not an outcome shape
```

## Participants and env gating

A participant is any object with `name` and `requiredEnvVars`. Extra fields can be used by the task.

```ts
interface S3Participant {
  name: string;
  requiredEnvVars: string[];
  createStorage: () => Storage;
}

const s3: S3Participant = {
  name: 'aws-s3',
  requiredEnvVars: ['S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'S3_REGION', 'S3_BUCKET'],
  createStorage: () => createS3Storage(),
};
```

At run time, the runner calls `filterParticipantsByEnv` and skips any participant whose env vars are missing. If `--provider` is passed, the runner further filters to that subset and errors on unknown names.

## Shapes of a run

There is no single `mode` switch. The shape of a run emerges from the knobs:

| Shape | Config |
|-------|--------|
| Sequential | `iterations: N, concurrency: 1` |
| Burst | `iterations: N, concurrency: N` |
| Staggered | `iterations: N, concurrency: N, staggerDelayMs: 200` |

## Scoring

`config.scoring` is a serializable spec. The runner computes a composite score from 0–100 per metric and rolls them up into an overall score.

```ts
scoring: {
  metrics: [
    { key: 'ttiMs', unit: 'ms', ceiling: 10000, weights: { median: 0.4, p95: 0.25, p99: 0.15 } },
    { key: 'opsPerSec', unit: 'ops/s', floor: 1, ceiling: 1000, higherIsBetter: true, weights: { median: 0.2, p95: 0, p99: 0 } },
  ],
  success: {
    requireData: { verified: true },
  },
}
```

Rules:

- `weights.median + weights.p95 + weights.p99` across **all metrics** must sum to `1.0` (within 0.01).
- `ceiling` is the worst acceptable value; the score is `100 * (1 - value/ceiling)` for `lowerIsBetter`.
- `higherIsBetter` flips the formula and uses `floor` as the minimum score threshold.
- `success.requireData` makes a record count as successful only when every listed data field matches the given value. Records that fail or do not match lower the success rate.

If you need to extract metric values with a function, use `onScore` instead:

```ts
onScore: (lowerIsBetter) => ({
  metrics: [
    lowerIsBetter('ttiMs', { unit: 'ms', ceiling: 10000, weights: { median: 0.6, p95: 0.25, p99: 0.15 }, value: (record) => record.data?.ttiMs as number }),
  ],
}),
```

## Error handling

Throwing a plain `Error` records the error message and stops the task. To preserve domain data and a custom error code, throw `TaskError`:

```ts
import { defineTask, TaskError } from '@benchsdk/runner';

throw new TaskError('Upload failed', {
  code: 'UPLOAD_FAILED',
  data: { bytesSent: 1024 },
});
```

Use `try/finally` for cleanup so resources are released even when the task fails:

```ts
const sandbox = await step('create', () => provider.create());
try {
  await step('exec', () => sandbox.runCommand('node -v'));
} finally {
  await step('destroy', () => sandbox.destroy()).catch(() => {});
}
```

## Custom CLI flags

If your benchmark needs extra flags, declare them and read them from `process.argv`:

```ts
export const config = defineBenchmarkConfig({
  benchmarkSlug: 'payload-size',
  benchmarkName: 'Payload Size',
  participants: [{ name: 'local', requiredEnvVars: [] }],
  customCliFlags: ['--payload-bytes'],
  scoring: { /* ... */ },
});

function getPayloadBytes(): number {
  const args = process.argv.slice(2);
  const idx = args.indexOf('--payload-bytes');
  return idx !== -1 && args[idx + 1] ? Number(args[idx + 1]) : 1024;
}

export const task = defineTask(async ({ step, measure }) => {
  const bytes = getPayloadBytes();
  const start = performance.now();
  await step('work', () => hashRandomBytes(bytes));
  measure({ durationMs: performance.now() - start });
});
```

Run with:

```bash
bench run payload.bench.ts --payload-bytes 4096 --iterations 10
```

## `onComplete` — aggregate output

`onComplete` fires once after all participants finish and receives the full `BenchmarkRunOutcome`:

```ts
import type { BenchmarkRunOutcome } from '@benchsdk/runner';

onComplete: (outcome: BenchmarkRunOutcome) => {
  console.log(`Run ${outcome.runId} finished`);
  console.log(`Dashboard: ${outcome.dashboardUrl}`);
  for (const { participant, records } of outcome.participants) {
    const success = records.filter((r) => r.status === 'success').length;
    console.log(`  ${participant}: ${success}/${records.length}`);
  }
},
```

## CLI reference

```bash
bench run <file.bench.ts> [flags]
```

| Flag | Description |
|------|-------------|
| `--dry-run`, `--no-ingest` | Skip uploading to the platform (still requires auth). |
| `--provider a,b` | Run only the named participants. Repeatable. |
| `--iterations N` | Override total iterations (per phase when phases exist). |
| `--concurrency N` | Override max in-flight tasks. |
| `--stagger-delay-ms N` | Override stagger delay. |
| `--group-by participant\|round` | Override task ordering. |
| `--shape name` | Use a declared shape. |
| `--benchmark slug` | Report under a different platform slug. |
| `--name "..."` | Override display name. |
| `--run-key key` | Share one run across sibling processes (one per provider, for example). |

### Querying the platform

`bench` is a unified CLI: `bench run` executes benchmark files, and the remaining commands query platform data.

```bash
bench auth login
bench auth status
bench org list
bench org use <slug>
bench benchmarks list
bench runs list <benchmark-slug>
bench runs show <benchmark-slug> <runId>
bench results <benchmark-slug> [--run <runId>]
bench artifacts list <benchmark-slug> <runId>
bench export <benchmark-slug> --out ./exports
```

See [.agents/skills/benchsdk-cli/SKILL.md](.agents/skills/benchsdk-cli/SKILL.md) for the full CLI reference, OAuth device-code login, config/credentials files, and non-interactive/CI use.

### Multi-process runs with `--run-key`

When one CI job per provider needs to contribute to the same run, each process passes the same `--run-key`. The first creates the run; later processes attach:

```bash
bench run tti.bench.ts --provider e2b   --run-key "$GITHUB_RUN_ID" &
bench run tti.bench.ts --provider modal --run-key "$GITHUB_RUN_ID" &
wait
```

## Examples

See the [`examples/`](./examples) directory for runnable benchmarks covering every capability:

1. `01-hello.bench.ts` — minimal sequential benchmark.
2. `02-shapes.bench.ts` — sequential, burst, and staggered shapes.
3. `03-phases.bench.ts` — cold/warm phases.
4. `04-round-robin.bench.ts` — `groupBy: 'round'`.
5. `05-scoring.bench.ts` — multiple metrics and `success.requireData`.
6. `06-custom-flags.bench.ts` — custom CLI flags and dimensions.
7. `07-error-handling.bench.ts` — `TaskError`, timeouts, `try/finally`, and leveled logs.
8. `08-env-gated.bench.ts` — `requiredEnvVars` and `defaultProviders`.
9. `09-on-complete.bench.ts` — `onComplete` aggregate output.
10. `10-shared-run.bench.ts` — `--run-key`.
11. `11-logging.bench.ts` — structured `log` levels, step output capture, and `captureOutput`.

Run any example locally:

```bash
BENCHMARKS_PLATFORM_API_KEY=bp-... pnpm exec bench run examples/01-hello.bench.ts --dry-run
```

## Common gotchas

- **Build first.** `packages/*/dist` is not committed. Run `pnpm -r --filter "./packages/**" build` before running or typechecking.
- **`iterations` with phases.** With `phases`, `--iterations` scales each phase equally, not the total. A benchmark with uneven phase counts ignores `--iterations`.
- **Participants are filtered by env.** If a participant is skipped, the runner logs which env vars are missing. If every participant is skipped, the run exits cleanly with `NoAvailableParticipantsError`.
- **Scoring weights sum to 1.0.** The runner validates this at config-evaluation time.
- **Step return values that look like `{ stdout, stderr, error }`.** The runner treats them as step output and writes them to the worker log. To return them as a result, either wrap the data under a different key or pass `captureOutput: false` to `step`.
- **Round mode and pre-measured steps.** In `groupBy: 'round'` the runner builds records manually and honors `TaskResult.steps` and `TaskResult.latencyMs`. This is useful for socket-level probes that measure sub-step timing themselves. In `groupBy: 'participant'` the platform worker owns the steps, so `steps`/`latencyMs` are ignored.
