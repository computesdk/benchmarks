---
"@benchsdk/api": minor
"@benchsdk/cli": minor
---

Benchmark result filters matching the platform's new `/api/v1/benchmarks` filter params. `getBenchmarkResults` and `listRuns` accept `participants`, `since`/`until` (YYYY-MM-DD, ISO, or a resolved instant), `timeZone`, and `sourceOrg` (routes through `/benchmarks/~/{sourceOrg}/{slug}`); `getBenchmarkResults` also accepts `steps` (`string[]` or `'all'`). `listRuns` now returns `{ items, filter?, upgrade? }` instead of a bare array, and both responses carry the server's `filter` echo. `bench runs list` and `bench results` gain `--participant`, `--steps` (results only), `--since`/`--until` (date, ISO, or relative `24h`/`7d`/`2w`), `--day`, `--tz` (defaults to the machine zone), and `--source-org`; `--json` prints the raw response including the filter echo, and a filter flag against a platform without the feature exits non-zero.
