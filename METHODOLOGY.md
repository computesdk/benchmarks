# Benchmark Methodology

This document describes sandbox TTI and Dax measurements, plus the scoring configuration used by the benchmark suites in this repository. Our goal is transparent, reproducible, and fair measurement. See [THROUGHPUT.md](./THROUGHPUT.md) for browser workloads and [AI_GATEWAYS.md](./AI_GATEWAYS.md) for AI gateway workloads.

## What We Measure

### Time to Interactive (TTI)

**Definition**: The wall-clock time from initiating a sandbox creation request to successfully executing the first command.

TTI captures the complete developer experience:

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        Time to Interactive (TTI)                        │
├─────────────┬─────────────────┬──────────────┬─────────────┬───────────┤
│ API Latency │ Provisioning    │ Boot Time    │ Health Check│ Command   │
│             │                 │              │ Polling     │ Execution │
└─────────────┴─────────────────┴──────────────┴─────────────┴───────────┘
```

This metric matters because it's what developers actually experience—the time spent waiting before they can use the sandbox.

### What's Included in TTI

- Network round-trip to provider API
- Queue time (if provider has provisioning queues)
- Infrastructure allocation (VM, container, or serverless spin-up)
- Operating system and runtime boot
- Provider daemon/agent initialization
- Health check and readiness polling
- First command network round-trip
- Command execution time (trivial for our test command)

### What's NOT Included

- Sandbox teardown/destruction time
- Subsequent command execution times
- File system operations
- Network transfer speeds within the sandbox

## Test Procedure

Each TTI iteration executes the following steps (simplified; see [tti.bench.ts](./benchmarks/sandbox/tti.bench.ts) for timeout and cleanup handling):

```typescript
// 1. Start timer
const start = performance.now();

// 2. Create sandbox and wait until ready
const sandbox = await compute.sandbox.create();

// 3. Execute a trivial command to confirm interactivity
await sandbox.runCommand('node -v');

// 4. Stop timer
const ttiMs = performance.now() - start;

