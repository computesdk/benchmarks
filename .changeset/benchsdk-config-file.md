---
"@benchsdk/runner": minor
---

Add `bench.config.ts` project defaults for the `bench` CLI.

- `bench run` / `bench check` load `bench.config.ts` from the working directory (or `--config <path>`); CLI flags override file values.
- New `defineBenchConfig` helper and `BenchSdkConfig` type; `validateBenchSdkConfig` returns structured `{ field, message }[]` issues and invalid files throw `BenchmarkConfigError`.
- `parseCliArgs` accepts a `defaults` argument and `RunBenchmarkOptions.cliArgs` supplies those defaults programmatically.
