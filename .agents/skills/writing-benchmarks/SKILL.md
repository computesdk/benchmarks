---
name: writing-benchmarks
description: Author or improve a ComputeSDK benchmark. Turn a unit of work into a declarative *.bench.ts file (config + task with benchsdk steps), set up participants, scoring, and display, verify with a dry run, and wire it into package.json scripts and CI. Use when asked to create, extend, or improve a benchmark.
---

# Writing a benchmark

A benchmark is **a unit of work** (what one iteration measures) expressed as a
declarative `*.bench.ts` file that exports exactly `config` + `task`. The
`bench run` CLI owns orchestration — the file never calls the runner itself.

Canonical API reference: `WRITING_BENCHMARKS.md` (repo root) — read it for the
full field tables. Runnable templates: `examples/01-hello.bench.ts` through
`11-logging.bench.ts`. Reference implementations:

- `benchmarks/sandbox/tti.bench.ts` — minimal sandbox benchmark
  (create → exec → destroy, one metric).
- `benchmarks/sandbox/dax.bench.ts` — rich benchmark (work measured inside the
  sandbox, pre-measured phase steps, `TaskError`, legacy results writer).

## 1. Define the unit of work

Before writing code, pin down:

- **Timed boundary** — what starts the clock and what ends it. For TTI that's
  `sandbox.create()` → first command succeeding; destroy is excluded. Write the
  boundary in the file's header comment.
- **Uniformity** — the task body must run identically for every participant.
  Push provider differences into participant config (`sandboxOptions`,
  `timeout`, `destroyTimeoutMs`), never into `if (provider === ...)` branches
  inside the task.
- **Headline metric(s)** — the numbers the task reports via `measure()` and
  what counts as a success (exit-code checks, `scoring.success.requireData`).
- **Scale knobs** — which of `iterations`, `concurrency`, `staggerDelayMs`
  define the benchmark vs. stay CLI-overridable. A `shape` may set
  slug/name/staggerDelayMs, never `iterations`/`concurrency`.

## 2. Decompose the work into steps

Wrap each phase in `step('name', fn)` — each step becomes a timed, labeled row
on the platform run page.

Sandbox-benchmark conventions (follow `tti.bench.ts`):

- Steps: `create` → the work → `destroy`. Keep names short; `display.steps`
  maps them to labels.
- Always destroy in `finally`:
  `step('destroy', () => withTimeout(sandbox.destroy(), timeout), { reportConcurrency: false }).catch(err => log('destroy failed', { level: 'warn', ... }))`.
- Guard every external call with `withTimeout` (`benchmarks/src/util/timeout.ts`)
  and a provider overridable timeout.
- `log()` with `{ level, meta }` for diagnosis — the worker log uploads as a
  run artifact. Log the sandbox id after destroy (`sandboxId()` util).
- Step return values shaped like `{ stdout, stderr, error, exitCode, ... }` are
  captured as step output, not returned — pass `captureOutput: false` or wrap.
- Work measured *inside* the sandbox (a script printing `BENCH_*` lines):
  return `{ data, steps, latencyMs }` from the task with pre-measured
  `TaskStepRecord[]`, and set `groupBy: 'round'` so the runner honors them
  (participant mode ignores pre-measured steps). See `dax.bench.ts`.
- Errors: throw `TaskError` (code + data) for domain failures; let plain
  Errors bubble for unexpected ones.

## 3. Write the file

- Place under `benchmarks/<area>/<name>.bench.ts`. Start from the closest
  existing benchmark, not from scratch.
- `import '../src/env.js'` first (loads `benchmarks/.env`).
- `config` essentials: `benchmarkSlug`, `benchmarkName`, `iterations`,
  `concurrency`, `participants`, `display`, `scoring`. Optional: `shapes`,
  `phases`, `groupBy`, `defaultProviders`, `dimensions`, `onComplete`,
  `customCliFlags` — see WRITING_BENCHMARKS.md before reaching for them.

## 4. Participants

- Sandbox benchmarks share `benchmarks/sandbox/providers.ts`
  (`ProviderConfig`: `name`, `requiredEnvVars`, `createCompute`,
  `sandboxOptions`, `timeout`, `destroyTimeoutMs`). Other areas have their own
  `providers.ts`; new domains should copy the pattern.
- Missing `requiredEnvVars` → participant is skipped with a log; all skipped →
  clean `NoAvailableParticipantsError` exit. `--provider` filters further.
- **Vercel always gets `sandboxOptions: { persistent: false }`** — the default
  auto-snapshots on every `stop()` and accrues Snapshot Storage.
- `defaultProviders` limits what runs without `--provider` (e.g. dax runs a
  subset by default).

## 5. Scoring and display

- `scoring.metrics`: `weights.median + p95 + p99` across **all** metrics must
  sum to 1.0; `ceiling` = worst acceptable value; `higherIsBetter: true` +
  `floor` for throughput-style metrics; `trim` (default 0.05) drops outliers
  before median/p95/p99.
- Prefer `scoring` (validated at startup); use `onScore` only when a metric
  needs a function extractor.
- `display.steps[].key` must exactly match `step()` names;
  `display.metrics[].key` matches `measure()` keys. Undeclared keys still
  render — declarations only improve labels/units/direction.
- `scoring.groupBy` renders a breakout per distinct `data` value (only with
  2–12 values) — different from top-level `groupBy` (execution ordering).

## 6. Verify

```bash
# packages/*/dist is not committed — build once first
pnpm -r --filter "./packages/**" build
pnpm typecheck

# Dry run still requires platform auth, but skips ingestion
BENCHMARKS_PLATFORM_API_KEY=bp-... pnpm exec bench run \
  benchmarks/<area>/<name>.bench.ts --provider <name> --iterations 2 --dry-run
```

- No provider creds? Exercise the file with a stub participant
  (`requiredEnvVars: []`), or use the `local-platform-e2e` skill to run against
  a local benchmarks-platform.
- Check the run page URL printed by the runner when not dry-running.

## 7. Wire it in

- `package.json`: add `"bench:<name>"` (and `bench:<name>:<provider>` variants
  when useful) following the existing script shape.
- CI: copy the closest workflow in `.github/workflows/` — provider matrix,
  `load-vault-secrets.sh` regex (add any new env var names), shared
  `--run-key "$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"`, `--no-ingest` on push,
  `SHOULD_RUN` guard for single-provider dispatch.
- `results/` legacy JSON + `generate-*.svg` only if the README/results pipeline
  consumes the new benchmark — otherwise skip the legacy writers.
- Draft PR by default.

## Gotchas

Read `WRITING_BENCHMARKS.md` § "Common gotchas" before debugging: stale
`dist/`, `--iterations` scaling per-phase, env-filtered participants, the
weight-sum rule, outcome-shaped step returns, round-vs-participant step
ownership, Vercel `persistent: false`.
