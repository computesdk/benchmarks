# @benchsdk/runner

## 0.3.0 (unreleased)

### BREAKING

- `TaskStepOptions.concurrency` is renamed to `TaskStepOptions.parallelInvocations` to avoid ambiguity with `config.concurrency` (max in-flight tasks). The old `concurrency` field is still accepted for backwards compatibility but logs a deprecation warning.
- `runWorker` is now a free function exported from `@benchsdk/runner` / `@benchsdk/worker`: `runWorker(client, options)`. The legacy `createBenchmarkClient().runWorker(options)` spelling remains available through `@benchsdk/client` and `@benchsdk/runner`.

### ADDED

- `runBenchmarkWorker(options)` one-shot operator helper: runs a single participant's worker without creating a `*.bench.ts` file.
- `bench check <file.bench.ts>` CLI command: validates environment variables, API connectivity, participant availability, and scoring weights before a run.
- `validateBenchmarkConfig(config)` returns a `BenchmarkConfigErrorItem[]`; `defineBenchmarkConfig` throws `BenchmarkConfigError` with structured `{ field, message }` issues.
- `defineOnComplete(handler)` helper for typed `onComplete` callbacks.
- `RunWorkerOptions.processKey` defaults to `os.hostname()` when omitted.
- `TaskError` now carries `step`, `timeoutMs`, and participant context for step timeouts.
- `RunWorkerOptions.onTelemetryError` and `BenchmarkReporterConfig.onTelemetryError` callbacks expose heartbeat/log-upload/artifact telemetry failures instead of swallowing them silently.

### FIXED

- Worker telemetry failures now emit a `console.warn` by default instead of failing silently.
- Step timeout diagnostics now include the step name, configured timeout, and participant name.

## 0.2.0

### Minor Changes

- 8452931: Adds `onScore` to `BenchmarkConfig`. The runner invokes `onScore(lowerIsBetter, higherIsBetter)` after a run, computes per-participant composite scores with `score(outcome, spec)`, and posts the scored summary to the platform via `BenchmarkClient.submitRunSummary`. Includes `lowerIsBetter`, `higherIsBetter`, `score`, `MetricScoring`, `ScoringSpec`, and `BenchmarkScoreResult` exports. Existing `onComplete` / legacy `latest.json` flows remain unchanged.
- 3c42cdf: Verbs-only CLI: `bench run <file.bench.ts>` is the one mutating command. The benchmark is declared in the file and materialized (upserted) as a side effect of running it, and a run is opened as a side effect too — there are no imperative `bench create benchmark` / `bench create run` commands.

  `bench run` gains `--shape <name>`: a bench file can declare named `shapes`, each swapping in its own platform identity (`slug`/`name`, optional `kind`) and a stable knob (`staggerDelayMs`) while reusing the same task and participants. This collapses the per-shape slug/name/knob triple that was duplicated across package scripts and CI.

  `bench run` gains `--run-key <key>`: sibling processes passing the same key (per org + benchmark) get-or-create one shared run instead of each opening its own, so provider jobs running in parallel land in a single, directly-comparable run. Each process registers only the participants it runs. The key binding is permanent, so callers that need a fresh run (e.g. a CI re-run) vary the key (e.g. include `GITHUB_RUN_ATTEMPT`).

  `--slug` remains a working alias for `--benchmark`.

### Patch Changes

- 9ec0632: Initial publication of `@benchsdk/runner`, the benchmark authoring framework (renamed from `@benchsdk/cli`). A `*.bench.ts` file exports exactly two things: a **config** (`defineBenchmarkConfig({ benchmarkSlug, iterations, concurrency, participants, onComplete, ... })` — orchestration knobs, the `participants` to run against, and an optional run-level `onComplete` hook) and a **task** (`defineTask(fn)`, the workload for one iteration, with named steps via `ctx.step` supporting closures and `try/finally`). The task context also exposes `ctx.measure(data)` (explicit metric channel — merges into the active step's data, or the task record outside a step; a task with no explicit steps is recorded as one implicit `'task'` step) and `ctx.log(message, meta?)` (timeline narration). The `bench run <file>` CLI owns the entrypoint: it imports the module, reads `config`/`task`, applies CLI overrides (`--iterations`, `--concurrency`, `--stagger-delay-ms`, `--group-by`, `--provider`), and drives the run against `@benchsdk/client`; benchmark files no longer call the runner themselves. `NoAvailableParticipantsError` (every participant env-gated out) exits cleanly. Also exports `TaskError`.
- 9ec0632: `runBenchmark()` now rejects with the exported `NoAvailableParticipantsError` (carrying the `skipped` participants and their missing env vars) instead of a plain `Error` when every participant is env-gated out, so callers can treat an unprovisioned provider as a skip rather than a failure.
- Updated dependencies [1769324]
- Updated dependencies [9ec0632]
- Updated dependencies [3c42cdf]
- Updated dependencies [8452931]
- Updated dependencies [3c42cdf]
  - @benchsdk/client@0.3.0
