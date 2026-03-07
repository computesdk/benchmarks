# Benchmark Methodology

This document describes how ComputeSDK Benchmarks measures sandbox provider performance. Our goal is transparent, reproducible, and fair measurement.

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

Each benchmark iteration executes the following steps:

```typescript
// 1. Start timer
const start = performance.now();

// 2. Create sandbox and wait until ready
const sandbox = await compute.sandbox.create();

// 3. Execute a trivial command to confirm interactivity
await sandbox.runCommand('echo "benchmark"');

// 4. Stop timer
const ttiMs = performance.now() - start;

// 5. Cleanup (not timed)
await sandbox.destroy();
```

### Why `echo "benchmark"`?

We use a minimal command to isolate sandbox startup time from command complexity. The command:
- Has negligible execution time
- Requires no file system access
- Produces deterministic output
- Validates the full request/response cycle

## Test Modes

We run three independent TTI tests daily, each measuring a different aspect of provider performance.

### Sequential TTI

Sandboxes are created one at a time. Each sandbox is created, tested, and destroyed before the next begins.

```bash
npm run bench:sequential -- --iterations 100
```

| Parameter | Value |
|-----------|-------|
| Iterations per provider | 100 |
| Timeout per iteration | 120 seconds |

This is the baseline measurement — isolated cold-start performance with no contention.

### Staggered TTI

Sandboxes are launched with a fixed delay between each, ramping up concurrent load gradually.

```bash
npm run bench:staggered -- --concurrency 100 --stagger-delay 200
```

| Parameter | Default |
|-----------|---------|
| Concurrency | 100 sandboxes |
| Stagger delay | 200ms between launches |
| Timeout per sandbox | 120 seconds |

Each sandbox still measures its own individual TTI. Additionally, we capture a **ramp profile** — the TTI of each sandbox plotted against its launch offset — which reveals how TTI degrades as concurrent load increases.

**What staggered reveals that burst doesn't:**
- How TTI degrades as concurrent load gradually increases
- Queue depth impact — providers with pre-warmed pools may handle early requests fast but slow down as the pool drains
- Rate limiting behavior — some providers throttle after N requests/second
- Sustainable throughput under steady load

### Burst TTI

All sandboxes are created simultaneously — no waiting between launches.

```bash
npm run bench:burst -- --concurrency 100
```

| Parameter | Default |
|-----------|---------|
| Concurrency | 100 sandboxes |
| Timeout per sandbox | 120 seconds |

Each sandbox still measures its own individual TTI. We also capture:

| Metric | Description |
|--------|-------------|
| **Wall Clock** | Total time from first request to last sandbox ready |
| **Time to First Ready** | How quickly the fastest sandbox responded under load |
| **Individual TTI** | Per-sandbox startup time (same stats: median, p95, p99, etc.) |
| **Success Rate** | Fraction of sandboxes that came up successfully |

**Why burst matters:** AI agents and orchestration tools often spin up many sandboxes at once. Burst testing reveals how providers handle sudden spikes — provisioning queue depth, rate limiting, and failure rates under peak demand.

### Running All Tests

By default, `npm run bench` runs all three tests in sequence:

```bash
npm run bench                          # Runs sequential → staggered → burst
npm run bench -- --provider e2b        # All 3 tests, single provider
npm run bench:sequential               # Sequential only
npm run bench:staggered                # Staggered only
npm run bench:burst                    # Burst only
```

## Test Configuration

### Daily Automated Runs

| Parameter | Value |
|-----------|-------|
| Sequential iterations | 100 |
| Staggered/Burst concurrency | 100 sandboxes |
| Stagger delay | 200ms |
| Timeout per sandbox | 120 seconds |
| Run frequency | Daily at 00:00 UTC |
| Runner environment | GitHub Actions (namespace-profile-default) |
| Node.js version | 24.x |

### Provider Integration

**ComputeSDK**: Uses ComputeSDK for consistency and ease-of-use (e2b, daytona, blaxel, modal, vercel, hopx, codesandbox, runloop, namespace)

### Provider Execution Order

Within each test mode, providers are tested **sequentially** to:
- Avoid resource contention on the test runner
- Prevent rate limiting issues
- Ensure consistent network conditions per provider

The order is randomized each run to prevent systematic bias from time-of-day effects.

## Statistical Reporting

For each provider, we report:

| Metric | Description |
|--------|-------------|
| **Min** | Fastest iteration (best case) |
| **Max** | Slowest iteration (worst case) |
| **Median** | Middle value (typical case) |
| **P95** | 95th percentile (tail latency) |
| **P99** | 99th percentile (extreme tail) |
| **Average** | Arithmetic mean |
| **Success Rate** | Iterations completed without error |

We emphasize **median** as the primary metric because it's robust to outliers and represents the typical developer experience.

### Composite Score

Providers are ranked by a composite score (0–100, higher = better) that combines timing metrics with reliability. The same scoring formula is used across all three test modes.

**Formula**: `compositeScore = timingScore × successRate`

Each timing metric is scored against a **fixed 10-second ceiling**:

```
metricScore = 100 × (1 − value / 10,000ms)
```

