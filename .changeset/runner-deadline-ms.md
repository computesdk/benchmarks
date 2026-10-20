---
"@benchsdk/runner": patch
"@benchsdk/worker": patch
"@benchsdk/api": patch
---

Add `deadlineMs` / `--deadline-ms`: a run-level wall-clock budget for task execution. On expiry the run stops launching new tasks, drains in-flight ones, and still flushes, reports, and exits 0 — a deadline is a planned end, not a failure. `BenchmarkRunOutcome.stoppedEarly` flags the truncation; `RunWorkerOptions.stopRequested` is the plumbing that stops new task starts inside `runWorker`.
