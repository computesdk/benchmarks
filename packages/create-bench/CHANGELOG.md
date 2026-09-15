# create-bench

## 0.1.3

### Patch Changes

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

## 0.1.2

### Patch Changes

- 776049c: Adds an optional `display` manifest to `BenchmarkConfig` and makes `scoring.metrics` unit metadata derive from it.

  - `BenchmarkConfig.display` lets authors declare metric labels, units, decimals, ranking direction, step labels, and overview defaults (`defaultMetric`, `defaultLayout`) in the same `*.bench.ts` file that defines the workload.
  - `defineBenchmarkConfig` validates the manifest shape and rejects mismatches, including `display.overview.defaultMetric` that is not declared in `display.metrics`.
  - `scoring.metrics[i].unit` is now optional; `scoringConfigToSpec` resolves each scoring metric's unit from the matching `display.metrics` entry, falling back to the scoring metric's unit or an empty string.
  - The runner uploads `display`/`scoring` into `benchmarks.config` on upsert and includes `scoring` in the run summary payload.
  - `create-bench` now scaffolds a `display` block alongside its `scoring` block.

## 0.1.1

### Patch Changes

- 292ee1b: Initial publication of `create-bench`, a CLI scaffolding tool for new ComputeSDK benchmark projects. Run `npx create-bench my-benchmark` to bootstrap a worker with `@benchsdk/client`.
