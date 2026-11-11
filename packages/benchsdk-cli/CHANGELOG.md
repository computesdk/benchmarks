# @benchsdk/cli

## 0.9.5

### Patch Changes

- ec00dd9: Add a machine-readable `bench` command manifest.

  - `@benchsdk/cli` exports `COMMANDS`, one table of every platform command with its arguments, allowed flags, and the version that first shipped it (`since`, plus `flagsSince` for flags added later). `bench` reads its per-command flag allowlists from this table. `bench auth login|logout|status` now reject unknown flags like every other command instead of ignoring them.
  - `@benchsdk/runner` adds the hidden `bench __manifest [--released]` command, which prints the command tree as JSON (runner verbs `run` and `check` plus `COMMANDS`), and ships the generated `cli-manifest.json`. Regenerate it with `pnpm --filter @benchsdk/runner run manifest`.
  - The manifest lists `bench reliability` with `since: 0.9.2` (merged after `@benchsdk/cli` 0.9.1 was published; 0.9.2 is the first release that shipped it) and `bench runs run-again` / `runs run-again-status` with `since: 0.9.3`.

- ec00dd9: Add the org run feed and daily Run again to `bench`.

  - `bench runs feed` (`GET /benchmarks/runs/summary` → `{runs, analytics}`), `bench runs days` (`GET /benchmarks/runs/days` → `{days, timeZone}`) and `bench runs day <YYYY-MM-DD>` (`GET /benchmarks/runs/day/{day}` → `{day, timeZone, runs, nextCursor, analytics}`) read the organization-wide run feed. They take `--benchmark` (repeatable or a comma list, sent as `benchmarkSlugs`), `--include-archived` and `--include-muted`; `runs feed` takes `--limit` (1 to 100), `runs days`/`runs day` take `--tz` (default: the local zone), and `runs day` takes `--cursor <createdAt>,<id>` (the page's `nextCursor`, sent as `cursorCreatedAt` and `cursorId`) and `--all`, which follows every page and prints one array of runs. The table marks runs from their `isArchived` and `benchmarkMuted` fields.
  - `bench reliability cards [--include-muted]` (`GET /benchmarks/reliability-cards` → `{cards: [{benchmark, card}], mutedCount}`) prints one row per reliability benchmark, and `bench activity [--days N] [--benchmark <slug>]` (`GET /benchmarks/activity` → `{days, benchmarkSlug, series: [{date, runs}]}`) prints runs per UTC day.
  - `bench runs list --benchmark <slug>...` narrows the cross-benchmark list (`benchmarkSlugs`). A platform that ignores the filter makes the command exit 1 instead of printing other benchmarks' runs.
  - `bench run-again <slug>` (`POST /benchmarks/{slug}/run-again`, no body → 202 `{benchmarkSlug, category, runAgainId, statusUrl}`) runs a daily benchmark again, once per organization, benchmark and UTC day; `--wait` polls `GET /benchmarks/{slug}/run-again/{runAgainId}` (`{runAgainId, runId}`) every `--interval` seconds (default 5) and exits 3 if no run is reported within `--timeout` seconds (default 600). `bench run-again status <slug> [--request <runAgainId>]` shows availability and quota (`GET /benchmarks/{slug}/run-again`), or one request. An org API key's `user_credential_required` refusal prints a hint to sign in with `bench auth login` in place of the platform's hint; `owner_only`, `category_not_entitled`, `run_again_disabled` and `quota_exceeded` (with `retryAt`) refusals print their code and a next step.
  - `@benchsdk/api` adds `getRunFeed` (`limit` or `runIds`, not both; `stats: false` sends `stats=0`), `listRunDays`, `listRunsForDay`, `listAllRunsForDay`, `getReliabilityCards`, `getActivity`, `runBenchmarkAgain` and `getRunAgainState`, with the `RunFeedItem`, `RunDayCursor`, `ReliabilityCard`, `BenchmarkActivity`, `RunAgainAccepted` and `RunAgainState` types. A daily Run again request is polled with the existing `getRunAgain`.
  - `cli-manifest.json` lists the new commands with `since: 0.9.5`.

- ec00dd9: `compute login` / `bench auth login` now also request the `providers:read` and `providers:write` scopes, so the stored login can reach `/api/v1/providers` (the org's BYOK provider keys and custom rates, `compute byok`). Logins made before this keep working everywhere else; run `compute login` again to use `compute byok` with a user login.
- ec00dd9: Add benchmark and run management to `bench`.

  - `bench benchmarks archive|restore <slug>` (`PATCH /benchmarks/{slug}` with `status`), `describe <slug>` (`--tagline`, `--description`, `--description-file`, `--clear-tagline`, `--clear-description`), `mute|unmute <slug>`, and `pause|resume <slug>` for reliability benchmarks (`POST|DELETE /benchmarks/{slug}/pause`, `--start`/`--end`).
  - `bench runs archive|unarchive <runId...>` (`POST /benchmarks/runs/archive`, up to 100 ids; the platform replies `{archived: <count>, count}`) prints `{archived, count}`, with `archived` as the direction (`true` or `false`) and `count` the runs changed.
  - `bench benchmarks list --status active|archived|all`; `bench runs list --archived exclude|include|only` and, on the cross-benchmark list only, `--include-muted` (muted benchmarks' runs are kept there by default, so it restates the default). `--archived only` exits 1 when the platform answers with unarchived runs.
  - Archiving an already-archived benchmark exits 1 with the platform's `409 conflict` and a hint to restore it; `archivedRunCount` is printed only when the platform reports one.
  - `benchmarks archive` and `runs archive|unarchive` ask for confirmation on a terminal; elsewhere they exit 1 without sending anything unless `-y`/`--yes` is passed.
  - API errors now print the platform's `error`, `message`, `code` and `hint`; a member login refused a management write gets a hint that it needs an owner or admin (or an org API key).
  - `@benchsdk/api` adds `setBenchmarkArchived`, `archiveRuns`, `pauseBenchmark`, `resumeBenchmark`, `status` on `listBenchmarks`, `archived` on `listRuns` and `listAllRuns`, `includeMuted` on `listAllRuns` (`false` sends `includeMuted=0` to leave muted benchmarks' runs out), and `tagline`/`description`/`muted` on `updateBenchmark`.
  - Behavior change once the platform ships the archive filter: run lists leave archived runs out unless `--archived include|only` is given.
  - `cli-manifest.json` lists the new commands and flags with `since: 0.9.5`.

- ec00dd9: Add the run analytics reads the dashboard shows to `bench`.

  - `bench runs show <slug> <runId>` prints the run and then its Overview (`GET /benchmarks/{slug}/runs/{runId}/overview` → `{run, generatedAt, progress, overall, customMetrics, dimension, ranking}`): progress, overall stats, custom metric medians and the participants ranked by `--rank-by` (`task`, `step:<name>` or a metric key) at `--stat min|median|p95|p99|max` within an optional `--dimension`. With `--json` the overview is the printed run's `overview` key; it is `null` when the platform has no overview route (404) or analytics are unavailable (503), unless an overview flag was passed, which makes those exit 1.
  - `bench results <slug> --run <id> --timeline [--bucket-ms N]` (`GET …/results/timeline`) and `--tasks [--bucket-size N] [--failure-limit N]` (`GET …/results/tasks`) print a run's event rate and concurrency, or its per-task latency buckets and failures. Both need `--run` and take no other filter. A single `--run` also prints the custom metric medians the platform now returns as `customMetrics`.
  - `bench iterations --type steps|tasks` (default `steps`) adds the per-task iterations; `--steps` applies to `--type steps` only.
  - `bench workers <slug> <runId> [--participant <slug>]` (`GET …/runs/{runId}/workers` → `{run, items}`) lists the run's workers with progress and artifacts.
  - `bench artifacts download <slug> <runId> <workerId> <artifactId> [--out <file>]` writes the artifact's bytes as stored to `--out` or stdout; a binary artifact refuses a terminal stdout, and `--json` needs `--out` (it prints `{path, bytes, artifact}`). `bench artifacts list` now rejects `--out`.
  - `bench matrix <slug>` and `bench model-index <slug>` (`GET /benchmarks/{slug}/matrix`, `/model-index`, or the `~/{sourceOrg}/{slug}` form with `--source-org`) print a matrix index benchmark's dataset or a model index benchmark's results.
  - `bench benchmarks list` takes the dashboard directory's `--sort name|owner|category|runs|lastRun`, `--order asc|desc` (needs `--sort`), `--group public|stealth|mine`, `--category` (repeatable or a comma list), `--owner <org-slug>` and `--q <text>`.
  - `@benchsdk/api` adds `getRunOverview`, `listRunWorkers`, `downloadWorkerArtifactBytes` (raw bytes, never decompressed), `getBenchmarkMatrix` and `getModelIndex`, the directory options on `listBenchmarks`, the list-row fields on `BenchmarkResource` (`categoryName`, `runCount`, `latestRun`, `viewerMuted`, `effectiveConfidential`) and `customMetrics` on `BenchmarkRunResults`.
  - `cli-manifest.json` lists the new commands and flags with `since: 0.9.5`.

- Updated dependencies [ec00dd9]
- Updated dependencies [ec00dd9]
- Updated dependencies [ec00dd9]
  - @benchsdk/api@0.11.3

## 0.9.4

### Patch Changes

- Updated dependencies [a09bd64]
  - @benchsdk/api@0.11.2

## 0.9.3

### Patch Changes

- f305333: Add latest-code benchmark run-again API support and the `runs run-again` /
  `runs run-again-status` CLI commands. Exact-commit reproduction remains in
  `compute actions rerun`.
- Updated dependencies [f305333]
  - @benchsdk/api@0.11.1

## 0.9.2

### Patch Changes

- Updated dependencies [2c1e60e]
  - @benchsdk/api@0.11.0

## 0.9.1

### Patch Changes

- Updated dependencies [0a38f3d]
  - @benchsdk/api@0.10.0

## 0.9.0

### Minor Changes

- 3369cee: - `client.listRuns` returns an array again (pre-0.8.0 shape); the response envelope is available as non-enumerable `items`, `appliedFilter` and `upgrade` properties.
  - `client.getRunResults` accepts `{ participants }` and sends `?participant=`; `bench results --run <id> --participant <slug>` narrows a single run to one provider.
  - `--tz` and `--source-org` alone no longer count as result filters, so they stop triggering the "platform does not support result filters" error against older platforms.
  - The `bench results` table labels each row with the run's day instead of its UUID.

### Patch Changes

- ca1fbda: Add `bench fork` (tracked private fork of a catalog benchmark via `config.upstream`), pass `ciRunId` from `COMPUTESDK_RUN_ID` on run creation, and expose `getForeignBenchmark` with the platform source descriptor.
- Updated dependencies [ca1fbda]
- Updated dependencies [3369cee]
  - @benchsdk/api@0.9.0

## 0.8.0

### Minor Changes

- 9c7058e: Benchmark result filters matching the platform's new `/api/v1/benchmarks` filter params. `getBenchmarkResults` and `listRuns` accept `participants`, `since`/`until` (YYYY-MM-DD, ISO, or a resolved instant), `timeZone`, and `sourceOrg` (routes through `/benchmarks/~/{sourceOrg}/{slug}`); `getBenchmarkResults` also accepts `steps` (`string[]` or `'all'`). `listRuns` now returns `{ items, filter?, upgrade? }` instead of a bare array, and both responses carry the server's `filter` echo. `bench runs list` and `bench results` gain `--participant`, `--steps` (results only), `--since`/`--until` (date, ISO, or relative `24h`/`7d`/`2w`), `--day`, `--tz` (defaults to the machine zone), and `--source-org`; `--json` prints the raw response including the filter echo, and a filter flag against a platform without the feature exits non-zero.

### Patch Changes

- Updated dependencies [9c7058e]
  - @benchsdk/api@0.8.0

## 0.7.2

### Patch Changes

- Updated dependencies [eb46515]
  - @benchsdk/api@0.7.2

## 0.7.1

### Patch Changes

- 975b155: Export `getMe`, `listOrganizations`, `setActiveOrganization`, `loadCredentials`, and `saveCredentials` so other first-party CLIs (e.g. `@computesdk/cli` for `compute org`) can drive the same organization endpoints and credential store.

## 0.7.0

### Minor Changes

- b56c3f4: Move CLI auth onto the OAuth provider. `bench auth login` now runs the RFC 8628 device flow against `/api/auth/device/code` and redeems at `/api/auth/oauth2/token` (`device_code` + `refresh_token` grants). Both `bench` and `compute` log in as the `benchsdk-cli` client with the full first-party scope set, so one login in `~/.benchsdk/credentials.json` covers every first-party CLI. API keys and new-format logins keep working; entries written by the retired HS256/`bcs_` token system are detected and cleared with a prompt to log in again, and `insufficient_scope` API errors surface a re-login hint.

## 0.6.1

### Patch Changes

- Updated dependencies [6868819]
  - @benchsdk/api@0.7.1

## 0.6.0

### Minor Changes

- f0574f0: Add `getParticipantLogs` to `@benchsdk/api` and a `bench logs` command for viewing parsed participant worker logs (the dashboard log view) via the platform's new `GET .../participants/:slug/logs` endpoint:

  ```
  bench logs <slug> <runId> [--participant <slug>] [--worker <id>] [--max-lines N]
  ```

### Patch Changes

- Updated dependencies [f0574f0]
  - @benchsdk/api@0.7.0

## 0.5.0

### Minor Changes

- 501d260: Fold operator surface into `@benchsdk/runner` and add ergonomics/observability helpers.

  - `@benchsdk/runner` is now the canonical operator package; `@benchsdk/client` is a compatibility re-export shim and a thin `createBenchmarkClient` wrapper.
  - Rename `TaskStepOptions.concurrency` to `parallelInvocations` (old name still accepted with a deprecation warning).
  - `runWorker` is now a free function; `createBenchmarkClient().runWorker()` remains available via `@benchsdk/client`.
  - Add `runBenchmarkWorker(options)` one-shot helper for running a single participant's worker without a `*.bench.ts` file.
  - Add `bench check <file.bench.ts>` for preflight validation of config, auth, participants, and scoring weights.
  - Add `bench run --check` to validate before executing.
  - Add `validateBenchmarkConfig(config)` returning structured `{ field, message }[]`; `defineBenchmarkConfig` throws `BenchmarkConfigError`.
  - Add `defineOnComplete(handler)` typed helper for `onComplete` callbacks.
  - Default `RunWorkerOptions.processKey` to `os.hostname()`.
  - Add `RunWorkerOptions.onTelemetryError` / `BenchmarkReporterConfig.onTelemetryError` callbacks for heartbeat/log-upload/artifact telemetry failures.
  - Worker telemetry failures now emit `console.warn` by default instead of failing silently.
  - `TaskError` now includes `step`, `timeoutMs`, and participant context for step timeouts.
  - `create-bench` scaffold and README now reference `@benchsdk/runner` instead of the deprecated `@benchsdk/client` entrypoint.
  - `@benchsdk/cli` now has a README documenting its programmatic API, auth precedence, config/credentials files, and CLI commands.
  - `@benchsdk/cli` `printData` now honors `--format table` for objects as well as arrays and prints `No results.` for empty objects.
  - `@benchsdk/runner` re-exports `resolveAuth`, `createApiClient`, `AuthError`, and the `CliAuth` type from `@benchsdk/cli` so operators only need one package import.
  - `@benchsdk/worker` `onTelemetryError` is now also invoked for `completeWorker` and `failWorker` telemetry failures in the normal completion path.
  - `bench check` now extracts and validates `--base-url` and `--api-key` flags with required-value semantics instead of treating them as pass-through custom flags.
  - `validateBenchmarkConfig` no longer throws when `phases`, `participants`, or `shapes` entries are `null`/primitives; it returns structured `BenchmarkConfigErrorItem` issues instead.
  - `filterParticipantsByEnv` now treats a missing `requiredEnvVars` as an empty list and guards against non-array values, so omitted or malformed participant env lists no longer crash runs.

### Patch Changes

- Updated dependencies [501d260]
  - @benchsdk/api@0.6.0

## 0.4.2

### Patch Changes

- 1f3555b: Run-list responses are now slimmer: `listRuns`/`listAllRuns` return `BenchmarkRunListItem` (id, benchmarkId, organizationId, name, status, sizing, timestamps, organizationSlug, benchmarkSlug) instead of the full run row — `config`, `summary`, `runKey`, `participantSized`, and creator attribution are no longer included. `BenchmarkResource` gains optional `organizationId`/`organizationSlug` for the catalog response.
- Updated dependencies [1f3555b]
  - @benchsdk/api@0.5.0

## 0.4.1

### Patch Changes

- 43eb478: `listAllRuns` now calls the canonical `GET /api/v1/benchmarks/runs` — the platform moved the endpoint under `/benchmarks/` and the old `/api/v1/runs` path was removed.
- Updated dependencies [43eb478]
  - @benchsdk/api@0.4.1

## 0.4.0

### Minor Changes

- 6f37302: List runs across all visible benchmarks.

  - New `client.listAllRuns({ limit?, offset?, benchmarkSlug? })` hitting `GET /api/v1/runs`; items are `BenchmarkRunListItem` (run row + `organizationSlug` + `benchmarkSlug`).
  - `bench runs list` now takes an optional slug: `bench runs list` lists every run the caller can read (own + subscribed benchmarks); `bench runs list <slug>` is unchanged.

### Patch Changes

- Updated dependencies [6f37302]
  - @benchsdk/api@0.4.0

## 0.3.0

### Minor Changes

- 0b1916f: Expose per-iteration benchmark results and sandbox reuse metadata.

  - `@benchsdk/api` adds `getRunTaskIterations` and `getRunStepIterations` plus the `BenchmarkRunIterationInput`, `BenchmarkTaskIteration`, `BenchmarkStepIteration`, `BenchmarkRunTaskIterations`, and `BenchmarkRunStepIterations` types.
  - `@benchsdk/cli` adds `bench iterations <benchmark-slug> --run <id> [--participant <slug>] [--steps <list>] [--format json|table]`.
  - `benchmarks/sandbox/tti.bench.ts` records `sandboxId`, `createdAt`, and `createMs` in the `create` step for sandbox reuse detection.

### Patch Changes

- Updated dependencies [0b1916f]
  - @benchsdk/api@0.3.0

## 0.2.0

### Minor Changes

- 8a9c745: Introduces the `@benchsdk/cli` package and unifies platform commands under the `bench` binary.

  - Adds `@benchsdk/cli`: a reusable library for authenticating against the benchmarks platform and querying benchmarks, runs, results, and artifacts.
  - Implements device-code OAuth login with refresh-token storage in `~/.benchsdk/credentials.json` plus `~/.benchsdk/config.json` for base URL / org / output format defaults.
  - Adds `bench auth`, `bench org`, `bench benchmarks`, `bench runs`, `bench results`, `bench artifacts`, and `bench export` subcommands.
  - Refactors `@benchsdk/runner`'s binary to delegate platform commands to the new CLI library while keeping `bench run <file.bench.ts>` as the benchmark execution path.

- 8a9c745: `createBenchmarkClient` now requires a platform API key or OAuth token. It throws a clear error when neither `apiKey`/`token` is provided nor `BENCHMARKS_PLATFORM_API_KEY`/`BENCHMARKS_PLATFORM_TOKEN` is set, pointing users to create a key at https://platform.computesdk.com in their organization settings.

  `@benchsdk/cli` no longer allows commands to proceed without credentials. `resolveAuth` now fails fast with an `AuthError` in every mode, realigns auth precedence so explicit overrides and environment variables take precedence over saved OAuth, and supports saved API keys. It also exports `resolveAuth`, `createApiClient`, `AuthError`, and the `CliAuth` type.

  `bench run` uses the shared `resolveAuth` flow and now validates auth before participants, even with `--dry-run` / `--no-ingest` / `BENCHSDK_NO_INGEST=1` (those flags only skip uploading). Round-mode runs now propagate org headers correctly, and dry-run scoring is guarded so it only happens when a real platform run would be submitted.

  `BenchmarkReporter.claim` now catches the missing-credential error from `createBenchmarkClient` and returns `null` instead of rejecting, matching its existing "no work available" return contract.

### Patch Changes

- 8a9c745: Cleans up the benchsdk public surface and legacy auth fallbacks.

  - Removes the legacy `COMPUTESDK_API_KEY` environment fallback from `@benchsdk/api`, `@benchsdk/cli`, and `@benchsdk/runner`; only `BENCHMARKS_PLATFORM_API_KEY` is used.
  - Removes the `COMPUTESDK_ADMIN_API_KEY` concept and related admin-key paths.
  - Tightens CLI flag validation and sanitizes scaffold names in `@benchsdk/runner`.
  - Fixes `TaskError` cross-bundle recognition so error names, codes, and data serialize correctly across the worker boundary.
  - Trims the `@benchsdk/client` umbrella exports to match the focused-package re-exports.

- Updated dependencies [8a9c745]
- Updated dependencies [8a9c745]
- Updated dependencies [8a9c745]
- Updated dependencies [8a9c745]
- Updated dependencies [8a9c745]
- Updated dependencies [8a9c745]
  - @benchsdk/api@0.2.0