// 5. Cleanup (not timed)
await sandbox.destroy();
```

### Why `node -v`?

We use a minimal command to isolate sandbox startup time from command complexity. The command:
- Has negligible execution time
- Produces deterministic output
- Validates the full request/response cycle
- Confirms the Node.js runtime is available and functional

## Test Modes

**Burst is the active TTI test shape.** Sequential and staggered TTI were retired on 2026-08-11; their historic results remain in [results/sequential_tti](./results/sequential_tti) and [results/staggered_tti](./results/staggered_tti). The old `bench:sequential` and `bench:staggered` scripts no longer exist.

### Burst TTI

The runner opens up to `concurrency` task slots at once, with no configured delay between launches. When iterations and concurrency are both 100, this launches 100 sandbox tasks per provider as a burst; it does not guarantee that requests reach the provider at exactly the same instant.

```bash
pnpm run bench:burst -- --iterations 100 --concurrency 100
```

| Scheduled TTI parameter | Value |
|-----------|---------|
| Iterations per provider | 100 |
| Concurrency | 100 sandboxes |
| Sandbox creation timeout | 120 seconds by default; provider overrides apply |
| First-command timeout | 30 seconds |
| Cleanup timeout | 15 seconds by default; provider overrides apply |

Each sandbox still measures its own individual TTI. We also capture:

| Metric | Description |
|--------|-------------|
| **Wall Clock** | Time from first launch to last measured TTI completion, excluding cleanup |
| **Time to First Ready** | Time from first launch to first measured TTI completion |
| **Individual TTI** | Per-sandbox startup time (same stats: median, p95, p99, etc.) |
| **Success Rate** | Fraction of tasks that completed creation and the first command successfully |

**Why burst matters:** AI agents and orchestration tools often spin up many sandboxes at once. Burst testing reveals how providers handle sudden spikes — provisioning queue depth, rate limiting, and failure rates under peak demand.

### Local Defaults

`pnpm run bench` and `pnpm run bench:burst` are aliases for the same TTI workload, with **3 iterations and concurrency 3**. The bench file itself defaults to 2 iterations and concurrency 1 when invoked directly without overrides. Neither script runs the retired modes or the other benchmark suites.

```bash
pnpm run bench
pnpm run bench:burst -- --provider e2b --iterations 10 --concurrency 10
```

## Test Configuration

### Automated Sandbox Runs

The checked-in [TTI workflow](./.github/workflows/sandbox-tti-benchmarks.yml) and [Dax workflow](./.github/workflows/sandbox-dax-benchmarks.yml) define these scheduled defaults. Manual inputs can override iteration counts and TTI concurrency.

| Parameter | Value |
|-----------|-------|
| TTI iterations / concurrency | 100 / 100 per provider |
| TTI schedule | Weekly, Friday at 13:00 UTC |
| Dax iterations / concurrency | 1 / 1 per provider |
| Dax schedule | Weekly, Friday at 13:30 UTC |
| Node.js version on the benchmark runner | 24.x |

These workflows also run on matching source pushes and support manual dispatch. TTI source-push runs default to 10 iterations and concurrency 10. Other suites have their own schedules in [.github/workflows](./.github/workflows).

### Provider Integration

Sandbox workloads use **ComputeSDK** through the shared [provider registry](./benchmarks/sandbox/providers.ts). Registered providers include E2B, Daytona, Blaxel, Modal, Vercel, Hopx, CodeSandbox, Cloud Run, Cloudflare, and Tensorlake, among others. The registry is the source of truth for provider clients and sandbox options; each workflow's matrix determines which providers it actually runs. Registered does not mean included in every scheduled run.

Images, templates, resource controls, and timeout overrides are provider-specific. The workload is shared, but the underlying sandbox configuration is not identical across providers.

### Provider Execution Order

The sandbox workflows run providers in separate matrix jobs, which may execute in parallel. There is no randomized provider ordering in these workflows.

For local multi-provider runs, the runner defaults to `groupBy: 'participant'` (finish one participant before the next). Dax declares `groupBy: 'round'` (one iteration per provider before the next round). These orderings are distinct from within-provider task concurrency.

## Dax: Sandbox Build Workload

[dax.bench.ts](./benchmarks/sandbox/dax.bench.ts) runs [dax-benchmark.sh](./benchmarks/scripts/dax-benchmark.sh) inside a newly created sandbox. The script prepares dependencies, clears caches, downloads and unpacks pinned Bun, clones the pinned OpenCode revision, installs dependencies, and runs typechecking.

- **Scored duration:** `totalMs` is the wall-clock duration of the build-script `runCommand` call, including preparation and downloads, but excluding sandbox creation and destruction. Individual phase timings and disk usage are also reported, but do not receive separate scoring weights.
- **Scoring scale:** `totalMs` has a **200,000 ms (200-second) ceiling**, with median/P95/P99 weights **0.60/0.25/0.15**. This is not a pass/fail deadline: a successful build at or above 200 seconds receives zero timing points, not a timeout failure.
- **Pass/fail:** creation and build execution each have a default **600,000 ms** timeout, subject to provider overrides. Phase failures, a nonzero script exit, or a missing completion marker fail the build. These execution deadlines and completion checks—not the scoring ceiling—decide success. Cleanup has a separate default 15-second timeout; cleanup errors are logged without failing an otherwise successful task.
- **Node.js:** preparation retains a working preinstalled Node only if it meets `BENCH_MIN_NODE_VERSION` (default **22.19.0**). Missing, unusable, or older Node is replaced by the pinned `BENCH_NODE_VERSION` (default **24.14.1**). The script checks the active version again after installation. Bun is pinned separately (default **1.3.14**).
- **Resources:** the target is 8 vCPU / 16 GiB where provider controls permit, with provider-specific mappings and exceptions. **Tensorlake requests 8 vCPU / 16000 MB**, not 16384 MB. See `DAX_RESOURCE_OPTIONS` for the actual requests; this is not a guarantee of identical resources across providers.
- **Network:** the Dax Cloud Run client sets **`allowEgress: true`** so the sandbox can download tools and clone the repository.

The Dax bench file defaults to 3 iterations, concurrency 1, and providers E2B, Modal, and Tensorlake for local invocation; workflow inputs and provider selection override these defaults.

## Statistical Reporting

For each provider, we report:

| Metric | Description |
|--------|-------------|
| **Median** | Middle value (typical case) |
| **P95** | 95th percentile (tail latency) |
| **P99** | 99th percentile (extreme tail) |
| **Success Rate** | Fraction of task records meeting the benchmark's success rule |

We emphasize **median** as the primary metric because it's robust to outliers and represents the typical developer experience.

### Composite Score

Benchmarks with a `scoring` block use a composite score (0–100, higher = better) that combines weighted metric scores with reliability. The implementation is in [the runner's scoring module](./packages/benchsdk-runner/src/scoring.ts).

**Formula**: `compositeScore = round(weightedMetricScore × successRate, 2)`

For lower-is-better metrics (all scored durations), each statistic is normalized against that metric's configured ceiling:

```
statScore = max(0, 100 × (1 − value / ceiling))
```

For higher-is-better metrics (throughput), the configured floor and ceiling define the scale:

```text
statScore = 100 × clamp((value − floor) / (ceiling − floor), 0, 1)
weightedMetricScore = sum(weight[metric, statistic] × statScore[metric, statistic])
```

Ceilings are **per metric, not a universal 10 seconds**. Scores are absolute within a benchmark's configured scale: adding or removing providers does not rescale them. For TTI's 10,000 ms ceiling, a 200 ms statistic scores 98, a 4,000 ms statistic scores 60, and anything at or above 10,000 ms scores zero. A zero timing score does not itself fail a task.

### Per-Benchmark Scoring Configuration

The table reflects every scored `*.bench.ts` in [benchmarks](./benchmarks). Weights are **median / P95 / P99**, and sum to 1.0 **across all metrics in a benchmark**, not separately for each row. All time values below are milliseconds; higher-is-better rows explicitly show their floor.

| Benchmark source | Metric | Direction | Scoring ceiling (floor for throughput) | Weights: median / P95 / P99 |
|------------------|--------|-----------|----------------------------------------|----------------------------|
| [Sandbox TTI](./benchmarks/sandbox/tti.bench.ts) | `ttiMs` | Lower | 10,000 ms | 0.60 / 0.25 / 0.15 |
| [Sandbox Dax](./benchmarks/sandbox/dax.bench.ts) | `totalMs` | Lower | 200,000 ms | 0.60 / 0.25 / 0.15 |
| [Browser lifecycle](./benchmarks/browser/browser.bench.ts) | `totalMs` | Lower | 10,000 ms | 0.40 / 0.20 / 0.10 |
| Browser lifecycle | `createMs` | Lower | 10,000 ms | 0.30 / 0 / 0 |
| [Browser throughput](./benchmarks/browser/browser-throughput.bench.ts) | `actionsPerSecond` | Higher | 10 actions/s (floor 0) | 0.40 / 0 / 0 |
| Browser throughput | `taskMs` | Lower | 30,000 ms | 0.25 / 0.20 / 0 |
| Browser throughput | `screenshotMs` | Lower | 30,000 ms | 0.15 / 0 / 0 |
| [Storage lifecycle](./benchmarks/storage/storage.bench.ts) | `uploadMs` | Lower | 30,000 ms | 0.25 / 0.10 / 0.05 |
| Storage lifecycle | `downloadMs` | Lower | 30,000 ms | 0.35 / 0.15 / 0.05 |
| Storage lifecycle | `throughputMbps` | Higher | 1,000 Mbps (floor 1 Mbps) | 0.05 / 0 / 0 |
| [Snapshot & fork](./benchmarks/storage/snapshot-fork.bench.ts) | `snapshotCreateMs` | Lower | 60,000 ms | 0.40 / 0 / 0 |
| Snapshot & fork | `forkFromSnapshotMs` | Lower | 60,000 ms | 0.35 / 0 / 0 |
| Snapshot & fork | `forkFromLiveMs` | Lower | 60,000 ms | 0.15 / 0 / 0 |
| Snapshot & fork | `forkFirstReadMs` | Lower | 60,000 ms | 0.10 / 0 / 0 |
| AI gateways: [Anthropic](./benchmarks/ai-gateway/ai-gateway.bench.ts), [OpenAI](./benchmarks/ai-gateway/ai-gateway-openai.bench.ts), [Gemini](./benchmarks/ai-gateway/ai-gateway-gemini.bench.ts), [Kimi](./benchmarks/ai-gateway/ai-gateway-kimi.bench.ts) | `coldE2eMs` | Lower | 20,000 ms | 0.30 / 0.15 / 0 |
| Each AI gateway workload above | `warmTtftMs` | Lower | 20,000 ms | 0.30 / 0.15 / 0 |
| Each AI gateway workload above | `outputTokensPerSec` | Higher | 200 tokens/s (floor 5 tokens/s) | 0.10 / 0 / 0 |

Storage lifecycle uses separate file-size dimensions; multi-size runs also declare `scoring.groupBy: 'file_size'`. The [AI gateway model index](./benchmarks/ai-gateway/ai-gateway-model-index.bench.ts) and [OpenCode reliability probe](./benchmarks/reliability/sandbox-opencode.bench.ts) have **no `scoring` block** and do not declare a composite score.

### Statistics and Success Rate

- Metric samples come from records with `status === 'success'`; errored records do not contribute partial measurements to declarative scoring. Finite scalar values and arrays of finite numeric samples are supported.
- By default, each metric's sorted sample set has `floor(sampleCount × 0.05)` samples trimmed from **each** end before median/P95/P99 are calculated. With fewer than 20 samples, nothing is trimmed. P95 and P99 use nearest-rank percentiles on the trimmed set. Min/max are not part of the declarative score output or scoring formula; some suite-specific result formats include additional statistics.
- A metric with no samples contributes no points; its weight is not redistributed. A participant with no records has success rate zero and is marked skipped; no passing records means a composite score of zero.
- `successRate = passing records / all records` for the participant (and file-size group, where applicable). By default a passing record has `status === 'success'`. Additional `requireData` rules also require **all** named data fields to match: browser throughput requires `actionsCompleted === ACTIONS_PER_SESSION` (currently **10**), and snapshot/fork requires `verified === true`.
- A completed record that fails an extra `requireData` check still contributes its numeric samples, but lowers success rate and therefore the composite. This differs from an errored record, which contributes no metric samples.
- TTI creation or first-command failures count against success rate. Its cleanup errors are logged, not promoted to task failures.

The success rate (0–1) is a **linear multiplier**: 50% success halves the weighted metric score. It penalizes unreliability but **does not guarantee** that every 100%-successful provider outranks every less-reliable provider. When all providers have 100% success, only the weighted metric score determines rank. Scores from different workloads or configurations are not directly comparable.

## Environment & Infrastructure

### Test Runner

The automated workflows specify their own runner environments and Node.js versions. See the [workflow definitions](./.github/workflows) for each suite; there is no single runner or schedule shared by every benchmark. Sandbox TTI and Dax currently set up Node.js 24 on the runner, independently of the Node.js version inside a sandbox.

### Network Considerations

Network latency between the runner, provider APIs, and any workload download endpoints varies and is included wherever the timed operation uses that network path. Provider configurations may specify regions, and results are not normalized to remove geographic effects.

The TTI task does not retry failed creation or first-command operations; task failures count against success rate. This is not a claim that provider SDKs or other benchmark workloads never retry internally.

## Results Storage

Published JSON results are stored in per-suite subdirectories. Current TTI and Dax writers create date-named files and copy the newest payload to a regular `latest.json` file (not a symlink):

```
results/
├── burst_tti/
│   ├── YYYY-MM-DD.json
│   └── latest.json
├── sandbox-dax/
│   ├── YYYY-MM-DD.json
│   └── latest.json
├── sequential_tti/  # historical only
└── staggered_tti/   # historical only
```

The TTI workflow generates `burst_tti.svg`; it no longer generates sequential or staggered visualizations. Other suites publish their own result files and visualizations.

### TTI JSON Format

An illustrative one-iteration TTI result follows. Burst results use the legacy mode label **`concurrent`**, not `burst`. The common schema is [results/schema.json](./results/schema.json); suite-specific formats are not interchangeable with this TTI example.

```json
{
  "version": "1.1",
  "timestamp": "ISO 8601 timestamp",
  "environment": {
    "node": "v24.x.x",
    "platform": "linux",
    "arch": "x64"
  },
  "config": {
    "iterations": 1,
    "timeoutMs": 120000
  },
  "results": [
    {
      "provider": "provider-name",
      "mode": "concurrent",
      "concurrency": 1,
      "wallClockMs": 123.45,
      "timeToFirstReadyMs": 123.45,
      "iterations": [
        { "ttiMs": 123.45 }
      ],
      "summary": {
        "ttiMs": {
          "median": 123.45,
          "p95": 123.45,
          "p99": 123.45
        }
      },
      "compositeScore": 98.77,
      "successRate": 1.0
    }
  ]
}
```

Failed TTI iterations contain an `error` field rather than a synthetic zero-duration success. Historic staggered results additionally include `staggerDelayMs` and `rampProfile`. The TTI JSON writer retains `config.timeoutMs: 120000` as the default creation timeout; consult the source for provider overrides and the separate command deadline.

### Running Locally

Reproduce our results:

```bash
git clone https://github.com/computesdk/benchmarks.git
cd benchmarks
pnpm install
pnpm -r --filter './packages/**' build
cp benchmarks/.env.example benchmarks/.env  # Configure providers locally

