# ComputeSDK Benchmarks

[![Benchmarks](https://github.com/computesdk/benchmarks/actions/workflows/benchmarks.yml/badge.svg)](https://github.com/computesdk/benchmarks/actions/workflows/benchmarks.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

**Independent performance benchmarks for cloud sandbox providers.**

How fast can you go from API call to running code? We measure it daily, publish everything, and let the numbers speak.

<br>

## Latest Results

<!-- BENCHMARK-RESULTS-START -->
> Last run: 2026-02-19T00:30:31.834Z

| Provider | Median TTI | Min | Max | Status |
|----------|-----------|-----|-----|--------|
| daytona | 0.29s | 0.18s | 0.87s | 10/10 OK |
| e2b | 0.41s | 0.36s | 0.69s | 10/10 OK |
| modal | 1.57s | 1.21s | 2.14s | 10/10 OK |
| blaxel | 2.70s | 2.66s | 2.79s | 10/10 OK |
| vercel | 2.80s | 2.51s | 3.18s | 10/10 OK |
<!-- BENCHMARK-RESULTS-END -->

**TTI (Time to Interactive)** = API call to first command execution. Lower is better.

**Want your provider here?** [Become a sponsor →](./SPONSORSHIP.md)

<br>

## What We Measure

```
API Request → Provisioning → Boot → Ready → First Command
└───────────────────── TTI ─────────────────────┘
```

Each benchmark:
1. Creates a fresh sandbox
2. Runs `echo "benchmark"`
3. Records wall-clock time

**10 iterations per provider. Every day. Fully automated.**

[Full methodology →](./METHODOLOGY.md)

<br>

## Providers

| Provider | Status |
|:---------|:------:|
| [Daytona](https://daytona.io) | ✓ |
| [E2B](https://e2b.dev) | ✓ |
| [Modal](https://modal.com) | ✓ |
| [Blaxel](https://blaxel.ai) | ✓ |
| [Vercel](https://vercel.com) | ✓ |

Want in? [See sponsorship →](./SPONSORSHIP.md)

<br>

## Run It Yourself

```bash
git clone https://github.com/computesdk/benchmarks.git
cd benchmarks && npm install
cp env.example .env  # Add your API keys
npm run bench
```

<br>

## Transparency

| | |
|:--|:--|
| Open source | All benchmark code is public |
| Raw data | Every result committed to repo |
| Reproducible | Anyone can run the same tests |
| Automated | Daily runs via GitHub Actions |
| Independent | Sponsors cannot influence results |

<br>

## Roadmap

| When | What |
|:-----|:-----|
| Q2 2026 | benchmarks.computesdk.com |
| Q2 2026 | 10,000 concurrent sandbox stress test |
| Q3 2026 | Cold start vs warm start metrics |
| Q3 2026 | Multi-region testing |
| Q4 2026 | Cost-per-sandbox-minute |

<br>

## Sponsors

Sponsorship funds infrastructure for large-scale tests. Sponsors get included in quarterly stress tests and future benchmark categories.

**Sponsors cannot influence methodology or results.**

[Become a sponsor →](./SPONSORSHIP.md)

<br>

---

MIT License
