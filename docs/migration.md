# Source consolidation history and retirement checks

Benchmark workloads and BenchSDK packages now live in [computesdk/benchmarks](https://github.com/computesdk/benchmarks), including the former private Stealth suites under `benchmarks/stealth/`. The import preserved suite-scoped helpers, platform identifiers and workflow definitions; it did not import the private repository’s Git history. The website reads benchmark results from the platform API; see [dotcom’s benchmark data documentation](https://github.com/computesdk/dotcom#benchmark-data).

## Historical cutover instructions

The original [migration and soak-state handoff instructions](https://github.com/computesdk/benchmarks/blob/c42c3de9a6416fec30ee09719b400d2578b7a007/README.md#migration-and-cutover) are retained at their historical commit for audit context. They are not instructions for the current source.

[PR #669](https://github.com/computesdk/benchmarks/pull/669) removed the `STEALTH_BENCHMARKS_ENABLED` gate and the one-shot soak-state importer after source cutover. Current imported workflows do not require that gate, and the importer workflow and script no longer exist. Do not reintroduce them to run a suite.

Soak handoff exports contained sandbox identities, counters and chain state. Historical exports belong in private operational storage, never in this public repository or PR comments. CI caches can be evicted and are not durable archival storage.

## Before retiring a legacy repository

Source consolidation and these documentation changes do not independently verify production routing. Check the live configuration and observed runs before archiving a legacy repository:

1. Verify source links and workflow dispatch routes target `computesdk/benchmarks@master`, workload paths under `benchmarks/stealth/`, and `.computesdk/workflows/stealth-*.yml`.
2. Confirm old platform and GitHub schedules are disabled and replacement runs ingest under the intended existing benchmark identifiers. Avoid duplicate schedules during any remaining handoff.
3. Check runner/vault access and representative replacement runs. For soak, verify consecutive shifts restore and advance the intended state; distinguish an intentional epoch rollover from lost state.
4. Preserve private operational history and any required exports, and update consumer links before making the old repository read-only.

This document records source history and retirement checks. It does not change repository visibility, live platform configuration or legacy schedules.
