# @benchsdk/runner

Benchmark framework for authoring `*.bench.ts` files that report to the benchmarks platform via [`@benchsdk/client`](../benchsdk).

## What it provides

- **`defineBenchmarkConfig`** / **`defineTask`** — A `*.bench.ts` file exports exactly two things: a **config** (`defineBenchmarkConfig`, the orchestration knobs + `participants` + an optional `onComplete` hook) and a **task** (`defineTask`, the workload for one iteration). There is no "mode": the orchestration shape (sequential / staggered / burst) emerges from the `iterations`, `concurrency`, and `staggerDelayMs` knobs, and `groupBy` (`'participant'` | `'round'`) selects the ordering across participants.
- **`bench run <file>`** — The CLI entrypoint. It imports the module, reads its `config` and `task`, applies CLI overrides, and drives the run. Benchmark files declare; they never call the runner themselves.
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

- **`step(name, fn, options?)`** — returns `fn`'s value to your code (thread live objects between steps); records the step's timing/status on the platform. Return values are never auto-recorded as data. Set `captureOutput: false` to return an outcome-shaped object (`stdout`, `stderr`, `exitCode`, ...) without writing it to the worker log.
- **`measure(data)`** — explicit metric channel. Called inside a `step()` it merges into that step's data; called at task top-level it merges into the task record. A task with no explicit steps is recorded as one implicit `'task'` step carrying its measurements.
- **`log(message, metaOrOptions?)`** — human-readable narration to the run timeline. `metaOrOptions` can be a metadata JSON object or `{ level: 'debug' | 'info' | 'warn' | 'error', meta?: JsonObject }`.

## Platform data commands

`bench` is a unified CLI. Besides `bench run`, it can authenticate and query the platform:

```sh
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
