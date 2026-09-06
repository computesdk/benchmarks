---
"@benchsdk/runner": patch
---

Resolve two Devin Review findings for `BenchmarkConfig.display` support.

- `score()` now resolves a missing `ScoringSpec` metric unit from the matching `display.metrics` entry, so `onScore` callbacks that omit `unit` still produce correct units in run summaries.
- `defineBenchmarkConfig` rejects unknown keys in `display`, `display.metrics`, `display.steps`, and `display.overview`.
