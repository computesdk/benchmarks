# Technical methodology

This document describes the source in this repository. A historical result must be evaluated against the commit and effective workflow inputs that produced it; the current default branch is not proof of a past run's configuration. See the [suite index](suites.md) for workload and workflow entry points and the [public results](https://www.computesdk.com/benchmarks) for published measurements.

## What is open, and what can be reproduced

The workloads, provider configurations, scoring helpers and workflow definitions are public, including the suites under `benchmarks/stealth/` imported from the former private repository. The directory name preserves suite membership and platform identifiers. It does not restrict source access.

Results are ingested into the benchmark platform, rather than committed to GitHub. Local legacy JSON writers are diagnostic adapters, not the current publication mechanism. Platform permissions control raw measurements, logs and daily Stealth runs; the website publishes weekly Stealth summaries. Reading the code does not require a subscription. Auditing a particular restricted run still requires access to its underlying records.

For a local run, follow [README setup](../README.md#run-locally), select a provider, and pass `--no-ingest`. The current [runner](../packages/benchsdk-runner/src/runner.ts) makes platform authentication optional in that mode. It still creates real provider resources and requires their credentials. A one-iteration smoke test verifies execution, not a published ranking.

## Trace a result to its implementation

1. Identify the benchmark slug, provider, run date and source commit. Check the effective workflow inputs, not just defaults in `config`.
2. Read its `*.bench.ts` entry point: `config` declares participants, iterations, concurrency and scoring; `task` defines timed work, verification, failures and cleanup. Imported scripts and helpers are part of the workload.
3. Read the provider registry and any per-suite overrides for image/template, resource size, region and timeout differences. Inspect the workflow matrix to see which registered providers actually ran.
4. Follow `scoring`, `onScore` and imported scoring helpers. A custom scoring path can differ from the shared scorer below. Compare the emitted scoring version and spec when available.
5. Distinguish raw metrics, a run's composite, a weekly benchmark cell and the category rating. These are different aggregations.

The [public-suite workflows](../.github/workflows/) and [Stealth platform workflows](../.computesdk/workflows/) supply execution settings. GitHub Actions does not discover `.computesdk/workflows/`. A checked-in schedule does not establish that it is enabled in production; the [cutover runbook](migration.md) covers that routing.

## Workload choices and measured boundaries

### Sandbox burst time to interactive

The [TTI task](../benchmarks/sandbox/tti.bench.ts) measures sandbox creation plus the first successful `node -v`. A create response alone does not establish that commands work, which is why a command is included. Destroy is a separately recorded cleanup step and is excluded from TTI. The command must exit with code zero.

The [weekly workflow](../.github/workflows/sandbox-tti-benchmarks.yml) defaults to 100 iterations and concurrency 100 per provider. The file's local defaults are two iterations and concurrency one. Providers run in separate matrix jobs, so the workload requests a burst for each provider but does not synchronize all providers to the same instant. Manual dispatch can change the shape.

Creation defaults to a 120-second timeout with provider overrides; first command has a 30-second timeout and destroy defaults to 15 seconds. The **10-second scoring ceiling is not the execution timeout**. The score is:

```text
latencyScore(t) = 100 × max(0, 1 − t / 10,000 ms)
composite = (0.60 × latencyScore(median)
           + 0.25 × latencyScore(P95)
           + 0.15 × latencyScore(P99)) × successRate
```

The weights favor typical readiness while retaining a tail penalty. They and the ceiling are scoring policy, not an industry standard or an SLA. Once a latency reaches the ceiling, this linear score cannot distinguish further degradation; inspect the measured times as well. Provider templates, region and network distance affect this end-to-end client measurement.

### Sandbox DAX

The [task](../benchmarks/sandbox/dax.bench.ts) uploads and executes the [build script](../benchmarks/scripts/dax-benchmark.sh) in a new sandbox. It prepares system dependencies, clears caches where permitted, downloads/unpacks Bun, clones OpenCode at a pinned commit, installs dependencies and typechecks. Defaults pin OpenCode to `08fb47373509ba64b13441061314eeacf4264f51` and Bun to `1.3.14`; environment overrides are in the script.

This exercises a developer setup/build path across network, package tooling, filesystem and CPU. It is not an isolated CPU test. Provider resource options target 8 vCPU and 16 GiB where configurable, with provider exceptions and template requirements in the task. Guest cache dropping can be unavailable and does not establish a cold host cache. Package mirrors and upstream services remain external dependencies.

Phase completion (`7/7`) is a separate display metric. The platform composite scores `totalMs` against 200,000 ms with weights 60% median, 25% P95 and 15% P99, then multiplies by success rate. The task comment records the ceiling's calibration: twice the observed P90 of provider medians (32–121 seconds). Execution has a separate 600-second timeout. The [weekly workflow](../.github/workflows/sandbox-dax-benchmarks.yml) defaults to one iteration; that run provides no meaningful estimate of a tail distribution.

### Sandbox CPU

The [CPU task](../benchmarks/stealth/sandbox/cpu.bench.ts) runs the [hashing script](../benchmarks/stealth/scripts/cpu-benchmark.sh) once on one core and once across logical CPUs. Scored metrics use in-sandbox hashing time; create/destroy are separate steps. Results are grouped by [market size tier](../benchmarks/stealth/sandbox/sizes.ts), with three iterations per tier by default. Unsupported sizes fail rather than silently substituting a different size.

The headline metric divides multi-core throughput by the tier's expected vCPU count, so delivering fewer cores does not gain a per-core advantage. Multi-core per-vCPU throughput has 60% total weight (45/10/5 across median/P95/P99); single-core throughput has 40% (30/7/3). Both use the [continuous scoring helper](../benchmarks/stealth/sandbox/performance-runtime-scoring.ts) with reference 2,000 MB/s and full precision. Its higher-is-better transform is `100 × x / (x + reference)`, followed by the success-rate multiplier. The completion gate requires `done: true` and validates the expected byte totals.

SHA-256 throughput depends on CPU architecture, acceleration and scheduling. It is not a general application-performance score. Three observations per tier cannot characterize rare slowdowns.

### Browser and storage controls

Browser [lifecycle](../benchmarks/browser/browser.bench.ts) includes create, CDP connection, navigation to `https://www.example.com`, browser close and session release in its total. [Throughput](../benchmarks/browser/browser-throughput.bench.ts) scores a ten-action Wikipedia loop inside an existing session and reports lifecycle timings separately. Its workflow supplies the same article list across providers; local runs without `THROUGHPUT_URLS` use random articles and are less comparable. The default 15-second gap between sessions is outside measured actions and reduces rate limiting.

Wikipedia suites [seed a session cookie](../benchmarks/browser/wikipedia.ts) before measurement to normalize observed HTTP 429 behavior on cloud networks. Setup makes no HTTP request and is outside measured action/connection/lifecycle timings; first navigation still includes DNS and connection setup. This is an observed workaround, not a Wikimedia guarantee. Measured navigations are not retried and HTTP errors count against completion. Lifecycle and other suites that do not navigate Wikipedia do not use this control.

Browserbase lifecycle/throughput/concurrency and several Stealth browser suites use Oregon session and runner regions. Browser Use's public lifecycle/throughput workflows use Ohio runners. Tigris storage/snapshot uses Oregon runners with the global S3 endpoint. Consult each workflow and provider registry for the exact pairing; this is not a universal equal-distance comparison.

[Storage lifecycle](../benchmarks/storage/storage.bench.ts) groups results by object size; the website uses 10 MB. [Snapshot/fork](../benchmarks/storage/snapshot-fork.bench.ts) measures native branch operations and first read. Unsupported operations and different size/dataset dimensions should not be collapsed into one latency comparison. [AI gateway](../benchmarks/ai-gateway/) workloads use per-family prompts and models, cold/warm phases and direct-provider baselines; model execution, output length and upstream load also affect latency.

## Shared run scoring and statistics

The implementation is [runner scoring](../packages/benchsdk-runner/src/scoring.ts). These rules apply to workloads using it; inspect custom helpers before applying them to other suites.

- Metric samples come from records whose status is `success`, ignoring non-finite values. Error records can contain partial data but are excluded from percentile samples. A completed record that fails an extra `requireData` gate can still supply measured values; the gate reduces success rate and the composite.
- Success rate is passing task records divided by all task records, before trimming. A suite may require fields such as verified bytes or full action completion in addition to a successful task status. No records is a skipped result; it is different from attempted tasks that all fail.
- By default, samples are sorted and `floor(n × 0.05)` observations are removed from **each end**, provided samples remain. Individual metrics can override `trim`. Median is the middle retained observation, or the average of the two central observations. P95/P99 use nearest rank (`ceil(p × n) − 1`) **on the retained samples**.
- With 100 observations and default trimming, P99 is the maximum of the 90 retained observations, not the original distribution's P99. Trimming reduces outlier influence but hides extreme tail behavior; do not interpret these percentiles as untrimmed production SLAs. Raw task records are needed to evaluate excluded extremes.
- Linear lower-is-better scores use a ceiling; higher-is-better scores use floor and ceiling, clamped to 0–100. Optional reciprocal transforms use a reference value instead. Weights sum across all metrics and percentiles to one. Missing metric samples contribute no points; weights are not redistributed.
- The weighted score is multiplied by success rate. Default composites round to two decimal places; `precision: 'full'` retains the full value. Equal displayed scores can mask different raw measurements.

These are point estimates. The scorer does not produce confidence intervals, significance tests or a causal explanation for a difference. A small score gap alone does not establish a stable winner.

## Weekly benchmark scores and category ratings

The [weekly task](../benchmarks/stealth/composite/provider-weekly-composite.bench.ts) and [aggregation helpers](../benchmarks/stealth/composite/provider-weekly-composite.ts) read the previous seven complete UTC days; they do not provision sandboxes or browsers themselves. Multiple scored runs for a benchmark on one day are averaged first.

Sandbox category ratings average benchmark scores into five equally weighted groups: startup, compute, filesystem, state and reliability. The day's score averages the groups with data, then the week's score averages counted days. On a day where a provider has at least one real score, another benchmark that ran but has no scored row for that provider is zero-filled. A benchmark that did not run is excluded for everyone. A provider with no real scores for the entire day does not get a zero-filled day.

Browser ratings use each benchmark as its own group and skip missing scores. This differs from sandbox zero-filling. Per-benchmark weekly cells average the days counted by the aggregation, including sandbox zero-fills; they are not always averages of measured observations alone. Existing zero is a score, and absent data remains distinguishable from zero. Category ratings depend on benchmark coverage as well as speed.

## Limits of the evidence

Provider defaults, pricing tiers, CPU/RAM allocation, region, templates, warm caches, quotas, network routes and external services can differ. The task and workflow record deliberate controls and exceptions; the suite is not proof of identical hardware, cost or network distance. A provider registered in code may be disabled in a workflow or excluded on the website. Published weekly summaries are insufficient to reconstruct private daily distributions.

The code establishes **what** a benchmark does. Where a historical design decision has no recorded rationale, do not infer one from the implementation. This repository does not provide a complete record of authoring prompts or all past design discussions. An audit should identify missing rationale as an evidence gap, rather than treating open source alone as proof of fairness.

When proposing a methodology change, state the measured user outcome, timed boundaries, chosen controls, known provider exceptions, sample/timeout/retry policy, scoring calibration and a before/after example. Include source commit and run evidence when available. [Issues](https://github.com/computesdk/benchmarks/issues) are the public place to question or improve those choices.
