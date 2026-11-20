# ComputeSDK Benchmarks

**The default platform for cloud infrastructure benchmarks.**

ComputeSDK Benchmarks publishes reproducible, provider-neutral performance measurements for the infrastructure that AI agents and developer platforms run on: sandboxes, object storage, headless browsers, and AI gateways. Every test is automated, every run is ingested into the [benchmark platform](https://platform.computesdk.com), and the methodology is public.

Live leaderboards and full methodology: [https://www.computesdk.com/benchmarks](https://www.computesdk.com/benchmarks)

Results, run history and access controls live on the [benchmark platform](https://platform.computesdk.com). Results and generated charts are no longer committed to this repository; earlier JSON results and charts remain available in Git history.

For LLMs and agents: see [`llms.txt`](./llms.txt) for a machine-readable index of this repo.

## Writing and running benchmarks

- [`examples/`](./examples) — runnable `*.bench.ts` examples covering every benchsdk capability.
- [`packages/create-bench/README.md`](./packages/create-bench/README.md) — scaffold a new benchmark project in one command.
- [`packages/benchsdk-runner/README.md`](./packages/benchsdk-runner/README.md) — runner API and `bench run` reference.
- [`packages/benchsdk-cli/README.md`](./packages/benchsdk-cli/README.md) — `bench` CLI reference.
- [`.agents/skills/benchsdk-cli/SKILL.md`](./.agents/skills/benchsdk-cli/SKILL.md) — full `bench` CLI reference (auth, org, runs, results, artifacts, export).

Public suites live in `benchmarks/<category>/`; suites whose results use stealth platform access live in `benchmarks/stealth/<category>/`. The `stealth/` directory marks suite membership, not source-code access: the platform controls who can see results.

Run a suite locally with Node.js 24 and the pnpm version declared in `package.json`:

```bash
pnpm install --frozen-lockfile --ignore-scripts
pnpm -r --filter './packages/**' run build

# Supply the provider credentials required by the suite.
# Add BENCHMARKS_PLATFORM_API_KEY to ingest a run; --no-ingest keeps it local.
pnpm exec tsx packages/benchsdk-runner/dist/bin.js run benchmarks/sandbox/tti.bench.ts --provider e2b --iterations 1 --no-ingest
pnpm bench:stealth benchmarks/stealth/sandbox/cpu.bench.ts --provider e2b --iterations 1 --no-ingest
```

Local diagnostics may be written to ignored `results/` directories; they are not the publication mechanism. CI runs ingest through BenchSDK.

Validate changes:

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

## Partners

Our partners support our independent benchmarks.

<p align="center"><sub><strong>★ SILVER</strong></sub></p>
<p align="center">
  <a href="https://latitude.sh/?utm_source=github&utm_medium=readme&utm_campaign=benchmarks-sponsor">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://logos.computesdk.com/api/svg/latitude/bounded/logo-dark">
      <img src="https://logos.computesdk.com/api/svg/latitude/bounded/logo-light" alt="Latitude" height="36">
    </picture>
  </a>
  &nbsp;&nbsp;&nbsp;
  <a href="https://cloud.google.com/run?utm_source=github&utm_medium=readme&utm_campaign=benchmarks-sponsor">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://logos.computesdk.com/api/svg/google-cloud-run/bounded/logo-dark">
      <img src="https://logos.computesdk.com/api/svg/google-cloud-run/bounded/logo-light" alt="Google Cloud Run" height="36">
    </picture>
  </a>
</p>

<p align="center"><sub><strong>+ BRONZE</strong></sub></p>
<p align="center">
  <a href="https://www.browserbase.com/?utm_source=github&utm_medium=readme&utm_campaign=benchmarks-sponsor">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://logos.computesdk.com/api/svg/browserbase/bounded/logo-dark">
      <img src="https://logos.computesdk.com/api/svg/browserbase/bounded/logo-light" alt="Browserbase" height="26">
    </picture>
  </a>
  &nbsp;&nbsp;&nbsp;
  <a href="https://www.tigrisdata.com/?utm_source=github&utm_medium=readme&utm_campaign=benchmarks-sponsor">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://logos.computesdk.com/api/svg/tigris/bounded/logo-dark">
      <img src="https://logos.computesdk.com/api/svg/tigris/bounded/logo-light" alt="Tigris" height="26">
    </picture>
  </a>
  &nbsp;&nbsp;&nbsp;
  <a href="https://neon.com/?utm_source=github&utm_medium=readme&utm_campaign=benchmarks-sponsor">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://logos.computesdk.com/api/svg/neon/bounded/logo-dark">
      <img src="https://logos.computesdk.com/api/svg/neon/bounded/logo-light" alt="Neon" height="26">
    </picture>
  </a>
  &nbsp;&nbsp;&nbsp;
  <a href="https://www.gitbook.com/?utm_source=github&utm_medium=readme&utm_campaign=benchmarks-sponsor">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://logos.computesdk.com/api/svg/gitbook/bounded/logo-dark">
      <img src="https://logos.computesdk.com/api/svg/gitbook/bounded/logo-light" alt="GitBook" height="26">
    </picture>
  </a>
</p>

<p align="center"><sub><strong>BENCHMARKS POWERED BY</strong></sub></p>
<p align="center">
  <a href="https://namespace.so/?utm_source=github&utm_medium=readme&utm_campaign=benchmarks-sponsor">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://logos.computesdk.com/api/svg/namespace/bounded/logo-dark">
      <img src="https://logos.computesdk.com/api/svg/namespace/bounded/logo-light" alt="Namespace" height="30">
    </picture>
  </a>
</p>

<p align="center"><a href="./SPONSORSHIP.md">Become a sponsor →</a></p>

<br>

<br>

## What We Measure

We benchmark the infrastructure that AI agents and developer platforms rely on:

- **Sandboxes** — concurrent **Time to Interactive (TTI)**: API request to first successful command inside a fresh sandbox; **Dax**: a pinned OpenCode clone/install/typecheck workload.
- **Object storage** — upload/download latency and throughput across providers and file sizes.
- **Headless browsers** — session creation, navigation, and step throughput.
- **AI gateways** — cold/warm connection latency and time to first token.

## Methodology

Each suite uses a shared open workload across its participating providers, with provider-specific setup and resource mappings. Scored benchmarks declare **per-metric ceilings and weights**, not one universal ceiling: for example, sandbox TTI uses 10,000 ms and Dax uses 200,000 ms. Ceilings set the scoring scale; execution deadlines and workload checks decide pass/fail. Scored metrics report median, P95, and P99, and the weighted metric score is multiplied by the benchmark's success rate. Some probes do not declare composite scoring. Tests run on suite-specific schedules, and every run is ingested into the benchmark platform.

### Regions

Browserbase uses Oregon (`us-west-2`) for both sessions and benchmark runners in the lifecycle, throughput, concurrency, file transfer, idle resume, and session persistence suites. Tigris storage and snapshot benchmarks use Oregon runners and the existing global S3 endpoint. The public browser lifecycle and throughput workflows run Browser Use in Ohio (`us-east-2`). Compare historical latencies with the runner and session regions in mind.

### Browser cookie normalization

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

## Transparency

- 📖 **Open source** — All benchmark code is public
- 📊 **Raw data** — Every run is ingested into the [benchmark platform](https://platform.computesdk.com) with its run history
- 🔁 **Reproducible** — Anyone can run the same tests
- ⚙️ **Automated** — Suite-specific workflows; sandbox TTI and Dax run weekly on Fridays at 13:00 and 13:30 UTC, respectively
- 🛡️ **Independent** — Sponsors cannot influence results

## Latest Benchmarks

Charts are no longer committed here. The live leaderboards are on computesdk.com:

- [Burst TTI](https://www.computesdk.com/benchmarks/sandboxes/burst-tti)
- [OCI Boot TTI](https://www.computesdk.com/benchmarks/sandboxes/oci-boot-tti)
- [Sandbox Reliability](https://www.computesdk.com/benchmarks/sandboxes/reliability)
- [DAX Sandbox Builds](https://www.computesdk.com/benchmarks/sandboxes/dax)
- [Browser Sessions](https://www.computesdk.com/benchmarks/browsers/lifecycle)
- [Browser Step Throughput](https://www.computesdk.com/benchmarks/browsers/browser-throughput)
- [Object Storage](https://www.computesdk.com/benchmarks/storage/lifecycle)
- [Snapshot & Fork](https://www.computesdk.com/benchmarks/storage/snapshot-fork)
- [AI Gateways](https://www.computesdk.com/benchmarks/ai-gateway)

> **Retired benchmarks:** The sequential and staggered sandbox TTI tests have been retired. Their historic results remain in Git history under `results/sequential_tti/` and `results/staggered_tti/`.

### DAX resource configuration

The [DAX resource configuration](./benchmarks/sandbox/dax.bench.ts) generally targets
8 vCPUs and 16 GiB RAM. Modal uses the VM runtime with its default CPU request of
0.125 physical cores and a burst limit of 8 physical cores (16 vCPU equivalent). Its 16 GiB memory
request has no explicit memory limit, allowing memory bursting when host capacity
is available. Modal [bills CPU and memory at the greater of request or actual usage](https://modal.com/docs/guide/sandbox-resources),
including usage above the memory request.

## Roadmap

- [x] computesdk.com/benchmarks
- [x] Add P95 & P99
- [x] TTI n=100 test
- [x] TTI n=100 concurrency test (staggered + burst)
- [x] 100,000 concurrent sandbox stress test
- [ ] Cold start vs warm start metrics
- [ ] Multi-region testing
- [x] Cost-per-sandbox-minute

<br>

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

**Powered by ComputeSDK** — We use [ComputeSDK](https://github.com/computesdk/computesdk), a multi-provider SDK, to test all sandbox providers with the same code. One API, multiple providers, fair comparison.

MIT License
