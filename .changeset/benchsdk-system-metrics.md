---
"@benchsdk/worker": minor
"@benchsdk/api": minor
"@benchsdk/runner": minor
---

Adds system metrics collection to benchmark workers.

- `runWorker` accepts a `metricsIntervalMs` option (default 30s, overridable via `BENCHMARK_METRICS_INTERVAL_MS`) that samples process CPU/memory, event loop lag, load average, socket counts, plus host-wide `/proc/meminfo` and `/proc/stat` metrics and cgroup v1/v2 limits.
- Captures a baseline sample at worker claim so fast-finishing workers still record data.
- Rejects invalid metrics sampling intervals.
- Takes the minimum cgroup limit across ancestor levels.
- In `groupBy: 'round'` mode, samples once per round and uploads the `system-metrics` artifact alongside the coordinator log.
- Extends `@benchsdk/api` types to support system metric samples and artifact tagging.
