# @benchsdk/client

## 0.5.1

### Patch Changes

- @benchsdk/runner@0.5.1

## 0.5.0

### Minor Changes

- 501d260: Fold operator surface into `@benchsdk/runner` and add ergonomics/observability helpers.

  - `@benchsdk/runner` is now the canonical operator package; `@benchsdk/client` is a compatibility re-export shim and a thin `createBenchmarkClient` wrapper.
  - Rename `TaskStepOptions.concurrency` to `parallelInvocations` (old name still accepted with a deprecation warning).
  - `runWorker` is now a free function; `createBenchmarkClient().runWorker()` remains available via `@benchsdk/client`.
  - Add `runBenchmarkWorker(options)` one-shot helper for running a single participant's worker without a `*.bench.ts` file.
  - Add `bench check <file.bench.ts>` for preflight validation of config, auth, participants, and scoring weights.
  - Add `bench run --check` to validate before executing.
  - Add `validateBenchmarkConfig(config)` returning structured `{ field, message }[]`; `defineBenchmarkConfig` throws `BenchmarkConfigError`.
  - Add `defineOnComplete(handler)` typed helper for `onComplete` callbacks.
  - Default `RunWorkerOptions.processKey` to `os.hostname()`.
  - Add `RunWorkerOptions.onTelemetryError` / `BenchmarkReporterConfig.onTelemetryError` callbacks for heartbeat/log-upload/artifact telemetry failures.
  - Worker telemetry failures now emit `console.warn` by default instead of failing silently.
  - `TaskError` now includes `step`, `timeoutMs`, and participant context for step timeouts.
  - `create-bench` scaffold and README now reference `@benchsdk/runner` instead of the deprecated `@benchsdk/client` entrypoint.
  - `@benchsdk/cli` now has a README documenting its programmatic API, auth precedence, config/credentials files, and CLI commands.
  - `@benchsdk/cli` `printData` now honors `--format table` for objects as well as arrays and prints `No results.` for empty objects.
  - `@benchsdk/runner` re-exports `resolveAuth`, `createApiClient`, `AuthError`, and the `CliAuth` type from `@benchsdk/cli` so operators only need one package import.
  - `@benchsdk/worker` `onTelemetryError` is now also invoked for `completeWorker` and `failWorker` telemetry failures in the normal completion path.
  - `bench check` now extracts and validates `--base-url` and `--api-key` flags with required-value semantics instead of treating them as pass-through custom flags.
  - `validateBenchmarkConfig` no longer throws when `phases`, `participants`, or `shapes` entries are `null`/primitives; it returns structured `BenchmarkConfigErrorItem` issues instead.
  - `filterParticipantsByEnv` now treats a missing `requiredEnvVars` as an empty list and guards against non-array values, so omitted or malformed participant env lists no longer crash runs.

### Patch Changes

- Updated dependencies [501d260]
  - @benchsdk/runner@0.5.0

## 0.4.4

### Patch Changes

- Updated dependencies [1f3555b]
  - @benchsdk/api@0.5.0
  - @benchsdk/worker@0.2.4

## 0.4.3

### Patch Changes

- Updated dependencies [43eb478]
  - @benchsdk/api@0.4.1
  - @benchsdk/worker@0.2.3

## 0.4.2

### Patch Changes

- Updated dependencies [6f37302]
  - @benchsdk/api@0.4.0
  - @benchsdk/worker@0.2.2

## 0.4.1

### Patch Changes

- Updated dependencies [0b1916f]
  - @benchsdk/api@0.3.0
  - @benchsdk/worker@0.2.1

## 0.4.0

### Minor Changes

- 8a9c745: Splits the monolithic benchsdk into focused packages and migrates the runner onto them.

  - Adds `@benchsdk/api`: a typed REST API client plus shared platform types (previously internal to `@benchsdk/client`).
  - Adds `@benchsdk/worker`: `runWorker`, `BenchmarkReporter`, system metrics collection, and participant selection.
  - Keeps `@benchsdk/client` as a backwards-compatible umbrella that re-exports the focused packages and exposes `client.runWorker()`.
  - Migrates `@benchsdk/runner` from `@benchsdk/client` to depend directly on `@benchsdk/api` and `@benchsdk/worker`.
  - Introduces declarative `BenchmarkScoringConfig`, `scoringConfigToSpec`, and `validateBenchmarkScoringConfig`; the runner upserts `benchmark.config.scoring` and falls back to the config when `onScore` is omitted.
  - Adds `scoring.groupBy` and `config.dimensions` so task records can be grouped by a dimension key and scored separately.
  - Sends the resolved run config to the platform at run creation.

