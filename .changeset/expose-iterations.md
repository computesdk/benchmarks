---
"@benchsdk/api": minor
"@benchsdk/cli": minor
---

Expose per-iteration benchmark results and sandbox reuse metadata.

- `@benchsdk/api` adds `getRunTaskIterations` and `getRunStepIterations` plus the `BenchmarkRunIterationInput`, `BenchmarkTaskIteration`, `BenchmarkStepIteration`, `BenchmarkRunTaskIterations`, and `BenchmarkRunStepIterations` types.
- `@benchsdk/cli` adds `bench iterations <benchmark-slug> --run <id> [--participant <slug>] [--steps <list>] [--format json|table]`.
- `benchmarks/sandbox/tti.bench.ts` records `sandboxId`, `createdAt`, and `createMs` in the `create` step for sandbox reuse detection.
