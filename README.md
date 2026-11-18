# ComputeSDK Benchmarks

Reproducible benchmarks for sandbox, browser, object storage and AI gateway providers, plus the BenchSDK packages that run them.

Results, run history and access controls live on the [benchmark platform](https://platform.computesdk.com). Public leaderboards are available at [computesdk.com/benchmarks](https://www.computesdk.com/benchmarks). Results and generated charts are no longer committed to this repository; existing Git history remains available.

## Layout

```text
benchmarks/
  sandbox/           # Public benchmark suites
  browser/
  storage/
  ai-gateway/
  reliability/
  scale/
  stealth/           # Open source suites whose results use stealth platform access
    sandbox/
    browser/
    storage/
    composite/
    web-data/
    src/             # Stealth scoring and suite helpers
    scripts/         # Stealth setup and local diagnostic tools
  src/               # Public suite helpers
  scripts/           # Public setup and operational scripts
packages/            # BenchSDK runner, client, CLI, API, worker and scaffolder
examples/            # Runnable benchmark authoring examples
.computesdk/workflows/ # Live stealth execution on the benchmark platform
.github/workflows/   # Validation CI and existing public-suite workflows
```

The `stealth/` directory delineates suite membership, not source-code access. The platform controls who can see results. A folder move does not change platform visibility, grouping or benchmark IDs.

Provider registries and scoring helpers that differ between the old repositories remain scoped to their suites to preserve measurements. Reconcile them separately when their behavior can be verified as equivalent.

## Run locally

Use Node.js 24 and the pnpm version declared in `package.json`.

```bash
pnpm install --frozen-lockfile --ignore-scripts
pnpm -r --filter './packages/**' run build

# Supply the provider credentials required by the suite.
# Add BENCHMARKS_PLATFORM_API_KEY to ingest a run; --no-ingest keeps it local.
pnpm exec tsx packages/benchsdk-runner/dist/bin.js run benchmarks/sandbox/tti.bench.ts --provider e2b --iterations 1 --no-ingest
pnpm bench:stealth benchmarks/stealth/sandbox/cpu.bench.ts --provider e2b --iterations 1 --no-ingest
```

Local diagnostics may be written to ignored `results/` directories. They are not the publication mechanism. CI runs ingest through BenchSDK; legacy result collectors, generated charts and result-committing steps have been removed.

See the [runner reference](packages/benchsdk-runner/README.md), [CLI reference](packages/benchsdk-cli/README.md), [scaffolder](packages/create-bench/README.md) and [examples](examples/) to author benchmarks. SDK documentation stays with its packages.

## Validate

```bash
pnpm typecheck
pnpm test:migration
pnpm stealth:test:fs-api
pnpm stealth:test:benchmark-setup
pnpm stealth:test:scoring
pnpm stealth:test:scoring:active
node --test tests/stealth/cpu-local/*.test.mjs
```

The public CI and stealth harness workflows run without provider credentials. Live stealth workflows live only in `.computesdk/workflows/` and run through the platform, where run/log access follows platform permissions. GitHub Actions does not discover that directory. The platform also supports `.github/workflows/`, but prefers `.computesdk/workflows/` when basenames match. Live jobs require provider and platform credentials, loaded from the Namespace vault in CI.

## Migration and cutover

1. Deploy the dotcom consumer migration before merging this deletion. `src/utils/benchmark-data.ts`, comparison loaders, and `src/lib/agent-md.ts` still reference raw GitHub JSON under `results/`; switch those consumers and links to the platform first.
2. Merge the consolidated source and workflow changes. The imported `stealth-*.yml` schedules are gated by the platform repo/org configuration variable `STEALTH_BENCHMARKS_ENABLED`, which defaults to disabled; manual dispatch remains available for validation.
3. Verify vault/runner access in this repository and manually smoke-test the imported suites. Preserve existing platform slugs, names, grouping and visibility. Use the existing workflow inputs to select the intended slug when dispatching; schedule defaults still use the existing `-stealth` IDs.
4. Update the platform's source links and workflow dispatch configuration from `computesdk/benchmarks-stealth@main` to `computesdk/benchmarks@master`, paths under `benchmarks/stealth/`, and workflow paths `.computesdk/workflows/stealth-*.yml`.
5. Pause schedules for the old repository in the platform (and disable any GitHub schedules still active there), then set `STEALTH_BENCHMARKS_ENABLED=true` in the platform for this repository. The imported reliability workflow is dispatch-only until cutover: restore its original every-minute `on.schedule` only when its platform routing has switched, so disabled jobs cannot create missed reliability slots. Do not run both sets of schedules. Verify ingested runs and source links before retiring the old repository.

The soak suite uses a provider-scoped CI cache for operational sandbox state rather than committing state under `results/`. Transfer its current state before its first production shift if the current epoch must continue; without a cache it starts a fresh epoch. Cache eviction can also start a fresh epoch. Cached state is not a results archive and must not contain credentials. OCI template provisioning retains its separate provider artifact registry, which is execution configuration rather than benchmark results.

This migration does not change repository visibility, platform configuration, or schedules in the old repository. It imports the current source snapshot, not the internal repository's Git history.

## License

[MIT](LICENSE)