# TTI smoke run (3 iterations, concurrency 3)
pnpm run bench

# Match the scheduled TTI workload size for one provider
pnpm run bench:burst -- --provider e2b --iterations 100 --concurrency 100

# Dax (bench-file defaults: 3 iterations, concurrency 1)
pnpm run bench:sandbox:dax -- --provider tensorlake
```

**Note**: Configure provider access and runner authentication as described in the [runner guide](./packages/benchsdk-runner/README.md). Local results will differ based on configuration, network location, and conditions.

## Fairness & Limitations

### What This Benchmark Shows

- Relative performance between providers under consistent conditions
- Time to first successful command for on-demand sandbox creation
- Dax build completion time and phase diagnostics
- Provider reliability (success rate over time)
- Performance under the configured burst load (plus historical sequential/staggered data)

### Limits of These Measurements

- A newly requested sandbox does not imply cold physical infrastructure: providers may use pre-warmed pools, cached images, or snapshot-backed templates.
- A single run does not establish geographic variation or performance at every possible concurrency level.
- TTI and Dax scores do not measure cost efficiency or provider feature completeness.
- Other suites, such as storage snapshot/fork, measure different operations and should be interpreted using their own workloads and scoring scales.

## Changelog

| Date | Change |
|------|--------|
| 2026-11-06 | Aligned scoring ceilings/weights, success rules, TTI status and defaults, Dax setup/resources, and result format with source |
| 2026-03-04 | Added staggered TTI and burst TTI test modes; separated results into per-test subdirectories |
| 2026-03-01 | Added composite scoring methodology |
| 2026-02-19 | Initial methodology documentation |
| 2026-02-01 | Increased default iterations from 3 to 10 |
| 2026-01-15 | Added Direct Mode benchmarks |

## Questions & Disputes

Providers or users who have questions about methodology or wish to dispute results should open a GitHub issue.

## Private daily runs

Daily sandbox and DAX legs use Archil persistent execution and map the vault's `ARCHIL_DISK_ID_SANDBOX` to `ARCHIL_DISK_ID`, matching the weekly workflows.

An AI gateway provider dispatch selects only that provider in each matching family and loads that provider's vault keys; an empty provider input runs the full family roster.

`.github/workflows/daily-benchmarks.yml` runs at 09:00 UTC and supports category, family, provider and iteration overrides through workflow dispatch. It uses this repository's providers and weekly workflow defaults via `benchmarks/scripts/daily/`. Runs publish only to the platform under the `-daily` slugs; there is no daily result artifact, chart, result commit or public snapshot. This replaces the internal daily pipeline.

Provider configs may declare `dailyOnly: true`. Daily discovery includes these providers, while benchmark participant selection excludes them unless `DAILY_BENCH_SLUG=daily`. This also applies to explicit public provider selections. GitHub Copilot's model index is daily-only. Vault manifests retain all providers regardless of this flag. Sandbox `manualOnly` providers remain excluded from daily discovery.

Weekly/public sandbox, DAX, storage, snapshot/fork, browser, throughput, concurrent-browser and capabilities matrices use hand-curated provider lists; daily-only providers must not be added to those lists. Bench-level `selectProviders` filtering is the backstop. AI gateway workflows use family matrices; each bench filters its participant roster, including `--provider all`. Throughput collection excludes daily-only providers from its missing-result roster as well.

Run the defaults checks with `node --test benchmarks/scripts/daily/oss-workflow-defaults.test.mjs`; CI runs them too. The daily workflow uses the existing vault loader's regex mode, generated from an exact-name key list. This retains the public loader's deleted-entry filtering and deduplication without changing weekly secret loading.