- 8a9c745: Cleans up the benchsdk public surface and legacy auth fallbacks.

  - Removes the legacy `COMPUTESDK_API_KEY` environment fallback from `@benchsdk/api`, `@benchsdk/cli`, and `@benchsdk/runner`; only `BENCHMARKS_PLATFORM_API_KEY` is used.
  - Removes the `COMPUTESDK_ADMIN_API_KEY` concept and related admin-key paths.
  - Tightens CLI flag validation and sanitizes scaffold names in `@benchsdk/runner`.
  - Fixes `TaskError` cross-bundle recognition so error names, codes, and data serialize correctly across the worker boundary.
  - Trims the `@benchsdk/client` umbrella exports to match the focused-package re-exports.

- 8a9c745: Improves worker logging, step capture, and artifact handling.

  - Adds leveled log output (`debug`, `info`, `warn`, `error`) to `runWorker`.
  - Captures named step output and buffers logs incrementally.
  - Compresses log artifacts with gzip before upload.
  - Adds worker artifact download support in `@benchsdk/api`.
  - Updates `@benchsdk/client` to re-export the new logging types and helpers.

### Patch Changes

- Updated dependencies [8a9c745]
- Updated dependencies [8a9c745]
- Updated dependencies [8a9c745]
- Updated dependencies [8a9c745]
- Updated dependencies [8a9c745]
- Updated dependencies [8a9c745]
- Updated dependencies [8a9c745]
  - @benchsdk/api@0.2.0
  - @benchsdk/worker@0.2.0

## 0.3.0

### Minor Changes

- 1769324: Add participant helpers to the public API: the `BaseParticipant` type plus `selectParticipants()` (filter by `--provider` names) and `filterParticipantsByEnv()` (split participants by whether their `requiredEnvVars` are set).
- 9ec0632: Make `@benchsdk/client` a pure REST + worker-engine package. The benchmark authoring factories `defineStep`, `defineTask`, `defineWorker`, `defineBench`, and the `runBenchmarkWorker` free function have been removed — that authoring model now lives in `@benchsdk/runner`. `client.runWorker({ task })` now accepts a raw `TaskFunction` whose context exposes `step(...)` (imperative named steps), `measure(data)` (explicit metrics — merged into the active step's data, or the task record outside a step; a task with no explicit steps is recorded as one implicit `'task'` step carrying its measurements, and measurements are preserved when a task throws), and `log(message, meta?)` (buffered per worker and uploaded once as a `worker.log` artifact). `createBenchmarkClient`, the REST methods, `BenchmarkReporter`, and the system-metrics collector are unchanged.
- 3c42cdf: `createRun` accepts an optional `runKey`: callers passing the same key (per org + benchmark) get-or-create one shared run instead of each opening its own. `BenchmarkRun.runKey` reports the key a run was created with.
- 8452931: Adds `submitRunSummary(benchmarkSlug, runId, input)` to `BenchmarkClient`, plus `BenchmarkRunSummaryInput`, `BenchmarkRunSummaryRunMetadata`, `BenchmarkRunSummaryResult`, `BenchmarkRunSummaryMetric`, and `BenchmarkRunSummaryScalar` types. Posts to `POST /benchmarks/{slug}/runs/{runId}/summary`.
- 3c42cdf: `createRun` no longer requires `totalTasks`: omit it to open a participant-sized run, whose total is the sum of what its participants declare when they register. `BenchmarkRun.participantSized` reports which kind a run is.

## 0.2.1

### Patch Changes

- 9f16e68: Initial publication of the `@benchsdk/client` npm package, consolidated out of the `computesdk` monorepo (formerly `@computesdk/bench`). Same public API surface (`createBenchmarkClient`, `defineStep`/`defineTask`/`defineWorker`/`defineBench`, `BenchmarkReporter`, `createSystemMetricsCollector`); only the source repository and npm publish name changed.
