---
"@benchsdk/api": patch
"@benchsdk/cli": patch
---

`listAllRuns` now calls the canonical `GET /api/v1/benchmarks/runs` — the platform moved the endpoint under `/benchmarks/` and the old `/api/v1/runs` path was removed.
