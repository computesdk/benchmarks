# @benchsdk/runner

## 0.3.0

### Minor Changes

- 776049c: Adds an optional `display` manifest to `BenchmarkConfig` and makes `scoring.metrics` unit metadata derive from it.

  - `BenchmarkConfig.display` lets authors declare metric labels, units, decimals, ranking direction, step labels, and overview defaults (`defaultMetric`, `defaultLayout`) in the same `*.bench.ts` file that defines the workload.
  - `defineBenchmarkConfig` validates the manifest shape and rejects mismatches, including `display.overview.defaultMetric` that is not declared in `display.metrics`.
  - `scoring.metrics[i].unit` is now optional; `scoringConfigToSpec` resolves each scoring metric's unit from the matching `display.metrics` entry, falling back to the scoring metric's unit or an empty string.
  - The runner uploads `display`/`scoring` into `benchmarks.config` on upsert and includes `scoring` in the run summary payload.
  - `create-bench` now scaffolds a `display` block alongside its `scoring` block.

- 8a9c745: Splits the monolithic benchsdk into focused packages and migrates the runner onto them.

  - Adds `@benchsdk/api`: a typed REST API client plus shared platform types (previously internal to `@benchsdk/client`).
  - Adds `@benchsdk/worker`: `runWorker`, `BenchmarkReporter`, system metrics collection, and participant selection.
  - Keeps `@benchsdk/client` as a backwards-compatible umbrella that re-exports the focused packages and exposes `client.runWorker()`.
  - Migrates `@benchsdk/runner` from `@benchsdk/client` to depend directly on `@benchsdk/api` and `@benchsdk/worker`.
  - Introduces declarative `BenchmarkScoringConfig`, `scoringConfigToSpec`, and `validateBenchmarkScoringConfig`; the runner upserts `benchmark.config.scoring` and falls back to the config when `onScore` is omitted.
  - Adds `scoring.groupBy` and `config.dimensions` so task records can be grouped by a dimension key and scored separately.
  - Sends the resolved run config to the platform at run creation.

- 8a9c745: `createBenchmarkClient` now requires a platform API key or OAuth token. It throws a clear error when neither `apiKey`/`token` is provided nor `BENCHMARKS_PLATFORM_API_KEY`/`BENCHMARKS_PLATFORM_TOKEN` is set, pointing users to create a key at https://platform.computesdk.com in their organization settings.

  `@benchsdk/cli` no longer allows commands to proceed without credentials. `resolveAuth` now fails fast with an `AuthError` in every mode, realigns auth precedence so explicit overrides and environment variables take precedence over saved OAuth, and supports saved API keys. It also exports `resolveAuth`, `createApiClient`, `AuthError`, and the `CliAuth` type.

  `bench run` uses the shared `resolveAuth` flow and now validates auth before participants, even with `--dry-run` / `--no-ingest` / `BENCHSDK_NO_INGEST=1` (those flags only skip uploading). Round-mode runs now propagate org headers correctly, and dry-run scoring is guarded so it only happens when a real platform run would be submitted.

  `BenchmarkReporter.claim` now catches the missing-credential error from `createBenchmarkClient` and returns `null` instead of rejecting, matching its existing "no work available" return contract.

- 8a9c745: Adds `--no-ingest` / `BENCHSDK_NO_INGEST=1` dry-run mode to `bench run`.

  The benchmark executes locally but skips uploading results to the platform, making it possible to run without creating a platform run. Note: platform auth is still required for every `bench run` invocation (see the auth changeset).

- 8c62af2: Respect `concurrency` in `groupBy: 'round'` mode.

  - `runGroupedByRound` now runs each round's participants concurrently up to `resolved.concurrency` instead of sequentially.
  - Added an internal `runWithConcurrency` helper to bound parallel tasks without adding a new dependency.
  - Preserves round-robin fairness: all Nth probes across gateways still start at roughly the same wall-clock time, while rounds stay sequential.

- 8a9c745: Adds system metrics collection to benchmark workers.

  - `runWorker` accepts a `metricsIntervalMs` option (default 30s, overridable via `BENCHMARK_METRICS_INTERVAL_MS`) that samples process CPU/memory, event loop lag, load average, socket counts, plus host-wide `/proc/meminfo` and `/proc/stat` metrics and cgroup v1/v2 limits.
  - Captures a baseline sample at worker claim so fast-finishing workers still record data.
  - Rejects invalid metrics sampling intervals.
  - Takes the minimum cgroup limit across ancestor levels.
  - In `groupBy: 'round'` mode, samples once per round and uploads the `system-metrics` artifact alongside the coordinator log.
  - Extends `@benchsdk/api` types to support system metric samples and artifact tagging.

