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

## Test Configuration

### Daily Automated Runs

| Parameter | Value |
|-----------|-------|
| Iterations per provider | 100 |
| Timeout per iteration | 120 seconds |
| Run frequency | Daily at 00:00 UTC |
| Runner environment | GitHub Actions (namespace-profile-default) |
| Node.js version | 20.x |

### Provider Integration

**Native SDK**: Uses provider's native SDK package (daytona, blaxel, modal, vercel)

**Via ComputeSDK orchestrator**: Routes through ComputeSDK's orchestrator for platforms without native sandbox APIs (namespace, railway, render)

### Provider Execution Order

Providers are tested **sequentially** to:
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
| **Average** | Arithmetic mean |
| **Success Rate** | Iterations completed without error |

We emphasize **median** as the primary metric because it's robust to outliers and represents the typical developer experience.

### Composite Score

Providers are ranked by a composite score (0–100, higher = better) that combines timing metrics with reliability.

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

## Quarterly Stress Tests

Starting Q2 2026, we're introducing large-scale stress tests that go beyond daily TTI measurements.

### What We're Exploring

**Concurrency at scale** — How do providers perform when spinning up thousands of sandboxes simultaneously? Daily tests measure one-at-a-time performance. Real workloads often burst.

Example test: *Spin up 10,000 sandboxes concurrently, measure time until all are interactive, track failure rates.*

**Sustained load** — Can providers maintain performance over extended periods under continuous demand?

**Recovery behavior** — How quickly do providers recover from partial failures or rate limiting?

### Why This Matters

Daily TTI benchmarks show best-case, low-contention performance. Stress tests reveal how providers behave when infrastructure is under pressure—which is when reliability matters most.

Methodology details will be published before the first quarterly test runs.

---

## Fairness & Limitations

### What This Benchmark Shows

- Relative performance between providers under consistent conditions
- Typical cold-start times for on-demand sandbox creation
- Provider reliability (success rate over time)

### What This Benchmark Does NOT Show (Yet)

- Performance with pre-warmed pools or snapshots
- Performance under high concurrency
- Geographic variation
- Cost efficiency
- Feature differences between providers

## Data & Reproducibility

### Raw Data

All benchmark results are committed to this repository:

```
results/
├── 2026-02-19T00-30-31-832Z.json      # Magic mode results
├── direct-2026-02-19T00-30-31-832Z.json # Direct mode results
└── ...
```

### JSON Schema

```json
{
  "timestamp": "ISO 8601 timestamp",
  "results": [
    {
      "provider": "provider-name",
      "iterations": [
        { "ttiMs": 123.45 },
        { "ttiMs": 0, "error": "error message" }
      ],
      "summary": {
        "ttiMs": {
          "min": 100.0,
          "max": 150.0,
          "median": 125.0,
          "avg": 124.5
        }
      },
      "skipped": false,
      "skipReason": null
    }
  ]
}
```

### Running Locally

Reproduce our results:

```bash
git clone https://github.com/computesdk/benchmarks.git
cd benchmarks
npm install
cp env.example .env  # Add your API keys

# Run with same settings as CI
npm run bench:direct -- --iterations 10
```

**Note**: Your results will differ based on your network location and conditions.

## Changelog

| Date | Change |
|------|--------|
| 2026-03-01 | Added composite scoring methodology |
| 2026-02-19 | Initial methodology documentation |
| 2026-02-01 | Increased default iterations from 3 to 10 |
| 2026-01-15 | Added Direct Mode benchmarks |

## Questions & Disputes

Providers or users who have questions about methodology or wish to dispute results should open a GitHub issue.
