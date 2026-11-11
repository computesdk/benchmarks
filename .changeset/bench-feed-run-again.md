---
'@benchsdk/api': patch
'@benchsdk/cli': patch
'@benchsdk/runner': patch
---

Add the org run feed and daily Run again to `bench`.

- `bench runs feed` (`GET /benchmarks/runs/summary` → `{runs, analytics}`), `bench runs days` (`GET /benchmarks/runs/days` → `{days, timeZone}`) and `bench runs day <YYYY-MM-DD>` (`GET /benchmarks/runs/day/{day}` → `{day, timeZone, runs, nextCursor, analytics}`) read the organization-wide run feed. They take `--benchmark` (repeatable or a comma list, sent as `benchmarkSlugs`), `--include-archived` and `--include-muted`; `runs feed` takes `--limit` (1 to 100), `runs days`/`runs day` take `--tz` (default: the local zone), and `runs day` takes `--cursor <createdAt>,<id>` (the page's `nextCursor`, sent as `cursorCreatedAt` and `cursorId`) and `--all`, which follows every page and prints one array of runs. The table marks runs from their `isArchived` and `benchmarkMuted` fields.
- `bench reliability cards [--include-muted]` (`GET /benchmarks/reliability-cards` → `{cards: [{benchmark, card}], mutedCount}`) prints one row per reliability benchmark, and `bench activity [--days N] [--benchmark <slug>]` (`GET /benchmarks/activity` → `{days, benchmarkSlug, series: [{date, runs}]}`) prints runs per UTC day.
- `bench runs list --benchmark <slug>...` narrows the cross-benchmark list (`benchmarkSlugs`). A platform that ignores the filter makes the command exit 1 instead of printing other benchmarks' runs.
- `bench run-again <slug>` (`POST /benchmarks/{slug}/run-again`, no body → 202 `{benchmarkSlug, category, runAgainId, statusUrl}`) runs a daily benchmark again, once per organization, benchmark and UTC day; `--wait` polls `GET /benchmarks/{slug}/run-again/{runAgainId}` (`{runAgainId, runId}`) every `--interval` seconds (default 5) and exits 3 if no run is reported within `--timeout` seconds (default 600). `bench run-again status <slug> [--request <runAgainId>]` shows availability and quota (`GET /benchmarks/{slug}/run-again`), or one request. An org API key's `user_credential_required` refusal prints a hint to sign in with `bench auth login` in place of the platform's hint; `owner_only`, `category_not_entitled`, `run_again_disabled` and `quota_exceeded` (with `retryAt`) refusals print their code and a next step.
- `@benchsdk/api` adds `getRunFeed` (`limit` or `runIds`, not both; `stats: false` sends `stats=0`), `listRunDays`, `listRunsForDay`, `listAllRunsForDay`, `getReliabilityCards`, `getActivity`, `runBenchmarkAgain` and `getRunAgainState`, with the `RunFeedItem`, `RunDayCursor`, `ReliabilityCard`, `BenchmarkActivity`, `RunAgainAccepted` and `RunAgainState` types. A daily Run again request is polled with the existing `getRunAgain`.
- `cli-manifest.json` lists the new commands with `since: 0.9.5`.
