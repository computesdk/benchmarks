---
"@benchsdk/api": minor
"@benchsdk/cli": patch
"@benchsdk/runner": patch
"@benchsdk/worker": patch
"@benchsdk/client": minor
---

Cleans up the benchsdk public surface and legacy auth fallbacks.

- Removes the legacy `COMPUTESDK_API_KEY` environment fallback from `@benchsdk/api`, `@benchsdk/cli`, and `@benchsdk/runner`; only `BENCHMARKS_PLATFORM_API_KEY` is used.
- Removes the `COMPUTESDK_ADMIN_API_KEY` concept and related admin-key paths.
- Tightens CLI flag validation and sanitizes scaffold names in `@benchsdk/runner`.
- Fixes `TaskError` cross-bundle recognition so error names, codes, and data serialize correctly across the worker boundary.
- Trims the `@benchsdk/client` umbrella exports to match the focused-package re-exports.
