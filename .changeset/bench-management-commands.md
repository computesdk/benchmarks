---
'@benchsdk/api': patch
'@benchsdk/cli': patch
'@benchsdk/runner': patch
---

Add benchmark and run management to `bench`.

- `bench benchmarks archive|restore <slug>` (`PATCH /benchmarks/{slug}` with `status`), `describe <slug>` (`--tagline`, `--description`, `--description-file`, `--clear-tagline`, `--clear-description`), `mute|unmute <slug>`, and `pause|resume <slug>` for reliability benchmarks (`POST|DELETE /benchmarks/{slug}/pause`, `--start`/`--end`).
- `bench runs archive|unarchive <runId...>` (`POST /benchmarks/runs/archive`, up to 100 ids) prints `{archived, count}`.
- `bench benchmarks list --status active|archived|all`; `bench runs list --archived exclude|include|only` and `--include-muted`. `--archived only` exits 1 when the platform answers with unarchived runs.
- `benchmarks archive` and `runs archive|unarchive` ask for confirmation on a terminal; elsewhere they exit 1 without sending anything unless `-y`/`--yes` is passed.
- API errors now print the platform's `error`, `message`, `code` and `hint`; a member login refused a management write gets a hint that it needs an owner or admin (or an org API key).
- `@benchsdk/api` adds `setBenchmarkArchived`, `archiveRuns`, `pauseBenchmark`, `resumeBenchmark`, `status` on `listBenchmarks`, `archived`/`includeMuted` on `listRuns`/`listAllRuns`, and `tagline`/`description`/`muted` on `updateBenchmark`.
- Behavior change once the platform ships the archive filter: run lists leave archived runs out unless `--archived include|only` is given.
- `cli-manifest.json` lists the new commands and flags with `since: 0.9.4`.
