---
"@benchsdk/api": minor
"@benchsdk/worker": minor
"@benchsdk/client": minor
"@benchsdk/runner": minor
---

Fold operator surface into `@benchsdk/runner` and add ergonomics/observability helpers.

- `@benchsdk/runner` is now the canonical operator package; `@benchsdk/client` is a compatibility re-export shim and a thin `createBenchmarkClient` wrapper.
- Rename `TaskStepOptions.concurrency` to `parallelInvocations` (old name still accepted with a deprecation warning).
- `runWorker` is now a free function; `createBenchmarkClient().runWorker()` remains available via `@benchsdk/client`.
- Add `runBenchmarkWorker(options)` one-shot helper for running a single participant's worker without a `*.bench.ts` file.
- Add `bench check <file.bench.ts>` for preflight validation of config, auth, participants, and scoring weights.
- Add `bench run --check` to validate before executing.
- Add `bench.config.ts`/`.benchrc` CLI config file support for project-level defaults.
- Add `validateBenchmarkConfig(config)` returning structured `{ field, message }[]`; `defineBenchmarkConfig` throws `BenchmarkConfigError`.
- Add `defineOnComplete(handler)` typed helper for `onComplete` callbacks.
- Default `RunWorkerOptions.processKey` to `os.hostname()`.
- Add `RunWorkerOptions.onTelemetryError` / `BenchmarkReporterConfig.onTelemetryError` callbacks for heartbeat/log-upload/artifact telemetry failures.
- Worker telemetry failures now emit `console.warn` by default instead of failing silently.
- `TaskError` now includes `step`, `timeoutMs`, and participant context for step timeouts.
