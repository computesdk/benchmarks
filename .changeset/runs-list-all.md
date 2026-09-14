---
"@benchsdk/api": minor
"@benchsdk/cli": minor
---

List runs across all visible benchmarks.

- New `client.listAllRuns({ limit?, offset?, benchmarkSlug? })` hitting `GET /api/v1/runs`; items are `BenchmarkRunListItem` (run row + `organizationSlug` + `benchmarkSlug`).
- `bench runs list` now takes an optional slug: `bench runs list` lists every run the caller can read (own + subscribed benchmarks); `bench runs list <slug>` is unchanged.
