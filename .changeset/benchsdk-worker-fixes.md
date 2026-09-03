---
"@benchsdk/worker": patch
"@benchsdk/runner": patch
---

Bug fixes for worker and runner result handling.

- `BenchmarkReporter` now fails the worker process when the final result flush cannot send results instead of silently swallowing the error.
- Tightens `isStepOutcome` in both the worker and runner to avoid misclassifying benchmark result objects, preserving `TaskError` domain data on failure records.
