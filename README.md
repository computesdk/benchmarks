# ComputeSDK Benchmarks

**Independent performance benchmarks for cloud sandbox providers.**

We measure what matters: how fast can developers go from API call to running code? Our benchmarks run daily, results are public, and methodology is open source.

[View Full Methodology](./METHODOLOGY.md) | [Become a Sponsor](./SPONSORSHIP.md)

---

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

> **TTI (Time to Interactive)** = Total time from API call to first command execution. Lower is better.

---

## What We Measure

**Time to Interactive (TTI)** captures the full developer experience:

```
API Request → Infrastructure Provisioning → Environment Ready → First Command Executes
└──────────────────────────── TTI ────────────────────────────────┘
```

Each benchmark iteration:
1. Creates a fresh sandbox via the provider's API
2. Executes a simple command (`echo "benchmark"`)
3. Records the total wall-clock time

We run **10 iterations per provider, daily**, from a consistent environment. Results include min, max, median, and average times.

See [METHODOLOGY.md](./METHODOLOGY.md) for complete technical details.

---

## Providers Tested

| Provider | Status |
|----------|--------|
| [Daytona](https://daytona.io) | Active |
| [E2B](https://e2b.dev) | Active |
| [Modal](https://modal.com) | Active |
| [Blaxel](https://blaxel.ai) | Active |
| [Vercel](https://vercel.com) | Active |

Want your provider included? See [SPONSORSHIP.md](./SPONSORSHIP.md).

---

## Run It Yourself

Everything is open source. Reproduce our results locally:

```bash
git clone https://github.com/computesdk/benchmarks.git
cd benchmarks
npm install
cp env.example .env  # Add your API keys
```

```bash
npm run bench                    # All providers
npm run bench -- --provider e2b  # Single provider
npm run bench -- --iterations 20 # Custom iterations
```

Results are saved to `results/` as JSON.

---

## Transparency

- **Open source**: All benchmark code is public
- **Raw data**: Every result is committed to this repo
- **Reproducible**: Anyone can run the same tests
- **Daily runs**: Automated via GitHub Actions
- **No editorial control**: Sponsors cannot influence results

---

## Sponsors

This benchmark is supported by sandbox providers who believe in transparent performance measurement.

Sponsorship includes benchmark participation and helps fund infrastructure for large-scale quarterly tests. **Sponsors have no influence over methodology or results.**

[View sponsorship details →](./SPONSORSHIP.md)

---

## Roadmap

- [ ] **Q2 2026**: Launch benchmarks.computesdk.com with historical charts
- [ ] **Q2 2026**: First 10,000 concurrent sandbox stress test
- [ ] **Q3 2026**: Add cold start vs warm start metrics
- [ ] **Q3 2026**: Multi-region testing (US, EU, Asia)
- [ ] **Q4 2026**: Cost-per-sandbox-minute tracking

---

## License

MIT. See [LICENSE](./LICENSE).
