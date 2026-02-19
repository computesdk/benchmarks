# ComputeSDK Sandbox Provider Benchmarks

## Latest Results

<!-- BENCHMARK-RESULTS-START -->

### Magic Mode (via ComputeSDK Gateway)
> Last run: 2026-02-19T01:11:54.276Z

| Provider | Median TTI | Min | Max | Status |
|----------|-----------|-----|-----|--------|
| daytona | 0.00s | 0.00s | 0.00s | 0/10 OK |
| e2b | 3.74s | 2.78s | 5.65s | 10/10 OK |
| namespace | 6.91s | 4.07s | 10.29s | 10/10 OK |
| modal | 7.56s | 4.76s | 13.47s | 10/10 OK |
| vercel | 7.82s | 7.16s | 8.79s | 10/10 OK |
| render | 10.79s | 8.32s | 19.22s | 9/10 OK |
| blaxel | 12.04s | 11.85s | 13.14s | 10/10 OK |
| railway | 15.09s | 11.34s | 21.09s | 9/10 OK |

### Direct Mode (provider SDKs only)
> Last run: 2026-02-19T00:30:31.834Z

| Provider | Median TTI | Min | Max | Status |
|----------|-----------|-----|-----|--------|
| daytona | 0.29s | 0.18s | 0.87s | 10/10 OK |
| e2b | 0.41s | 0.36s | 0.69s | 10/10 OK |
| modal | 1.57s | 1.21s | 2.14s | 10/10 OK |
| blaxel | 2.70s | 2.66s | 2.79s | 10/10 OK |
| vercel | 2.80s | 2.51s | 3.18s | 10/10 OK |
<!-- BENCHMARK-RESULTS-END -->



## Methodology

We measure **Time to Interactive (TTI)** — the total wall-clock time from initiating sandbox creation to completing the first command execution.

Each benchmark iteration does the following:

1. `sandbox = await compute.sandbox.create()` — provisions infrastructure, installs the daemon, and waits until the sandbox is ready
2. `sandbox.runCommand('echo "benchmark"')` — executes a trivial command to confirm the sandbox is fully interactive
3. `sandbox.destroy()` — tears down the sandbox (not included in TTI measurement)

A single `performance.now()` timer wraps steps 1 and 2. This captures the full end-user experience: API call latency, infrastructure provisioning, daemon boot, health check polling, and first command round-trip.

Each provider is run for 3 iterations by default (configurable via `--iterations`). Results report min, max, median, and average TTI. Providers are run sequentially to avoid resource contention.

### Two Benchmark Modes

**Magic Mode** — Routes through the ComputeSDK gateway (Tributary + Daemon). Requires `COMPUTESDK_API_KEY`. Tests all 8 providers: e2b, vercel, blaxel, modal, daytona, railway, namespace, render.

**Direct Mode** — Uses the individual provider SDK packages (`@computesdk/e2b`, `@computesdk/daytona`, etc.) directly, bypassing the ComputeSDK gateway. No `COMPUTESDK_API_KEY` needed. Tests 5 providers: e2b, daytona, blaxel, modal, vercel.

## Run Locally

```bash
# Install dependencies
npm install

# Copy .env.example and fill in your API keys
cp .env.example .env
```

### Magic Mode

```bash
npm run bench                    # All providers
npm run bench:e2b                # Single provider
npm run bench -- --iterations 5  # Custom iterations
```

### Direct Mode

```bash
npm run bench:direct                    # All providers
npm run bench:direct:e2b                # Single provider
npm run bench:direct -- --iterations 5  # Custom iterations
```

Results are saved to `results/` as JSON files.
