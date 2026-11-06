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
- `bench benchmarks list [--limit N] [--offset N]`
- `bench runs list <slug> [--limit N] [--offset N] [--participant <list>] [--since <when>] [--until <when>] [--day YYYY-MM-DD] [--tz <zone>] [--source-org <slug>]`
- `bench runs show <slug> <runId>`
- `bench runs run-again <slug> <runId> [--wait] [--timeout <seconds>]`
- `bench runs run-again-status <slug> <runAgainId>`
- `bench results <slug> [--run <id>] [--format json|table] [--participant <list>] [--steps <list>|all] [--since <when>] [--until <when>] [--day YYYY-MM-DD] [--tz <zone>] [--source-org <slug>] [--limit N] [--offset N]`
- `bench reliability <slug> [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--bucket day|hour] [--tz <zone>] [--metrics <list>] [--breakdown <list>] [--source-org <slug>] [--format json|table]` — uptime range for a `type=reliability` benchmark; `--day YYYY-MM-DD --participant <slug>` for the per-slot day view
- `bench iterations <slug> --run <id> [--participant <slug>] [--steps <list>]`
- `bench artifacts list <slug> <runId> [--worker <id>]`
- `bench logs <slug> <runId> [--participant <slug>] [--worker <id>] [--max-lines N]`
- `bench export <slug> [--run <id>] [--out <dir>]`
- `bench fork <slug> [--as <new-slug>] [--source-org <slug>] [--ref <sha>]`

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
