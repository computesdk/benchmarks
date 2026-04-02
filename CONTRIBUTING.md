# Contributing

ComputeSDK Benchmarks is open source. We welcome contributions that improve measurement accuracy, add providers, or enhance the project.

## For Sandbox Providers

Want your provider included in our benchmarks? **Providers and sponsors are separate.** You don't need to sponsor to be benchmarked.

### How to Add Your Provider

Submit a PR to [`computesdk/computesdk`](https://github.com/computesdk/computesdk) adding your provider to the `packages/` directory. 

See [`packages/e2b`](https://github.com/computesdk/computesdk/tree/main/packages/e2b) for a reference implementation.

**What happens next:**
1. We review and merge your PR
2. We publish your package as `@computesdk/<provider>` on npm
3. We add your provider to the benchmarks
4. You provide API credentials for ongoing daily tests

That's it. We handle the rest.

### Requirements

- **Package Code:** Working integration in `packages/<provider>/`
- **Standard Interface:** Support `create`, `run`, `destroy` operations
- **API Access:** Provide credentials for ongoing daily benchmarks
- **Stability:** Production-ready service

---

## For Sponsors

**Sponsorship is completely separate from being a provider.**

Sponsors are companies (AI studios, dev tools, platforms) that want visibility in front of developers making infrastructure decisions. See [SPONSORSHIP.md](./SPONSORSHIP.md) for details.

- Sponsors don't need to be providers
- Providers don't need to sponsor
- Results are independent of sponsorship status

## For General Contributors

### Bug Fixes

Found a bug? Please:

1. Check existing issues first
2. Open an issue describing the bug
3. Submit a PR with the fix (reference the issue)

### Methodology Improvements

We're open to improving how we measure performance. Before making changes:

1. Open an issue describing the proposed change
2. Explain why it improves accuracy or fairness
3. Wait for maintainer feedback before implementing

Methodology changes require careful consideration since they affect historical comparability.

### Documentation

Documentation improvements are always welcome. No issue required for typos, clarifications, or formatting fixes.

## Development Setup

```bash
git clone https://github.com/computesdk/benchmarks.git
cd benchmarks
npm install
cp env.example .env
```

### Running Tests Locally

```bash
# Run all three sandbox test modes (sequential → staggered → burst)
npm run bench

# Run individual sandbox test modes
npm run bench -- --mode sequential --iterations 10
npm run bench -- --mode staggered --concurrency 10 --stagger-delay 200
npm run bench -- --mode burst --concurrency 10

# Run a single provider
npm run bench -- --provider e2b

# Combine flags
npm run bench -- --provider e2b --mode sequential --iterations 5

# Run browser benchmarks
npm run bench -- --mode browser
npm run bench -- --mode browser --provider browserbase

# Run storage benchmarks
npm run bench -- --mode storage
npm run bench -- --mode storage --provider aws-s3
npm run bench -- --mode storage --file-size 100MB
```

### Code Style

- TypeScript with strict mode
- ES modules (`import`/`export`)
- Prettier for formatting (run `npm run format` if available)

## Code of Conduct

- Be respectful and constructive
- Focus on technical merit
- No promotional content in issues/PRs
- Disclose any conflicts of interest (e.g., if you work for a benchmarked provider)

## Questions

- **General questions**: Open a GitHub issue
- **Sponsorship inquiries**: See [SPONSORSHIP.md](./SPONSORSHIP.md) or email garrison@computesdk.com
