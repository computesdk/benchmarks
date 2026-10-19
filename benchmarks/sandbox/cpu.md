# Sandbox CPU benchmark

Measures the CPU a sandbox provider actually delivers: SHA-256 hashing
throughput on one core and on every logical CPU, run once per market size
tier (small / medium / large / xlarge). Each provider gets one composite
score per size, so buyers can compare CPU across providers at exactly the
tier they'd pick in the ComputeSDK market.

## How it works

The benchmark declares one `phases` arm per market size — `small`, `medium`,
`large`, `xlarge` (the same names/resources as `PLATFORM_SIZES` in
benchmarks-platform), 3 iterations each. Each iteration is create →
benchmark → destroy, same skeleton as the TTI and dax benchmarks:

- `create` — `compute.sandbox.create()` with the provider's options for that
  size tier from `PROVIDER_SIZE_OPTIONS` in `sizes.ts` (the xlarge layer is
  the same map dax uses). Timed but unscored: TTI is a different benchmark.
- `cpu` — uploads `benchmarks/scripts/cpu-benchmark.sh` into the sandbox via
  heredoc and runs it with bash. The script emits `BENCH_*` protocol lines;
  the task parses them into `record.data` and pre-measured steps.
- `cpu_single` / `cpu_multi` — pre-measured platform steps carrying the two
  phase timings and throughputs (`groupBy: 'round'` so the runner honors them).
- `destroy` — `sandbox.destroy()` in `finally`, `reportConcurrency: false`.

Inside the script:

1. Emit `BENCH_META` lines: cpu model (cpuinfo, `uname -m` fallback), arch,
   kernel, logical CPU count, MemTotal.
2. `cpu_single`: time `dd if=/dev/zero bs=1M count=4096 | sha256sum` — one
   pipe, one core.
3. `cpu_multi`: run `nproc` copies of the same pipe in parallel and time the
   slowest via `wait` — aggregate throughput over wall time.
4. `BENCH_DONE` marks a complete run; `BENCH_ERROR` + non-zero exit marks a
   failure (e.g. no `sha256sum`/`dd` in the image).

Throughput in MB/s is derived in `cpu.bench.ts` from the reported bytes and
wall ms, not measured by the script.

## Metrics and scoring

`record.data` carries: `singleCoreMBps`, `multiCoreMBps`, `scalingFactor`
(multi ÷ single), `vcpus`, `cpuModel`, `architecture`, `kernel`, `memoryKiB`,
phase wall times, and `done`. `success.requireData` gates on `done: true`.

Scored metrics (weights across metrics sum to 1.0):

| Metric | Unit | Direction | Floor | Ceiling | Weights (median/p95/p99) |
|---|---|---|---|---|---|
| `multiCoreMBps` | MB/s | higher | 500 | 20000 | 0.45 / 0.10 / 0.05 |
| `singleCoreMBps` | MB/s | higher | 50 | 3000 | 0.30 / 0.07 / 0.03 |

Composite = weighted scores × success rate, same formula as every sandbox
benchmark — computed once per size tier via `scoring.groupBy: 'phase'`
(every record is auto-tagged `data.phase` with its size), plus an overall
row. `multiCoreMBps` is the headline (60%): it's what a real
CPU-saturated workload gets. `singleCoreMBps` (40%) keeps a provider from
hiding weak cores behind a higher core count.

## Why it's built this way

- **SHA-256 through a pipe** is CPU-bound (the kernel serves `/dev/zero`
  faster than any hasher consumes it), needs only `dd` + `sha256sum` — both
  in coreutils/busybox on every image we run — and engages SHA-NI / ARMv8
  SHA extensions where present. Hardware crypto acceleration is a real CPU
  feature and belongs in the grade.
- **Fixed work, not fixed time**: 4 GiB single-core, 2 GiB per worker
  all-core. A fast core finishes in ~2 s, a weak one in ~20 s; wall time is
  what we measure, so both are equally valid.
- **Market sizes, reported reality**: each tier requests the market's
  cpus/memory for that size, but the script reports the `logical_cpus` and
  CPU model it actually observed. A provider that under-delivers shows up in
  `vcpus`, not silently in the throughput number.
- **No substitutions**: if the image lacks `sha256sum`/`dd` the run fails as
  `cpu_failed` instead of quietly benchmarking a different tool — comparing
  openssl on one provider to coreutils on another would grade the tools, not
  the CPUs.
- **`latencyMs` = hashing phases only** (single + multi), excluding sandbox
  create and the `runCommand` round trip — the grade is CPU, not API latency.

## Provider notes

- Sizing comes from `PROVIDER_SIZE_OPTIONS` in `sizes.ts`. Providers that
  take raw cpu/memory parameters get all four tiers; template- or
  preset-sized providers only get the tiers they can actually provision —
  a missing tier fails as `size_not_supported`, so a provider that can't
  offer `medium` grades 0 there rather than substituting a different size.
  Providers with no entry at all run their default size at `xlarge`
  (e.g. `nproc` may not be 8 there; the recorded `vcpus` shows it).
- cgroup-limited sandboxes score lower — intended: a capped vCPU is a slower
  CPU to the workload running on it.
- Vercel carries `persistent: false` (in `providers.ts`) so `stop()` doesn't
  auto-snapshot.

## Running it

```bash
# packages/*/dist is not committed — build once first
pnpm -r --filter "./packages/**" build

BENCHMARKS_PLATFORM_API_KEY=bp-... pnpm bench:sandbox:cpu -- --provider e2b --iterations 1 --dry-run
```

CI: `.github/workflows/sandbox-cpu-benchmarks.yml` — weekly Friday cron plus
`workflow_dispatch` (`provider`, `iterations`, `dry_run`). Provider creds load
from the Namespace vault, same as dax. Results land on
`platform.computesdk.com` under the `sandbox-cpu` slug.
