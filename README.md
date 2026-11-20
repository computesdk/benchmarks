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

Public browser throughput, concurrency (public and stealth), and stealth
Playwright-native throughput seed a secure `WMF-Last-Access-Global` session cookie
on `.wikipedia.org`, using the current UTC date, before the first measured
navigation for every provider. The Playwright URL-preparation script seeds it too.
This normalizes cookie state because fresh,
cookieless sessions on some cloud networks receive Wikipedia HTTP 429 responses.
Cookie setup makes no HTTP request and is excluded from action, connection, and
total lifecycle timings; the first article navigation still includes DNS and
connection setup. The cookie workaround is based on observed behavior, not a
documented Wikimedia guarantee. Measured navigations are not retried, and HTTP
errors still count against action completion and scoring.

Concurrency prepares every context before the action barrier and starts its
action budget afterward. A cookie setup failure aborts the round and releases
all sessions. The public concurrency entry point delegates to the same workload
as the stealth suite. Browser lifecycle/readiness, idle resume, persistence,
file transfer, and protected-sites suites do not navigate Wikipedia and need no
Wikipedia cookie. The separate web-data scrape suite includes Wikipedia as an
input, but sends requests through managed scrape APIs rather than browser contexts.

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

## License

[MIT](LICENSE)
