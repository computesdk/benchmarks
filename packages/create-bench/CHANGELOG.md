# create-bench

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
