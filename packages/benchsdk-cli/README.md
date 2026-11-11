# @benchsdk/cli

Programmatic CLI for authenticating with and querying the ComputeSDK benchmarks platform.

You rarely need to install this package directly: it is bundled into the `bench` binary shipped by [`@benchsdk/runner`](../benchsdk-runner). Use this package when you want to build your own CLI or script on top of the same auth, config, and platform-query primitives.

## What it provides

- **`run(argv)`** — parse and dispatch a `bench` invocation for the platform commands.
- **`resolveAuth(override?)`** — resolve base URL and credentials from env vars, `~/.benchsdk/config.json`, and `~/.benchsdk/credentials.json`.
- **`createApiClient(override?)`** — authenticated `BenchmarkClient` plus resolved `CliAuth`.
- **`AuthError`** — thrown when no credentials can be found or a token cannot be refreshed.
- **`COMMANDS`** — every platform command with its arguments, allowed flags, and the version that first shipped it (`since`, `flagsSince`). `run()` reads its per-command flag allowlists from this table, and `bench __manifest` in `@benchsdk/runner` publishes it as `cli-manifest.json`. Add new commands and flags here first.

## Install

```sh
pnpm add @benchsdk/cli
```

## Authentication precedence

1. `--api-key <key>` (passed to `resolveAuth` / `createApiClient`)
2. `BENCHMARKS_PLATFORM_TOKEN`
3. `BENCHMARKS_PLATFORM_API_KEY`
4. OAuth tokens saved by `bench auth login` in `~/.benchsdk/credentials.json`

At least one credential is required for commands that touch the platform.

## Configuration files

`~/.benchsdk/config.json` stores non-secret defaults:

```json
{
  "baseUrl": "https://platform.computesdk.com",
  "org": "computesdk",
  "format": "table"
}
```

Credentials are stored separately in `~/.benchsdk/credentials.json` with `0600` permissions.

## Environment variables

- `BENCHMARKS_PLATFORM_URL` — platform root URL (default: `https://platform.computesdk.com`)
- `BENCHMARKS_PLATFORM_API_KEY`
- `BENCHMARKS_PLATFORM_TOKEN`

## Programmatic usage

```ts
import { resolveAuth, createApiClient } from '@benchsdk/cli';

const auth = await resolveAuth({ org: 'computesdk' });
const { api } = await createApiClient({ org: 'computesdk' });

const benchmarks = await api.listBenchmarks({ limit: 10 });
```

## CLI commands

When installed with `@benchsdk/runner`, these are available through the `bench` binary:

