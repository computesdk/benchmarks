---
'@benchsdk/api': patch
'@benchsdk/cli': patch
'@benchsdk/runner': patch
---

Add the run analytics reads the dashboard shows to `bench`.

- `bench runs show <slug> <runId>` prints the run and then its Overview (`GET /benchmarks/{slug}/runs/{runId}/overview` → `{run, generatedAt, progress, overall, customMetrics, dimension, ranking}`): progress, overall stats, custom metric medians and the participants ranked by `--rank-by` (`task`, `step:<name>` or a metric key) at `--stat min|median|p95|p99|max` within an optional `--dimension`. With `--json` the overview is the printed run's `overview` key; it is `null` when the platform has no overview route (404) or analytics are unavailable (503), unless an overview flag was passed, which makes those exit 1.
- `bench results <slug> --run <id> --timeline [--bucket-ms N]` (`GET …/results/timeline`) and `--tasks [--bucket-size N] [--failure-limit N]` (`GET …/results/tasks`) print a run's event rate and concurrency, or its per-task latency buckets and failures. Both need `--run` and take no other filter. A single `--run` also prints the custom metric medians the platform now returns as `customMetrics`.
- `bench iterations --type steps|tasks` (default `steps`) adds the per-task iterations; `--steps` applies to `--type steps` only.
- `bench workers <slug> <runId> [--participant <slug>]` (`GET …/runs/{runId}/workers` → `{run, items}`) lists the run's workers with progress and artifacts.
- `bench artifacts download <slug> <runId> <workerId> <artifactId> [--out <file>]` writes the artifact's bytes as stored to `--out` or stdout; a binary artifact refuses a terminal stdout, and `--json` needs `--out` (it prints `{path, bytes, artifact}`). `bench artifacts list` now rejects `--out`.
- `bench matrix <slug>` and `bench model-index <slug>` (`GET /benchmarks/{slug}/matrix`, `/model-index`, or the `~/{sourceOrg}/{slug}` form with `--source-org`) print a matrix index benchmark's dataset or a model index benchmark's results.
- `bench benchmarks list` takes the dashboard directory's `--sort name|owner|category|runs|lastRun`, `--order asc|desc` (needs `--sort`), `--group public|stealth|mine`, `--category` (repeatable or a comma list), `--owner <org-slug>` and `--q <text>`.
- `@benchsdk/api` adds `getRunOverview`, `listRunWorkers`, `downloadWorkerArtifactBytes` (raw bytes, never decompressed), `getBenchmarkMatrix` and `getModelIndex`, the directory options on `listBenchmarks`, the list-row fields on `BenchmarkResource` (`categoryName`, `runCount`, `latestRun`, `viewerMuted`, `effectiveConfidential`) and `customMetrics` on `BenchmarkRunResults`.
- `cli-manifest.json` lists the new commands and flags with `since: 0.9.5`.
