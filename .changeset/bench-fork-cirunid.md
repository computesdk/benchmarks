---
"@benchsdk/api": patch
"@benchsdk/cli": patch
"@benchsdk/runner": patch
---

Add `bench fork` (tracked private fork of a catalog benchmark via `config.upstream`), pass `ciRunId` from `COMPUTESDK_RUN_ID` on run creation, and expose `getForeignBenchmark` with the platform source descriptor.