- `bench auth login` — OAuth device-code login
- `bench auth logout`
- `bench auth status`
- `bench org list`
- `bench org use <slug>`
- `bench benchmarks list [--limit N] [--offset N] [--status active|archived|all] [--sort name|owner|category|runs|lastRun] [--order asc|desc] [--group public|stealth|mine] [--category <slug>]... [--owner <org-slug>] [--q <text>]` (default `active`, newest first) — sorted and filtered like the dashboard directory
- `bench benchmarks archive <slug> [-y]` — archive a benchmark and all of its runs
- `bench benchmarks restore <slug>` — restore an archived benchmark and its runs
- `bench benchmarks describe <slug> [--tagline <text>] [--description <text>] [--description-file <path>] [--clear-tagline] [--clear-description]`
- `bench benchmarks mute <slug>` / `bench benchmarks unmute <slug>` — the org mute that hides a benchmark from the org run feed
- `bench benchmarks pause <slug> [--start <iso>] [--end <iso>]` / `bench benchmarks resume <slug>` — reliability benchmarks only
- `bench runs list [slug] [--limit N] [--offset N] [--participant <list>] [--since <when>] [--until <when>] [--day YYYY-MM-DD] [--tz <zone>] [--source-org <slug>] [--archived exclude|include|only] [--include-muted]` (`--include-muted` only without a slug)
- `bench runs show <slug> <runId> [--rank-by <option>] [--stat min|median|p95|p99|max] [--dimension <value>]` — the run and its Overview ranking (`overview` in `--json`; `null` when unavailable)
- `bench runs run-again <slug> <runId> [--wait] [--timeout <seconds>]`
- `bench runs run-again-status <slug> <runAgainId>`
- `bench runs archive <runId...> [-y]` / `bench runs unarchive <runId...> [-y]` — up to 100 run ids per call
- `bench runs list --benchmark <slug> [--benchmark <slug>]...` — the cross-benchmark list narrowed to those benchmarks
- `bench runs feed [--benchmark <slug>]... [--include-archived] [--include-muted] [--limit N]` — the org's newest runs across benchmarks, with stats
- `bench runs days [--benchmark <slug>]... [--include-archived] [--include-muted] [--tz <zone>]` — run counts per local day
- `bench runs day <YYYY-MM-DD> [--benchmark <slug>]... [--include-archived] [--include-muted] [--tz <zone>] [--all] [--cursor <createdAt>,<id>]` — one day's runs
- `bench reliability cards [--include-muted]` — the org's reliability cards
- `bench activity [--days N] [--benchmark <slug>]` — run counts per day (N from 1 to 90)
- `bench run-again <slug> [--wait] [--timeout <sec>] [--interval <sec>]` — run a daily benchmark again (once per organization and UTC day; needs a user login)
- `bench run-again status <slug> [--request <runAgainId>]` — Run again availability and quota, or one request
- `bench results <slug> [--run <id>] [--format json|table] [--participant <list>] [--steps <list>|all] [--since <when>] [--until <when>] [--day YYYY-MM-DD] [--tz <zone>] [--source-org <slug>] [--limit N] [--offset N]` (a single `--run` also prints custom metric medians)
- `bench results <slug> --run <id> --timeline [--bucket-ms N]` / `--tasks [--bucket-size N] [--failure-limit N]` — a run's event rate and concurrency, or its per-task latency buckets and failures
- `bench matrix <slug> [--source-org <slug>]` / `bench model-index <slug> [--source-org <slug>]` — a matrix or model index benchmark's newest dataset
- `bench reliability <slug> [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--bucket day|hour] [--tz <zone>] [--metrics <list>] [--breakdown <list>] [--source-org <slug>] [--format json|table]` — uptime range for a `type=reliability` benchmark; `--day YYYY-MM-DD --participant <slug>` for the per-slot day view
- `bench iterations <slug> --run <id> [--type steps|tasks] [--participant <slug>] [--steps <list>]`
- `bench workers <slug> <runId> [--participant <slug>]` — the run's workers with progress and artifact ids
- `bench artifacts list <slug> <runId> [--worker <id>]`
- `bench artifacts download <slug> <runId> <workerId> <artifactId> [--out <file>]` — the artifact's stored bytes (gzip stays gzip) to a file or stdout
- `bench logs <slug> <runId> [--participant <slug>] [--worker <id>] [--max-lines N]`
- `bench export <slug> [--run <id>] [--out <dir>]`
- `bench fork <slug> [--as <new-slug>] [--source-org <slug>] [--ref <sha>]`

Every command accepts `--json`.

### Managing benchmarks and runs

The management writes (`benchmarks archive|restore|describe|mute|unmute|pause|resume`, `runs archive|unarchive`) need an organization owner or admin login, or an org API key. A member login gets the platform's 403 message plus a hint saying so.

`benchmarks archive`, `runs archive` and `runs unarchive` hide or bring back data, so they ask for confirmation first:

- on a terminal, `bench` asks `… ? [y/N]` on stderr (so `--json` stdout stays parseable); anything but `y`/`yes` aborts with exit 1 and nothing is sent;
- anywhere else (CI, a pipe, an agent) the command exits 1 before sending a request unless `-y`/`--yes` is passed.

```sh
bench benchmarks archive old-bench -y --json   # benchmark JSON plus archivedRunCount
bench runs archive <runId> <runId> -y --json   # {"archived": true, "count": 2}; the wire reply is {"archived": 2, "count": 2}
bench benchmarks describe alpha --tagline "Cold starts" --description-file about.md
```

Run lists leave archived runs out by default; `--archived include` adds them and `--archived only` shows nothing else (and exits 1 if the platform answers with unarchived runs, which means it does not support the filter). The cross-benchmark list (`bench runs list` without a slug) keeps runs of muted benchmarks, as it always has; `--include-muted` sends `includeMuted=1`, which only restates that. A single benchmark's run list has no mute filter, so `--include-muted` with a slug exits 1.

Archiving a benchmark that is already archived is a `409 conflict`; `bench` adds a hint to restore it instead. Restoring a benchmark that was not archived succeeds without a run count.

