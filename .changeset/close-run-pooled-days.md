---
"@benchsdk/api": minor
"@benchsdk/runner": minor
---

Adds the close-run capability for pooled keyed runs (a scheduled canary reporting into one run per day).

- `@benchsdk/api`: new `closeRun(benchmarkSlug, runId, input?)` on `BenchmarkClient` — finalizes a run's day and returns the accounting (`workerCount`, `completedWorkers`, `pendingWorkers` = missing fires, `reapedWorkers`, `attemptCount`).
- `@benchsdk/runner`: the invocation that claims the last worker of a `--worker-pool` run now closes the run via the API, and the run's config carries `closeAfterMs` (from `config.closeAfterMs` or `--close-after-ms N`) so the platform can deadline-gate and backstop the close. `runBenchmarkWorker` forwards `closeAfterMs`.
