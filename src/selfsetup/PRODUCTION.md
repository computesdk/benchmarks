# Self-Setup Benchmark - Production Guide

## Overview

The Self-Setup Benchmark tests whether AI agents can autonomously integrate sandbox providers. This is a **production-grade** implementation with cost controls, fallbacks, and comprehensive monitoring.

## Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   GitHub        │────▶│   Agent Runner  │────▶│   Provider      │
│   Actions       │     │   (Multi-       │     │   Sandbox       │
│   Workflow      │     │    Backend)     │     │                 │
└─────────────────┘     └─────────────────┘     └─────────────────┘
         │                       │
         ▼                       ▼
┌─────────────────┐     ┌─────────────────┐
│   Cost Tracking │     │   Session       │
│   & Budgets     │     │   Recording     │
└─────────────────┘     └─────────────────┘
```

## Agent Backends

The benchmark supports multiple AI agent backends with automatic fallback:

### 1. OpenCode (Primary)
- **Status**: Requires CLI installation
- **Cost**: ~$0.50-2.00 per 15-min session
- **Pros**: Full computer use, browser access, best for realistic testing
- **Cons**: Not publicly available yet

### 2. Aider (Fallback)
- **Status**: Available via pip
- **Cost**: ~$0.10-0.50 per run (API costs only)
- **Pros**: Open source, cheaper, good for code tasks
- **Cons**: No browser access, may struggle with complex discovery

### 3. Mock (Testing/Dev)
- **Status**: Always available
- **Cost**: $0
- **Pros**: Fast, predictable, great for testing the pipeline
- **Cons**: Not a real benchmark - returns simulated failures

## Cost Controls

### Per-Run Limits
- **Scheduled runs**: Maximum 3 providers (cost: ~$3-6)
- **Manual runs**: Can test all 9 providers with explicit approval
- **Emergency cutoff**: Runs costing >$10 require workflow_dispatch

### Provider Selection Strategy

Start with the easiest providers (fast, good docs):

1. **e2b** - Fast, excellent docs, clean SDK
2. **daytona** - Good docs, straightforward API
3. **modal** - Popular but complex (higher cost, longer runs)

Then expand to:
- **blaxel**, **runloop**, **namespace** - Medium complexity
- **codesandbox**, **hopx**, **vercel** - May have quirks

## Running the Benchmark

### Local Testing (Mock Mode - Free)

```bash
# Test the entire pipeline without spending money
npm run selfsetup:e2b  # Uses mock backend by default if OpenCode not installed
```

### CI Testing (Single Provider)

```bash
# Via GitHub UI: Actions → Self-Setup Benchmark → Run workflow
# Select provider: e2b
# Backend: auto
# Timeout: 15 minutes
```

### Production Run (Weekly)

Scheduled runs automatically test 3 providers (e2b, daytona, modal) every Sunday.

## Monitoring & Debugging

### Session Recordings

Each run produces:
- `result.json` - Structured benchmark result
- `session.log` - Full agent interaction log (if backend supports it)
- `prompt.txt` - The exact prompt sent to the agent

### Artifact Retention

- **Duration**: 30 days
- **Path**: `artifacts/selfsetup-<provider>/`

### Common Failures

| Symptom | Cause | Solution |
|---------|-------|----------|
| "No result generated" | Agent backend not available | Check backend detection step |
| Score 0/100 | Agent couldn't complete any steps | Check session.log for errors |
| Timeout | Provider too slow or agent stuck | Increase timeout or try different provider |
| "OpenCode CLI not available" | CLI not installed | Use mock backend or install CLI |

## Adding New Providers

1. Add to `src/selfsetup/providers.ts`:
```typescript
{
  name: 'newprovider',
  npmPackage: '@newprovider/sdk',
  importPath: '@newprovider/sdk',
  credentials: [
    { name: 'API Key', envVar: 'NEWPROVIDER_API_KEY', description: '...' }
  ],
  hints: ['Use NewProviderClient', '...']
}
```

2. Add credentials to GitHub Secrets:
- `NEWPROVIDER_API_KEY`

3. Add to workflow dropdown in `.github/workflows/self-setup.yml`

4. Add credentials case statement in workflow

## Cost Estimation

| Backend | Cost per Provider | 3 Providers | 9 Providers |
|---------|------------------|-------------|-------------|
| OpenCode | $0.50-2.00 | $1.50-6.00 | $4.50-18.00 |
| Aider | $0.10-0.50 | $0.30-1.50 | $0.90-4.50 |
| Mock | $0 | $0 | $0 |

**Monthly Budget** (weekly runs, 3 providers, OpenCode):
~$6-24 USD/month

## Production Checklist

Before relying on this in production:

- [ ] OpenCode CLI installation method confirmed
- [ ] At least 3 successful test runs completed
- [ ] Cost tracking verified (check agent-run.json for costUsd)
- [ ] Session recordings accessible
- [ ] Failure alerting configured (GitHub notifications)
- [ ] Budget alerts set up (if cost tracking available)
- [ ] Documentation updated with actual costs from first runs

## Security Considerations

- Provider credentials are GitHub Secrets (same as TTI tests)
- Session recordings may contain credential attempts
- Artifacts are retained for 30 days (consider shorter for sensitive data)
- Mock backend generates fake data (safe for public CI)

## Troubleshooting

### Agent Backend Detection Fails

Check the "Detect Agent Backends" step logs:
```
✅ OpenCode CLI available
✅ Aider CLI available
✅ Mock backend available
```

If OpenCode is missing, the workflow will fall back to Aider, then Mock.

### High Costs

1. Reduce timeout: `--timeout 10` instead of 15
2. Test fewer providers at once
3. Use Aider backend instead of OpenCode
4. Skip expensive providers (Modal is typically slowest)

### Inconsistent Results

This is expected for AI-driven benchmarks:
- Same prompt may produce different outcomes
- Network conditions affect discovery step
- Provider API rate limits may cause intermittent failures

Run multiple times and look at trends, not single results.
