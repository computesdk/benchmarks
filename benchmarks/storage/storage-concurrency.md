# Storage Concurrency Benchmark

This benchmark creates one platform run containing every environment-available
storage provider and eight cells per provider:

- concurrency: `1`, `8`, `32`, `128`
- key distributions: `SINGLE_PREFIX`, `SPREAD_64`

Each cell is one runner task. The task owns an internal closed-loop pool with
the requested number of workers. A worker issues one GET, waits for it to
finish, and immediately issues the next GET until the cell operation budget is
complete.

The runner's concurrency is fixed at `1` deliberately. This prevents cells
from overlapping; the internal pool is the source of truth for storage request
concurrency.

## Run

```bash
pnpm bench:storage-concurrency
```

Run selected providers:

```bash
pnpm bench:storage-concurrency -- --provider aws-s3,cloudflare-r2
```

Override the per-cell operation budget:

```bash
pnpm bench:storage-concurrency -- --storage-operations 2000
```

Seed the corpus for one provider:

```bash
pnpm bench:storage-concurrency:seed -- --provider aws-s3
```

Verify a 100-object sample:

```bash
pnpm bench:storage-concurrency:seed -- --verify --provider aws-s3
```

The corpus must be seeded at:

```text
bench/v1/p00/obj000000
...
bench/v1/p63/obj009999
```

Each task reports throughput, latency percentiles, success/error rates by
class, a `valid` flag, and the observed maximum active request count. The first
5% of operations are warmup and excluded from the reported metrics.

The workflow collects all provider cells into one `latest.json` artifact and
generates `storage-concurrency.md` plus `storage-concurrency.svg` for the
comparison.

The composite score is 0–100 and is computed from each provider's cells:
throughput (45%), p50 latency (20%), p95 latency (20%), and p99 latency (15%).
Scores use fixed absolute ceilings and are multiplied by success rate, so
invalid or failing cells reduce the provider score.