API errors print the HTTP status, the platform's `error`/`message`, its `code` and its `hint` when present, for example `Benchmark not found (code: not_found)`.

### Org run feed

`runs feed`, `runs days`, `runs day`, `reliability cards` and `activity` read the organization-wide views the dashboard shows (`GET /benchmarks/runs/summary`, `/runs/days`, `/runs/day/{day}`, `/reliability-cards`, `/activity`). With `--json` each prints the API body unchanged, except `runs day --all`, which follows every `nextCursor` and prints one array of runs:

```sh
bench runs feed --benchmark rel-1 --benchmark bench-1 --json   # {"runs": [...], "analytics": "ok"}
bench runs days --tz UTC --json                                # {"days": [{"day", "count"}], "timeZone"}
bench runs day 2026-11-01 --json                               # {"day", "timeZone", "runs", "nextCursor", "analytics"}
bench runs day 2026-11-01 --all --json | jq length             # every run of that day
bench reliability cards --json                                 # {"cards": [{"benchmark", "card"}], "mutedCount"}
bench activity --days 7 --json                                 # {"days": 7, "benchmarkSlug": null, "series": [{"date", "runs"}]}
```

- `--benchmark` is repeatable and takes comma lists (`~org/slug` names one owner's benchmark); it is sent as `benchmarkSlugs=a,b`. If the platform answers with runs of other benchmarks (it does not support the filter yet), the command exits 1 instead of printing them.
- Archived runs and runs of muted benchmarks stay out unless `--include-archived` / `--include-muted`. A run's state is in its `isArchived` and `benchmarkMuted` fields; the table marks them `archived` and `muted`.
- `analytics` is `ok` when the runs carry live stats and `unavailable` when the platform could not read them (each run then has `statsPending: true` and a placeholder `progress`).
- `--tz` defaults to this machine's time zone.
- `runs day` without `--all` prints one page (150 runs) and its `nextCursor`, `{createdAt, id}`; pass it back as `--cursor <createdAt>,<id>` (sent as `cursorCreatedAt` and `cursorId`).
- `reliability cards` prints one row per reliability benchmark (uptime over the trailing 24 hours, checks, failures, participants down, last check, and whether it is paused or muted); `mutedCount` says how many muted ones the list left out.
- `activity` counts runs per UTC day over the last `--days` days (1 to 90, default 30), zero-filled; `--benchmark` narrows it to one benchmark, muted or not.

### Daily Run again

`bench run-again <slug>` runs a daily benchmark again, like the dashboard's Run again button (`POST /benchmarks/{slug}/run-again`, no body): one request per organization, benchmark and UTC day. It prints `{benchmarkSlug, category, runAgainId, statusUrl}`. It needs a user login: an org API key gets `403 user_credential_required`, which `bench` reports with the hint "Run again needs a user login: run `bench auth login`". The other refusals print their code: `403 category_not_entitled` (the organization is not entitled to the benchmark's category), `403 owner_only` (only the daily benchmarks' owner organization may), `409 run_again_disabled` (Run again is turned off for the benchmark), and `429 quota_exceeded` with `retryAt`, when today's request is used.

`--wait` polls `GET /benchmarks/{slug}/run-again/{runAgainId}` every `--interval` seconds (default 5) until it reports the run (`{runAgainId, runId}`, with `runId` null while pending), then prints `Run <runId> started` (with `--json`, `{runAgainId, runId}`). If no run is reported within `--timeout` seconds (default 600) it exits **3**.

`bench run-again status <slug>` prints today's availability and quota (`GET /benchmarks/{slug}/run-again`: `{benchmarkSlug, category, available, disabledReason, quota: {day, used, limit, resetsAt}}`; `category` is null for a benchmark that is not a daily one). Org API keys may read it. `--request <runAgainId>` prints one request (`{runAgainId, runId}`).
See the [`benchsdk-cli` skill](../../.agents/skills/benchsdk-cli/SKILL.md) for the full CLI reference, OAuth device-code flow, and CI/non-interactive use.

### Run a benchmark again

```bash
bench runs run-again my-benchmark <runId> --wait
bench runs run-again-status my-benchmark <runAgainId>
```

Running a benchmark again always uses the latest code. To reproduce an exact
commit, use `compute actions rerun`. Run again uses compute. Entitled
organizations can request it once per benchmark per day.

## License

MIT