A 200ms median scores 98. A 4,000ms median scores 60. Anything at or above 10s scores 0. These scores are **absolute** — they don't shift when providers are added or removed.

The **timingScore** is a weighted sum of individual metric scores. The **successRate** (0–1) acts as a linear multiplier — a provider with 50% success has its score halved.

**Timing weights** (sum to 1.0):

| Metric | Weight | Rationale |
|--------|--------|-----------|
| Median | 0.50 | Primary signal — typical developer experience |
| P95 | 0.20 | Tail latency — consistency matters |
| Max | 0.15 | Worst-case exposure |
| P99 | 0.10 | Extreme tail |
| Min | 0.05 | Best-case capability |

**Why multiplicative?** A provider with lower than 100% success rate shouldn't rank above a provider with 100% success and a slightly slower median. The multiplicative penalty ensures reliability is non-negotiable — a provider must be both fast *and* reliable to score well.

When all providers have 100% success, ranking is determined purely by weighted timing.

## Environment & Infrastructure

### Test Runner

All benchmarks run on GitHub Actions using Namespace runners:

- **OS**: Ubuntu (latest LTS)
- **Profile**: namespace-profile-default
- **Network**: Namespace's infrastructure
- **Location**: Namespace-managed infrastructure

### Network Considerations

Network latency between the GitHub runner and each provider's API endpoints varies. This is **intentional**—it reflects real-world conditions where developers call these APIs from various locations.

We do not:
- Run from provider-specific regions to artificially reduce latency
- Use dedicated/reserved network capacity
- Retry failed requests (failures count against success rate)

## Results Storage

Results are stored in per-test subdirectories with a `latest.json` symlink in each:

```
results/
├── sequential_tti/
│   ├── 2026-03-02T00-43-35-416Z.json
│   ├── ...
│   └── latest.json → most recent
├── staggered_tti/
│   ├── ...
│   └── latest.json → most recent
└── burst_tti/
    ├── ...
    └── latest.json → most recent
```

Each test mode generates its own SVG visualization: `sequential_tti.svg`, `staggered_tti.svg`, `burst_tti.svg`.

### JSON Schema

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
    "iterations": 100,
    "timeoutMs": 120000
  },
  "results": [
    {
      "provider": "provider-name",
      "mode": "sequential | staggered | burst",
      "iterations": [
        { "ttiMs": 123.45 },
        { "ttiMs": 0, "error": "error message" }
      ],
      "summary": {
        "ttiMs": {
          "min": 100.0,
          "max": 150.0,
          "median": 125.0,
          "p95": 140.0,
          "p99": 148.0,
          "avg": 124.5
        }
      },
      "compositeScore": 96.85,
      "successRate": 1.0
    }
  ]
}
```

Staggered results additionally include `concurrency`, `staggerDelayMs`, `wallClockMs`, `timeToFirstReadyMs`, and `rampProfile`. Burst results include `concurrency`, `wallClockMs`, and `timeToFirstReadyMs`.

### Running Locally

Reproduce our results:

```bash
git clone https://github.com/computesdk/benchmarks.git
cd benchmarks
npm install
cp env.example .env  # Add your API keys

# Run all 3 tests
npm run bench

# Run individual tests
npm run bench:sequential -- --iterations 10
npm run bench:staggered -- --concurrency 10 --stagger-delay 200
npm run bench:burst -- --concurrency 10

# Single provider
npm run bench -- --provider e2b
```

**Note**: Your results will differ based on your network location and conditions.

## Quarterly Stress Tests

Starting Q2 2026, we're introducing large-scale stress tests that go beyond daily measurements.

### What We're Exploring

**Concurrency at scale** — How do providers perform when spinning up thousands of sandboxes simultaneously?

Example test: *Spin up 10,000 sandboxes concurrently, measure time until all are interactive, track failure rates.*

**Sustained load** — Can providers maintain performance over extended periods under continuous demand?

**Recovery behavior** — How quickly do providers recover from partial failures or rate limiting?

### Why This Matters

Daily benchmarks show performance at moderate scale. Stress tests reveal how providers behave when infrastructure is under pressure—which is when reliability matters most.

Methodology details will be published before the first quarterly test runs.

---

## Fairness & Limitations

### What This Benchmark Shows

- Relative performance between providers under consistent conditions
- Cold-start times for on-demand sandbox creation
- Provider reliability (success rate over time)
- Performance under concurrent load (staggered and burst)

### What This Benchmark Does NOT Show (Yet)

- Performance with pre-warmed pools or snapshots
- Geographic variation
- Cost efficiency
- Feature differences between providers

## Changelog

| Date | Change |
|------|--------|
| 2026-03-04 | Added staggered TTI and burst TTI test modes; separated results into per-test subdirectories |
| 2026-03-01 | Added composite scoring methodology |
| 2026-02-19 | Initial methodology documentation |
| 2026-02-01 | Increased default iterations from 3 to 10 |
| 2026-01-15 | Added Direct Mode benchmarks |

## Questions & Disputes

Providers or users who have questions about methodology or wish to dispute results should open a GitHub issue.
