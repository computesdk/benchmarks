# ComputeSDK Benchmarks

**The default platform for cloud infrastructure benchmarks.**

ComputeSDK Benchmarks publishes reproducible, provider-neutral performance measurements for the infrastructure that AI agents and developer platforms run on: sandboxes, object storage, headless browsers, and AI gateways. Every test is automated, every result is committed as JSON, and the methodology is public.

Live leaderboards and full methodology: [https://www.computesdk.com/benchmarks](https://www.computesdk.com/benchmarks)

For LLMs and agents: see [`llms.txt`](./llms.txt) for a machine-readable index of this repo, and [`results/schema.json`](./results/schema.json) for the JSON Schema of every benchmark result file.

## Writing and running benchmarks

- [`WRITING_BENCHMARKS.md`](./WRITING_BENCHMARKS.md) — step-by-step guide to authoring benchmarks.
- [`examples/`](./examples) — runnable `*.bench.ts` examples covering every benchsdk capability.
- [`packages/create-bench/README.md`](./packages/create-bench/README.md) — scaffold a new benchmark project in one command.
- [`packages/benchsdk-runner/README.md`](./packages/benchsdk-runner/README.md) — runner API and `bench run` reference.
- [`.agents/skills/benchsdk-cli/SKILL.md`](./.agents/skills/benchsdk-cli/SKILL.md) — full `bench` CLI reference (auth, org, runs, results, artifacts, export).

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

## What We Measure

We benchmark the infrastructure that AI agents and developer platforms rely on:

- **Sandboxes** — concurrent **Time to Interactive (TTI)**: API request to first successful command inside a fresh sandbox; **Dax**: a pinned OpenCode clone/install/typecheck workload.
- **Object storage** — upload/download latency and throughput across providers and file sizes.
- **Headless browsers** — session creation, navigation, and step throughput.
- **AI gateways** — cold/warm connection latency and time to first token.

## Methodology

Each suite uses a shared open workload across its participating providers, with provider-specific setup and resource mappings. Scored benchmarks declare **per-metric ceilings and weights**, not one universal ceiling: for example, sandbox TTI uses 10,000 ms and Dax uses 200,000 ms. Ceilings set the scoring scale; execution deadlines and workload checks decide pass/fail. Scored metrics report median, P95, and P99, and the weighted metric score is multiplied by the benchmark's success rate. Some probes do not declare composite scoring. Tests run on suite-specific schedules, and published results are committed as JSON to this repo.

For full details on each suite, see:

- [Sandbox TTI, Dax, and per-suite scoring methodology →](./METHODOLOGY.md)
- [Browser and throughput methodology →](./THROUGHPUT.md)
- [AI gateway methodology →](./AI_GATEWAYS.md)

## Transparency

- 📖 **Open source** — All benchmark code is public
- 📊 **Raw data** — Every result committed to repo as JSON
- 🔁 **Reproducible** — Anyone can run the same tests
- ⚙️ **Automated** — Suite-specific workflows; sandbox TTI and Dax run weekly on Fridays at 13:00 and 13:30 UTC, respectively
- 🛡️ **Independent** — Sponsors cannot influence results

## Latest Benchmarks

> **Retired benchmarks:** The sequential and staggered sandbox TTI tests have been retired. Historic results are still accessible in the [`results/`](./results) directory under [`sequential_tti/`](./results/sequential_tti) and [`staggered_tti/`](./results/staggered_tti).

### [Burst TTI](#burst-tti)

![Burst TTI](./burst_tti.svg)

### [Pricing Comparison](#pricing-comparison)

![Pricing Comparison](./pricing.svg)

### [Browser Sessions](#browser-sessions)

![Browser Sessions](./browser.svg)

### [Browser Step Throughput](#browser-step-throughput)

![Browser Sessions](./browser-throughput.svg)

### [Object Storage](#object-storage)

![Object Storage — 10MB](./storage_10mb.svg)

### [Snapshot & Fork](#snapshot--fork)

![Object Storage Snapshot & Fork](./snapshot_fork_small.svg)

### [DAX Sandbox Builds](#dax-sandbox-builds)

![DAX Sandbox Builds](./dax.svg)

### [AI Gateway - Anthropic](#ai-gateway---anthropic)

![AI Gateway - Anthropic](./ai-gateway.svg)

### [AI Gateway - OpenAI](#ai-gateway---openai)

![AI Gateway - OpenAI](./ai-gateway-openai.svg)

### [AI Gateway - Gemini](#ai-gateway---gemini)

![AI Gateway - Gemini](./ai-gateway-gemini.svg)

### [AI Gateway - Kimi](#ai-gateway---kimi)

![AI Gateway - Kimi](./ai-gateway-kimi.svg)

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
