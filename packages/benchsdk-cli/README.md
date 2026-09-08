# @benchsdk/cli

Programmatic CLI for authenticating with and querying the ComputeSDK benchmarks platform.

You rarely need to install this package directly: it is bundled into the `bench` binary shipped by [`@benchsdk/runner`](../benchsdk-runner). Use this package when you want to build your own CLI or script on top of the same auth, config, and platform-query primitives.

## What it provides

- **`run(argv)`** — parse and dispatch a `bench` invocation for the platform commands.
- **`resolveAuth(override?)`** — resolve base URL and credentials from env vars, `~/.benchsdk/config.json`, and `~/.benchsdk/credentials.json`.
- **`createApiClient(override?)`** — authenticated `BenchmarkClient` plus resolved `CliAuth`.
- **`AuthError`** — thrown when no credentials can be found or a token cannot be refreshed.

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
- `bench runs list <slug> [--limit N] [--offset N]`
- `bench runs show <slug> <runId>`
- `bench results <slug> [--run <id>] [--format json|table]`
- `bench artifacts list <slug> <runId> [--worker <id>]`
- `bench export <slug> [--run <id>] [--out <dir>]`

See the [`benchsdk-cli` skill](../../.agents/skills/benchsdk-cli/SKILL.md) for the full CLI reference, OAuth device-code flow, and CI/non-interactive use.

## License

MIT
