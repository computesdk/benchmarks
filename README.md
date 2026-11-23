<a href="https://www.computesdk.com/">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://www.computesdk.com/share/computesdk-logo-dark.svg">
    <img src="https://www.computesdk.com/share/computesdk-logo-light.svg" alt="ComputeSDK" width="300">
  </picture>
</a>

# ComputeSDK Benchmarks

We use the sandbox benchmark results as a reference when developing [ComputeSDK Sandbox Router](https://www.computesdk.com/sandbox-router). The benchmarks run directly against providers to measure startup time, build performance, and reliability independently of the router.

Browse reproducible performance measurements for [sandboxes](https://www.computesdk.com/benchmarks/sandboxes), [browsers](https://www.computesdk.com/benchmarks/browsers), [storage](https://www.computesdk.com/benchmarks/storage), and [AI gateways](https://www.computesdk.com/benchmarks/ai-gateway).

[Public rankings](https://www.computesdk.com/benchmarks) · [Methodology](https://www.computesdk.com/methodology) · [Stealth benchmarks](https://www.computesdk.com/stealth-benchmarks) · [ComputeSDK](https://www.computesdk.com/) · [TypeScript SDK](https://github.com/computesdk/computesdk)

The public rankings and scoring methodology are free to browse. This repository contains the benchmark workloads and the BenchSDK packages used to run them. Use the [benchmark platform](https://platform.computesdk.com) to query raw results and run history, or to run benchmarks for your own organization.

## Run benchmarks and read results on the platform

Use the [benchmark platform](https://platform.computesdk.com) to collect results from your runs, review logs and artifacts, and query the measurements you have access to.

### Connect to the platform

1. Sign in at [platform.computesdk.com](https://platform.computesdk.com) to create your organization.
2. Install the `bench` CLI: `npm install -g @benchsdk/runner`.
3. Authenticate with `bench auth login` (device-code login), or create an API key under **Settings → API keys** and export it as `COMPUTESDK_API_KEY`.

### Run a benchmark in your organization

Clone this repository, build the packages (see [Run locally](#run-locally)) and run any suite without `--no-ingest`. The run is uploaded to your organization, and its results, logs and artifacts appear on the platform dashboard.

```bash
export COMPUTESDK_API_KEY=bp_...   # or: bench auth login
export E2B_API_KEY=...                       # credentials for the providers you select
pnpm exec tsx packages/benchsdk-runner/dist/bin.js run benchmarks/sandbox/tti.bench.ts --provider e2b --iterations 10
```

To keep your own copy of a published benchmark, fork it into your organization. The fork is a private benchmark that tracks the upstream `.bench.ts` file:

```bash
bench fork sandbox-tti --source-org computesdk
```

The dashboard has a **Fork** button on the benchmark overview that does the same thing.

### Run a benchmark in ComputeSDK Actions

[ComputeSDK Actions](https://www.computesdk.com/actions) runs supported GitHub workflows on Sandbox Router. Use managed compute or bring your own provider keys (BYOK).

1. Fork this repository.
2. On the platform, connect your GitHub account (**Settings → Git Connections**) and enable your fork under **Actions → Repos**.
3. Pick where jobs run under **Settings → Providers**: a provider from the router, or your own provider key.
4. Add `COMPUTESDK_API_KEY` and the credentials of the providers you benchmark as Actions secrets (**Settings → Actions setup**). In your fork, map these secrets to the benchmark step's environment variables.
5. Start a workflow with the **Run workflow** button or the `compute` CLI ([`@computesdk/cli`](https://www.npmjs.com/package/@computesdk/cli)):

```bash
compute actions dispatch <you>/benchmarks --workflow .github/workflows/sandbox-tti-benchmarks.yml --ref master
```

The run's benchmark results show on the Actions run page and on the benchmark in your organization. The workflows in this repository load provider credentials from ComputeSDK's own vault; in your fork, point them at your Actions secrets.

### Read results

Public benchmarks are published by the `computesdk` organization (`sandbox-tti`, `sandbox-dax`, `sandbox-reliability`, `browser-lifecycle`, `browser-throughput`, `storage-lifecycle`, `snapshot-fork`, `ai-gateway-latency-*` and `ai-gateway-model-index`). List them with `bench benchmarks list --group public`. The CLI, API, and MCP server require a platform credential.

| Surface | How to use it |
|---|---|
| Website | Public leaderboards at [computesdk.com/benchmarks](https://www.computesdk.com/benchmarks) |
| Dashboard | Runs, results, logs and artifacts at [platform.computesdk.com](https://platform.computesdk.com) |
| CLI | `bench results sandbox-tti --source-org computesdk`; also `bench runs list`, `bench reliability`, `bench export`. See the [CLI reference](packages/benchsdk-cli/README.md) |
| API | `GET https://platform.computesdk.com/api/v1/benchmarks/~/computesdk/sandbox-tti/results` with `Authorization: Bearer $COMPUTESDK_API_KEY`. The OpenAPI document is at `/api/v1/openapi.json` |
| MCP | Connect an MCP client to `https://platform.computesdk.com/mcp` (OAuth or an org API key as a bearer token). Tools include `benchmarks_list`, `benchmarks_get_results`, `benchmarks_get_run_results` and `benchmarks_get_reliability` |

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
# Add COMPUTESDK_API_KEY to ingest a run; --no-ingest keeps it local.
pnpm exec tsx packages/benchsdk-runner/dist/bin.js run benchmarks/sandbox/tti.bench.ts --provider e2b --iterations 1 --no-ingest
pnpm bench:stealth benchmarks/stealth/sandbox/cpu.bench.ts --provider e2b --iterations 1 --no-ingest
```

Local diagnostics may be written to ignored `results/` directories. They are not the publication mechanism. CI runs ingest through BenchSDK; legacy result collectors, generated charts and result-committing steps have been removed.

## BenchSDK packages

| Package | Use it to |
|---|---|
| [`@benchsdk/runner`](packages/benchsdk-runner/README.md) | Write and run benchmarks and install the `bench` CLI |
| [`create-bench`](packages/create-bench/README.md) | Scaffold a TypeScript benchmark project |
| [`@benchsdk/api`](packages/benchsdk-api/README.md) | Query the benchmark platform from TypeScript |
| [`@benchsdk/cli`](packages/benchsdk-cli/README.md) | Integrate platform authentication and commands into tooling |
| [`@benchsdk/worker`](packages/benchsdk-worker/README.md) | Execute assignments and report results to the platform |
| [`@benchsdk/client`](packages/benchsdk/README.md) | Maintain existing integrations that use the legacy client |

See the [runnable examples](examples/) for workloads you can adapt.

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
