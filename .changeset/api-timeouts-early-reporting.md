---
"@benchsdk/api": minor
"@benchsdk/worker": minor
"@benchsdk/runner": patch
---

Platform API requests time out after 20 s (`requestTimeoutMs`). Retry-safe requests are retried after 1 s and 3 s (`retryDelaysMs`) on a network error, a timeout, or a 408/429/502/503/504. Retry-safe means GETs, PUTs, and the worker `events`/`heartbeat`/`complete`/`fail` POSTs.

In round mode, the runner sends each participant's results right after its last round, and at least every 10 s before that, so a job killed mid-run keeps the results that already finished. `BenchmarkReporter.recordResult(record, { flush: true })` sends queued results immediately, and `reportFailed` reports whether sending failed. The runner logs a clear error naming every participant whose results could not be reported.
