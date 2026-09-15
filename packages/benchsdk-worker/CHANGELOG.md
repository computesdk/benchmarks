# @benchsdk/worker

## 0.3.0

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
  - @benchsdk/api@0.6.0

## 0.2.4

### Patch Changes

- Updated dependencies [1f3555b]
  - @benchsdk/api@0.5.0

## 0.2.3

### Patch Changes

- Updated dependencies [43eb478]
  - @benchsdk/api@0.4.1

## 0.2.2

### Patch Changes

- Updated dependencies [6f37302]
  - @benchsdk/api@0.4.0

## 0.2.1

### Patch Changes

- Updated dependencies [0b1916f]
  - @benchsdk/api@0.3.0

## 0.2.0

### Minor Changes

- 8a9c745: Splits the monolithic benchsdk into focused packages and migrates the runner onto them.

  - Adds `@benchsdk/api`: a typed REST API client plus shared platform types (previously internal to `@benchsdk/client`).
  - Adds `@benchsdk/worker`: `runWorker`, `BenchmarkReporter`, system metrics collection, and participant selection.
  - Keeps `@benchsdk/client` as a backwards-compatible umbrella that re-exports the focused packages and exposes `client.runWorker()`.
  - Migrates `@benchsdk/runner` from `@benchsdk/client` to depend directly on `@benchsdk/api` and `@benchsdk/worker`.
  - Introduces declarative `BenchmarkScoringConfig`, `scoringConfigToSpec`, and `validateBenchmarkScoringConfig`; the runner upserts `benchmark.config.scoring` and falls back to the config when `onScore` is omitted.
  - Adds `scoring.groupBy` and `config.dimensions` so task records can be grouped by a dimension key and scored separately.
  - Sends the resolved run config to the platform at run creation.

- 8a9c745: Adds system metrics collection to benchmark workers.

  - `runWorker` accepts a `metricsIntervalMs` option (default 30s, overridable via `BENCHMARK_METRICS_INTERVAL_MS`) that samples process CPU/memory, event loop lag, load average, socket counts, plus host-wide `/proc/meminfo` and `/proc/stat` metrics and cgroup v1/v2 limits.
  - Captures a baseline sample at worker claim so fast-finishing workers still record data.
  - Rejects invalid metrics sampling intervals.
  - Takes the minimum cgroup limit across ancestor levels.
  - In `groupBy: 'round'` mode, samples once per round and uploads the `system-metrics` artifact alongside the coordinator log.
  - Extends `@benchsdk/api` types to support system metric samples and artifact tagging.

- 8a9c745: Improves worker logging, step capture, and artifact handling.

  - Adds leveled log output (`debug`, `info`, `warn`, `error`) to `runWorker`.
  - Captures named step output and buffers logs incrementally.
  - Compresses log artifacts with gzip before upload.
  - Adds worker artifact download support in `@benchsdk/api`.
  - Updates `@benchsdk/client` to re-export the new logging types and helpers.

### Patch Changes

- 8a9c745: `createBenchmarkClient` now requires a platform API key or OAuth token. It throws a clear error when neither `apiKey`/`token` is provided nor `BENCHMARKS_PLATFORM_API_KEY`/`BENCHMARKS_PLATFORM_TOKEN` is set, pointing users to create a key at https://platform.computesdk.com in their organization settings.

  `@benchsdk/cli` no longer allows commands to proceed without credentials. `resolveAuth` now fails fast with an `AuthError` in every mode, realigns auth precedence so explicit overrides and environment variables take precedence over saved OAuth, and supports saved API keys. It also exports `resolveAuth`, `createApiClient`, `AuthError`, and the `CliAuth` type.

  `bench run` uses the shared `resolveAuth` flow and now validates auth before participants, even with `--dry-run` / `--no-ingest` / `BENCHSDK_NO_INGEST=1` (those flags only skip uploading). Round-mode runs now propagate org headers correctly, and dry-run scoring is guarded so it only happens when a real platform run would be submitted.

  `BenchmarkReporter.claim` now catches the missing-credential error from `createBenchmarkClient` and returns `null` instead of rejecting, matching its existing "no work available" return contract.

- 8a9c745: Cleans up the benchsdk public surface and legacy auth fallbacks.

  - Removes the legacy `COMPUTESDK_API_KEY` environment fallback from `@benchsdk/api`, `@benchsdk/cli`, and `@benchsdk/runner`; only `BENCHMARKS_PLATFORM_API_KEY` is used.
  - Removes the `COMPUTESDK_ADMIN_API_KEY` concept and related admin-key paths.
  - Tightens CLI flag validation and sanitizes scaffold names in `@benchsdk/runner`.
  - Fixes `TaskError` cross-bundle recognition so error names, codes, and data serialize correctly across the worker boundary.
  - Trims the `@benchsdk/client` umbrella exports to match the focused-package re-exports.

- 8a9c745: Bug fixes for worker and runner result handling.

  - `BenchmarkReporter` now fails the worker process when the final result flush cannot send results instead of silently swallowing the error.
  - Tightens `isStepOutcome` in both the worker and runner to avoid misclassifying benchmark result objects, preserving `TaskError` domain data on failure records.

- Updated dependencies [8a9c745]
- Updated dependencies [8a9c745]
- Updated dependencies [8a9c745]
- Updated dependencies [8a9c745]
- Updated dependencies [8a9c745]
- Updated dependencies [8a9c745]
  - @benchsdk/api@0.2.0
