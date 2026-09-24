---
"@benchsdk/runner": minor
---

`--worker-pool N` (requires `--run-key`) sizes a shared, keyed run for N sequential invocations over its lifetime: the participant is registered for the whole pool, the platform plans N workers once, and each invocation claims the next pending worker. Siblings joining after the pool is planned tolerate the plan route's 409 (workers already planned) and go on to claim a worker. Pool mode is rejected for round grouping, and `runBenchmarkWorker` forwards the new `workerPool` option.
