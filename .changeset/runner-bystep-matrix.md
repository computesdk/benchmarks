---
"@benchsdk/runner": patch
---

Add `display.byStep.defaultLayout` to `BenchmarkDisplayConfig` (`'table' | 'bars' | 'time' | 'matrix'`) so capability-matrix benchmarks can declare the matrix layout from the `.bench.ts` file — the platform already renders it (computesdk/benchmarks-platform#694). Also accepts `supportedPct` as an `overview.defaultMetric` sentinel for the platform-derived Supported % metric.
