---
'@benchsdk/api': patch
'@benchsdk/cli': patch
'@benchsdk/runner': patch
---

Add the org run feed and daily retrigger to `bench`.

- `bench runs feed` (`GET /benchmarks/runs/summary`), `bench runs days` (`GET /benchmarks/runs/days`) and `bench runs day <YYYY-MM-DD>` (`GET /benchmarks/runs/day/{day}`) read the organization-wide run feed. They take `--benchmark` (repeatable or a comma list, sent as `benchmarkSlugs`), `--include-archived` and `--include-muted`; `runs feed` takes `--limit` (1 to 100), `runs days`/`runs day` take `--tz` (default: the local zone), and `runs day` takes `--cursor` and `--all`, which follows every page and prints one array of runs.
- `bench reliability cards [--include-muted]` (`GET /benchmarks/reliability-cards`) and `bench activity [--days N] [--benchmark <slug>]` (`GET /benchmarks/activity`).
- `bench runs list --benchmark <slug>...` narrows the cross-benchmark list (`benchmarkSlugs`). A platform that ignores the filter makes the command exit 1 instead of printing other benchmarks' runs.
- `bench retrigger <slug>` (`POST /benchmarks/{slug}/retrigger`) queues today's run of a daily benchmark; `--wait` polls `GET /benchmarks/{slug}/retrigger/{requestId}` every `--interval` seconds (default 5) and exits 3 if no run starts within `--timeout` seconds (default 600). `bench retrigger status <slug> [--request <id>]` shows availability and quota, or one request. An org API key's `user_credential_required` refusal prints a hint to sign in with `bench auth login`.
- `@benchsdk/api` adds `getRunFeed`, `listRunDays`, `listRunsForDay`, `listAllRunsForDay`, `getReliabilityCards`, `getActivity`, `retriggerBenchmark`, `getRetriggerState` and `getRetriggerRequest`.
- `cli-manifest.json` lists the new commands with `since: 0.9.4`.
