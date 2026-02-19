# Contributing

ComputeSDK Benchmarks is open source. We welcome contributions that improve measurement accuracy, add providers, or enhance the project.

## For Sandbox Providers

Want your provider included in the benchmark? 

**Option 1: Become a Sponsor**

Sponsorship includes full integration and maintenance. See [SPONSORSHIP.md](./SPONSORSHIP.md).

**Option 2: Submit a PR**

We accept community contributions to add providers. Requirements:

1. **Public SDK**: Your provider must have a publicly available SDK (npm package preferred)
2. **Standard Interface**: Must support basic sandbox operations (create, run command, destroy)
3. **Free Tier or Credits**: We need ongoing API access for daily benchmarks
4. **Documentation**: Clear setup instructions for API keys/credentials

### Adding a Provider (Direct Mode)

1. Create a new SDK wrapper in `src/direct-providers.ts`:

```typescript
export const yourProvider: DirectBenchmarkConfig = {
  name: 'your-provider',
  requiredEnvVars: ['YOUR_API_KEY'],
  createCompute: () => new YourSDK({
    apiKey: process.env.YOUR_API_KEY!,
  }),
};
```

2. Add to the providers array in `src/direct-run.ts`

3. Update `env.example` with required environment variables

4. Submit a PR with:
   - The code changes
   - Documentation for obtaining API credentials
   - Confirmation you can provide ongoing API access

### Adding a Provider (Magic Mode)

Magic Mode requires integration with the ComputeSDK orchestrator. Open a GitHub issue to discuss.

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
# Run direct mode benchmarks (requires API keys in .env)
npm run bench:direct

# Run single provider
npm run bench:direct:e2b

# Run with custom iterations
npm run bench:direct -- --iterations 5
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
