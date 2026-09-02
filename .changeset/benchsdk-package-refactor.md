---
"@benchsdk/api": minor
"@benchsdk/worker": minor
"@benchsdk/client": minor
"@benchsdk/runner": minor
---

Splits the monolithic benchsdk into focused packages and migrates the runner onto them.

- Adds `@benchsdk/api`: a typed REST API client plus shared platform types (previously internal to `@benchsdk/client`).
- Adds `@benchsdk/worker`: `runWorker`, `BenchmarkReporter`, system metrics collection, and participant selection.
- Keeps `@benchsdk/client` as a backwards-compatible umbrella that re-exports the focused packages and exposes `client.runWorker()`.
- Migrates `@benchsdk/runner` from `@benchsdk/client` to depend directly on `@benchsdk/api` and `@benchsdk/worker`.
- Introduces declarative `BenchmarkScoringConfig`, `scoringConfigToSpec`, and `validateBenchmarkScoringConfig`; the runner upserts `benchmark.config.scoring` and falls back to the config when `onScore` is omitted.
- Adds `scoring.groupBy` and `config.dimensions` so task records can be grouped by a dimension key and scored separately.
- Sends the resolved run config to the platform at run creation.
