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
- `bench benchmarks list [--limit N] [--offset N] [--status active|archived|all]` (default `active`)
- `bench benchmarks archive <slug> [-y]` — archive a benchmark and all of its runs
- `bench benchmarks restore <slug>` — restore an archived benchmark and its runs
- `bench benchmarks describe <slug> [--tagline <text>] [--description <text>] [--description-file <path>] [--clear-tagline] [--clear-description]`
- `bench benchmarks mute <slug>` / `bench benchmarks unmute <slug>` — the org mute that hides a benchmark from the org run feed
- `bench benchmarks pause <slug> [--start <iso>] [--end <iso>]` / `bench benchmarks resume <slug>` — reliability benchmarks only
- `bench runs list [slug] [--limit N] [--offset N] [--participant <list>] [--since <when>] [--until <when>] [--day YYYY-MM-DD] [--tz <zone>] [--source-org <slug>] [--archived exclude|include|only] [--include-muted]`
- `bench runs show <slug> <runId>`
- `bench runs run-again <slug> <runId> [--wait] [--timeout <seconds>]`
- `bench runs run-again-status <slug> <runAgainId>`
- `bench runs archive <runId...> [-y]` / `bench runs unarchive <runId...> [-y]` — up to 100 run ids per call
- `bench results <slug> [--run <id>] [--format json|table] [--participant <list>] [--steps <list>|all] [--since <when>] [--until <when>] [--day YYYY-MM-DD] [--tz <zone>] [--source-org <slug>] [--limit N] [--offset N]`
- `bench reliability <slug> [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--bucket day|hour] [--tz <zone>] [--metrics <list>] [--breakdown <list>] [--source-org <slug>] [--format json|table]` — uptime range for a `type=reliability` benchmark; `--day YYYY-MM-DD --participant <slug>` for the per-slot day view
- `bench iterations <slug> --run <id> [--participant <slug>] [--steps <list>]`
- `bench artifacts list <slug> <runId> [--worker <id>]`
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
bench runs archive <runId> <runId> -y --json   # {"archived": true, "count": 2}
bench benchmarks describe alpha --tagline "Cold starts" --description-file about.md
```

Run lists leave archived runs out by default; `--archived include` adds them and `--archived only` shows nothing else (and exits 1 if the platform answers with unarchived runs, which means it does not support the filter). `--include-muted` adds runs of muted benchmarks to the cross-benchmark list.

API errors print the HTTP status, the platform's `error`/`message`, its `code` and its `hint` when present, for example `Benchmark not found (code: not_found)`.

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
