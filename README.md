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

Browserbase uses Oregon (`us-west-2`) for both sessions and benchmark runners in the lifecycle, throughput, concurrency, file transfer, idle resume, and session persistence suites. Tigris storage and snapshot benchmarks use Oregon runners and the existing global S3 endpoint. The public browser lifecycle and throughput workflows run Browser Use in Ohio (`us-east-2`). Compare historical latencies with the runner and session regions in mind.

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

### Preserve soak state during cutover

The soak suite stores operational state in a provider-scoped platform CI cache. Deploy the [cache credential lifetime fix](https://github.com/computesdk/benchmarks-platform/pull/1065) before running long shifts. Do the handoff before setting `STEALTH_BENCHMARKS_ENABLED=true`:

1. Stop new old-repository soak shifts and let the running shift finish, including its final state commit. Record that exact commit SHA. Do not run old and new shifts concurrently.
2. Export each `results/sandbox_soak/state/<provider>.json` from that SHA using an authenticated clone or the GitHub API. Keep exports private; never add them to this public repository or a PR comment. Preserve every field, including the sandbox ID, epoch, chain head, counters and pending orphan IDs.
3. In the platform, manually dispatch `.computesdk/workflows/stealth-soak-state-import.yml` on `master` once per provider. Set `provider` to its registered name and `state_json` to the full exported JSON. The workflow validates the payload, makes no provider calls, shares the soak execution lock, and refuses to overwrite existing cached state. Run it through the platform, not GitHub Actions.
4. Verify each import succeeded before dispatching the first new soak shift. Select the existing `sandbox-soak-stealth` slug and name and use the intended production shift settings. Check the state-load/attach steps show the exported sandbox identity and chain progress. A normal epoch rollover or an already-expired sandbox may intentionally replace the sandbox; distinguish that from missing imported state.
5. After the first shift saves its cache, dispatch the second shift and verify it restores that saved state and advances progress. Keep the old workflow paused and the private exports available until this is confirmed, then enable the new schedules as part of the coordinated cutover.

The importer runs only while new schedules are disabled and only on `master`. A failed import must be investigated before starting a production shift; do not silently fall back to a fresh epoch. Cache eviction can still start a fresh epoch, so this handoff does not make CI caches durable storage. Cached state must not contain credentials. OCI template provisioning retains its separate provider artifact registry, which is execution configuration rather than benchmark results.

This migration does not change repository visibility, platform configuration, or schedules in the old repository. It imports the current source snapshot, not the internal repository's Git history.

## License

[MIT](LICENSE)
