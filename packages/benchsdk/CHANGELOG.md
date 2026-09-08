# @benchsdk/client

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
