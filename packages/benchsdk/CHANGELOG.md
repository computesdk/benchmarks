# @benchsdk/client

## 0.4.0 (unreleased)

### BREAKING

- `@benchsdk/client` is now a backwards-compatibility shim over `@benchsdk/runner`. It re-exports the full `@benchsdk/runner` surface and preserves `createBenchmarkClient(...).runWorker(...)` for existing low-level callers, but the canonical public packages are now `@benchsdk/runner` (authoring + operator helpers) and `@benchsdk/api` (raw REST types).
- Removed the direct `@benchsdk/api` and `@benchsdk/worker` dependencies; all primitives now come through `@benchsdk/runner`.

### ADDED

- Re-exports the entire `@benchsdk/runner` API surface from the package barrel, so existing `@benchsdk/client` imports continue to work and gain new runners (`defineBenchmarkConfig`, `defineTask`, `runBenchmarkWorker`, `bench check`, etc.).

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