- ca2db57: `score()` now validates that a scoring spec's declared metric weights (`weights.median + weights.p95 + weights.p99`, summed across every metric in `onScore`'s returned `metrics` array) total 1.0, throwing the newly-exported `ScoringSpecError` if they don't — previously a misconfigured spec would silently produce a `compositeScore` that had drifted off its advertised 0-100 scale.

  `bench run` now fails when this happens: `runner.ts`'s `onScore`/`submitRunSummary` catch block re-throws `ScoringSpecError` specifically, so a benchmark with a broken weight sum fails its own run/CI job instead of the error being swallowed into a warning. Every other error in that path (a transient `submitRunSummary` failure, a network blip) keeps the existing warn-and-continue behavior, unchanged.

  Also exports `validateScoringSpec(spec)` directly, so the check can be run standalone (e.g. in a test) without a full `BenchmarkRunOutcome`.

### Patch Changes

- 8a9c745: `bench run` now emits canonical ISO-formatted log lines with `[task N] [level]` prefixes from the runner log buffer.
- 8a9c745: Introduces the `@benchsdk/cli` package and unifies platform commands under the `bench` binary.

  - Adds `@benchsdk/cli`: a reusable library for authenticating against the benchmarks platform and querying benchmarks, runs, results, and artifacts.
  - Implements device-code OAuth login with refresh-token storage in `~/.benchsdk/credentials.json` plus `~/.benchsdk/config.json` for base URL / org / output format defaults.
  - Adds `bench auth`, `bench org`, `bench benchmarks`, `bench runs`, `bench results`, `bench artifacts`, and `bench export` subcommands.
  - Refactors `@benchsdk/runner`'s binary to delegate platform commands to the new CLI library while keeping `bench run <file.bench.ts>` as the benchmark execution path.

- cc99d1b: Resolve two Devin Review findings for `BenchmarkConfig.display` support.

  - `score()` now resolves a missing `ScoringSpec` metric unit from the matching `display.metrics` entry, so `onScore` callbacks that omit `unit` still produce correct units in run summaries.
  - `defineBenchmarkConfig` rejects unknown keys in `display`, `display.metrics`, `display.steps`, and `display.overview`.

- 8a9c745: Cleans up the benchsdk public surface and legacy auth fallbacks.

  - Removes the legacy `COMPUTESDK_API_KEY` environment fallback from `@benchsdk/api`, `@benchsdk/cli`, and `@benchsdk/runner`; only `BENCHMARKS_PLATFORM_API_KEY` is used.
  - Removes the `COMPUTESDK_ADMIN_API_KEY` concept and related admin-key paths.
  - Tightens CLI flag validation and sanitizes scaffold names in `@benchsdk/runner`.
  - Fixes `TaskError` cross-bundle recognition so error names, codes, and data serialize correctly across the worker boundary.
  - Trims the `@benchsdk/client` umbrella exports to match the focused-package re-exports.

- 8a9c745: Bug fixes for worker and runner result handling.

  - `BenchmarkReporter` now fails the worker process when the final result flush cannot send results instead of silently swallowing the error.
  - Tightens `isStepOutcome` in both the worker and runner to avoid misclassifying benchmark result objects, preserving `TaskError` domain data on failure records.

- 8a9c745: Improves worker logging, step capture, and artifact handling.

  - Adds leveled log output (`debug`, `info`, `warn`, `error`) to `runWorker`.
  - Captures named step output and buffers logs incrementally.
  - Compresses log artifacts with gzip before upload.
  - Adds worker artifact download support in `@benchsdk/api`.
  - Updates `@benchsdk/client` to re-export the new logging types and helpers.

- Updated dependencies [8a9c745]
- Updated dependencies [8a9c745]
- Updated dependencies [8a9c745]
- Updated dependencies [8a9c745]
- Updated dependencies [8a9c745]
- Updated dependencies [8a9c745]
- Updated dependencies [8a9c745]
  - @benchsdk/cli@0.2.0
  - @benchsdk/api@0.2.0
  - @benchsdk/worker@0.2.0

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
