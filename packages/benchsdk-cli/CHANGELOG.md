# @benchsdk/cli

## 0.6.1

### Patch Changes

- Updated dependencies [6868819]
  - @benchsdk/api@0.7.1

## 0.6.0

### Minor Changes

- f0574f0: Add `getParticipantLogs` to `@benchsdk/api` and a `bench logs` command for viewing parsed participant worker logs (the dashboard log view) via the platform's new `GET .../participants/:slug/logs` endpoint:

  ```
  bench logs <slug> <runId> [--participant <slug>] [--worker <id>] [--max-lines N]
  ```

### Patch Changes

- Updated dependencies [f0574f0]
  - @benchsdk/api@0.7.0

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
  - @benchsdk/api@0.6.0

## 0.4.2

### Patch Changes

- 1f3555b: Run-list responses are now slimmer: `listRuns`/`listAllRuns` return `BenchmarkRunListItem` (id, benchmarkId, organizationId, name, status, sizing, timestamps, organizationSlug, benchmarkSlug) instead of the full run row — `config`, `summary`, `runKey`, `participantSized`, and creator attribution are no longer included. `BenchmarkResource` gains optional `organizationId`/`organizationSlug` for the catalog response.
- Updated dependencies [1f3555b]
  - @benchsdk/api@0.5.0

## 0.4.1

### Patch Changes

- 43eb478: `listAllRuns` now calls the canonical `GET /api/v1/benchmarks/runs` — the platform moved the endpoint under `/benchmarks/` and the old `/api/v1/runs` path was removed.
- Updated dependencies [43eb478]
  - @benchsdk/api@0.4.1

## 0.4.0

### Minor Changes

- 6f37302: List runs across all visible benchmarks.

  - New `client.listAllRuns({ limit?, offset?, benchmarkSlug? })` hitting `GET /api/v1/runs`; items are `BenchmarkRunListItem` (run row + `organizationSlug` + `benchmarkSlug`).
  - `bench runs list` now takes an optional slug: `bench runs list` lists every run the caller can read (own + subscribed benchmarks); `bench runs list <slug>` is unchanged.

### Patch Changes

- Updated dependencies [6f37302]
  - @benchsdk/api@0.4.0

## 0.3.0

### Minor Changes

- 0b1916f: Expose per-iteration benchmark results and sandbox reuse metadata.

  - `@benchsdk/api` adds `getRunTaskIterations` and `getRunStepIterations` plus the `BenchmarkRunIterationInput`, `BenchmarkTaskIteration`, `BenchmarkStepIteration`, `BenchmarkRunTaskIterations`, and `BenchmarkRunStepIterations` types.
  - `@benchsdk/cli` adds `bench iterations <benchmark-slug> --run <id> [--participant <slug>] [--steps <list>] [--format json|table]`.
  - `benchmarks/sandbox/tti.bench.ts` records `sandboxId`, `createdAt`, and `createMs` in the `create` step for sandbox reuse detection.

### Patch Changes

- Updated dependencies [0b1916f]
  - @benchsdk/api@0.3.0

## 0.2.0

### Minor Changes

- 8a9c745: Introduces the `@benchsdk/cli` package and unifies platform commands under the `bench` binary.

  - Adds `@benchsdk/cli`: a reusable library for authenticating against the benchmarks platform and querying benchmarks, runs, results, and artifacts.
  - Implements device-code OAuth login with refresh-token storage in `~/.benchsdk/credentials.json` plus `~/.benchsdk/config.json` for base URL / org / output format defaults.
  - Adds `bench auth`, `bench org`, `bench benchmarks`, `bench runs`, `bench results`, `bench artifacts`, and `bench export` subcommands.
  - Refactors `@benchsdk/runner`'s binary to delegate platform commands to the new CLI library while keeping `bench run <file.bench.ts>` as the benchmark execution path.

- 8a9c745: `createBenchmarkClient` now requires a platform API key or OAuth token. It throws a clear error when neither `apiKey`/`token` is provided nor `BENCHMARKS_PLATFORM_API_KEY`/`BENCHMARKS_PLATFORM_TOKEN` is set, pointing users to create a key at https://platform.computesdk.com in their organization settings.

  `@benchsdk/cli` no longer allows commands to proceed without credentials. `resolveAuth` now fails fast with an `AuthError` in every mode, realigns auth precedence so explicit overrides and environment variables take precedence over saved OAuth, and supports saved API keys. It also exports `resolveAuth`, `createApiClient`, `AuthError`, and the `CliAuth` type.

  `bench run` uses the shared `resolveAuth` flow and now validates auth before participants, even with `--dry-run` / `--no-ingest` / `BENCHSDK_NO_INGEST=1` (those flags only skip uploading). Round-mode runs now propagate org headers correctly, and dry-run scoring is guarded so it only happens when a real platform run would be submitted.

  `BenchmarkReporter.claim` now catches the missing-credential error from `createBenchmarkClient` and returns `null` instead of rejecting, matching its existing "no work available" return contract.

### Patch Changes

- 8a9c745: Cleans up the benchsdk public surface and legacy auth fallbacks.

  - Removes the legacy `COMPUTESDK_API_KEY` environment fallback from `@benchsdk/api`, `@benchsdk/cli`, and `@benchsdk/runner`; only `BENCHMARKS_PLATFORM_API_KEY` is used.
  - Removes the `COMPUTESDK_ADMIN_API_KEY` concept and related admin-key paths.
  - Tightens CLI flag validation and sanitizes scaffold names in `@benchsdk/runner`.
  - Fixes `TaskError` cross-bundle recognition so error names, codes, and data serialize correctly across the worker boundary.
  - Trims the `@benchsdk/client` umbrella exports to match the focused-package re-exports.

- Updated dependencies [8a9c745]
- Updated dependencies [8a9c745]
- Updated dependencies [8a9c745]
- Updated dependencies [8a9c745]
- Updated dependencies [8a9c745]
- Updated dependencies [8a9c745]
  - @benchsdk/api@0.2.0
