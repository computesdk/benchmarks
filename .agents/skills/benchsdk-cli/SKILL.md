---
name: benchsdk-cli
description: Install, authenticate, and use the unified bench CLI to query and run ComputeSDK benchmarks. Covers device-code OAuth, API keys, config files, and non-interactive/CI use.
---

# `bench` CLI

The `bench` binary is the unified CLI for the ComputeSDK benchmarks platform.
`bench run` executes benchmark files; all other commands query platform data.

## Installation

The CLI ships with `@benchsdk/runner`. From the benchmarks repo root:

```bash
pnpm install
pnpm -r --filter "./packages/**" build
```

Run via the built binary:

```bash
node packages/benchsdk-runner/dist/bin.cjs --version
```

Or add `packages/benchsdk-runner` to your `PATH` so `bench --version` works.

## Authentication

The CLI tries credentials in this order:

1. `--api-key <key>`
2. `BENCHMARKS_PLATFORM_TOKEN` (a better-auth session token — does not refresh)
3. `BENCHMARKS_PLATFORM_API_KEY` (an org-scoped `bp_...` key)
4. OAuth tokens from `~/.benchsdk/credentials.json` (from `bench auth login`)

API keys and tokens are useful for non-interactive environments. OAuth is
interactive and stores a refresh token under `~/.benchsdk`. At least one
credential is required for any command that touches the platform.

### Device-code login

```bash
bench auth login --base-url https://platform.computesdk.com
```

This prints a URL and a user code. Approve the device in the browser; the CLI
polls and stores the access/refresh token pair. Access tokens last 1 hour;
refresh tokens are 30-day sliding windows and rotate on every refresh.

### Check status

```bash
bench auth status
bench auth status --json
```

### Log out

```bash
bench auth logout
```

This removes `~/.benchsdk/credentials.json`.

## Configuration file

`~/.benchsdk/config.json` stores non-secret defaults:

```json
{
  "baseUrl": "https://platform.computesdk.com",
  "org": "computesdk",
  "format": "table"
}
```

`--base-url`, `--org`, and `--format` override this file. Credentials live in
`~/.benchsdk/credentials.json` and are created with `0600` file permissions.

## Common commands

### Organizations

```bash
bench org list
bench org use computesdk
```

`bench org use` switches the active organization and rewrites the stored access
token with the new organization claim.

### Benchmarks

```bash
bench benchmarks list
bench benchmarks list --limit 20 --offset 40
bench benchmarks list --json
```

### Runs

```bash
bench runs list my-benchmark
bench runs show my-benchmark <runId>
```

### Results

```bash
bench results my-benchmark
bench results my-benchmark --run <runId>
bench results my-benchmark --format json
```

### Artifacts

```bash
bench artifacts list my-benchmark <runId>
bench artifacts list my-benchmark <runId> --worker <workerId>
```

### Export

```bash
bench export my-benchmark --out ./exports
bench export my-benchmark --run <runId> --out ./exports
```

## Running benchmarks

`bench run` still executes benchmark files via `@benchsdk/runner`:

```bash
bench run path/to/file.bench.ts --iterations 4 --concurrency 2
```

You can also use an org-scoped `bp_` key for non-interactive runs:

```bash
BENCHMARKS_PLATFORM_API_KEY=bp_... bench run path/to/file.bench.ts
```

## Non-interactive / CI use

Set environment variables so the CLI never tries to open a browser:

```bash
export BENCHMARKS_PLATFORM_URL=https://platform.computesdk.com
export BENCHMARKS_PLATFORM_API_KEY=bp_...

bench benchmarks list --json --limit 100
```

If no credentials are present, the CLI fails fast with an `AuthError`.

## Environment variables

- `BENCHMARKS_PLATFORM_URL` — platform root URL (default: `https://platform.computesdk.com`)
- `BENCHMARKS_PLATFORM_API_KEY` — API key
- `BENCHMARKS_PLATFORM_TOKEN` — bearer/session token
- `CI` — when set, the CLI avoids interactive prompts

## Global flags

- `--base-url <url>` — override the platform URL
- `--api-key <key>` — use an API key for this command
- `--org <slug>` — override the active organization
- `--format json|table` — output format
- `--json` — shortcut for `--format json`
- `--verbose` — print stack traces and extra diagnostics on errors
- `--version`
- `--help` and `bench <command> --help`

## Exit codes

- `0` — success
- `1` — general error or API failure
- `2` — authentication error

## Troubleshooting

- `bench --version` shows `0.0.0` — the `dist/` output is stale or the
  `package.json` was not found. Rebuild with `pnpm --filter @benchsdk/cli build`.
- `Cannot find module .../dist/bin.cjs` — build `@benchsdk/runner` first:
  `pnpm --filter @benchsdk/runner build`.
- `Your session has expired` — the refresh token is expired or revoked. Run
  `bench auth login` again, or use `BENCHMARKS_PLATFORM_API_KEY`.
- 401/403 on list commands — verify the active org with `bench auth status` or
  pass `--org <slug>`.
- The CLI auto-refreshes access tokens within 5 minutes of expiry. If a command
  fails with an auth error, the refresh token may also be expired.

## Secrets needed

None for local development with `BENCHMARKS_PLATFORM_API_KEY` if one is
provided. For OAuth login in CI, prefer `BENCHMARKS_PLATFORM_API_KEY` or
`BENCHMARKS_PLATFORM_TOKEN` instead of `bench auth login`.
