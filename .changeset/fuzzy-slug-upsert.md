---
"@benchsdk/api": patch
"@benchsdk/runner": patch
---

Fix `bench run --benchmark <slug>` 404ing on brand-new slugs. A bare retarget previously skipped the benchmark upsert entirely, so `createRun` always failed with `404 Benchmark not found` for slugs that didn't exist yet. The runner now always upserts the target slug: it probes first and leaves an existing benchmark untouched, but creates a missing one with the file's name and scoring/display manifest. `UpsertBenchmarkInput.name` is now optional to match the API (absent `name` is a no-op on update).
