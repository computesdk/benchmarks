# Self-Setup Benchmark - Production Guide

## Overview

The Self-Setup Benchmark tests whether OpenCode AI agents can autonomously integrate sandbox providers. This is a **production-grade** implementation with cost controls and comprehensive monitoring.

## Requirements

### OpenCode CLI

The workflow requires OpenCode CLI to be installed on the runner.

**Installation:** (Update when distribution method is confirmed)
```bash
# Placeholder - actual installation TBD
# npm install -g @opencode-ai/cli
# or
# docker pull opencode/opencode-cli
```

**Verification:**
```bash
opencode --version
```

### GitHub Secrets

Required secrets:
- `OPENCODE_API_KEY` - Your OpenCode API key
- All provider credentials (same as TTI tests)

## Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   GitHub        │────▶│   OpenCode      │────▶│   Provider      │
│   Actions       │     │   Agent         │     │   Sandbox       │
│   Workflow      │     │   Runner        │     │                 │
└─────────────────┘     └─────────────────┘     └─────────────────┘
         │                       │
         ▼                       ▼
┌─────────────────┐     ┌─────────────────┐
│   Cost Tracking │     │   Session       │
│   & Budgets     │     │   Recording     │
└─────────────────┘     └─────────────────┘
```

## Cost Controls

### Per-Run Limits
- **Scheduled runs**: Maximum 3 providers (cost: ~$1.50-6)
- **Manual runs**: Can test all 9 providers
- **Emergency cutoff**: Runs can be cancelled if needed

### Provider Selection Strategy

Start with the easiest providers (fast, good docs):

1. **e2b** - Fast, excellent docs, clean SDK
2. **daytona** - Good docs, straightforward API
3. **modal** - Popular but complex (higher cost, longer runs)

Then expand to:
- **blaxel**, **runloop**, **namespace** - Medium complexity
- **codesandbox**, **hopx**, **vercel** - May have quirks

## Running the Benchmark

### CI Testing (Single Provider)

```bash
# Via GitHub UI: Actions → Self-Setup Benchmark → Run workflow
# Select provider: e2b
# Timeout: 15 minutes
```

### Production Run (Weekly)

Scheduled runs automatically test 3 providers (e2b, daytona, modal) every Sunday.

## Monitoring & Debugging

### Session Recordings

Each run produces:
- `result.json` - Structured benchmark result
- `session.log` - Full agent interaction log
- `prompt.txt` - The exact prompt sent to the agent
- `agent-run.json` - Runner metadata and timing

### Artifact Retention

- **Duration**: 30 days
- **Path**: `artifacts/selfsetup-<provider>/`

### Common Failures

| Symptom | Cause | Solution |
|---------|-------|----------|
| "OpenCode CLI not found" | CLI not installed | Install OpenCode on runner |
| "No result generated" | Agent failed or timed out | Check session.log for errors |
| Score 0/100 | Couldn't complete any steps | Check agent output for errors |
| Timeout | Provider too slow or agent stuck | Increase timeout or try different provider |

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

| Scenario | Providers | Est. Cost |
|----------|-----------|-----------|
| Weekly scheduled | 3 | ~$1.50-6.00/run |
| Full test | 9 | ~$4.50-18.00/run |
| Single provider | 1 | ~$0.50-2.00/run |

**Monthly Budget** (weekly runs, 3 providers):
~$6-24 USD/month

## Production Checklist

Before relying on this in production:

- [ ] OpenCode CLI installed on runners
- [ ] `OPENCODE_API_KEY` configured in GitHub Secrets
- [ ] At least 3 successful test runs completed
- [ ] Session recordings accessible and useful
- [ ] Failure alerting configured (GitHub notifications)
- [ ] Documentation updated with actual costs from first runs

## Security Considerations

- Provider credentials are GitHub Secrets (same as TTI tests)
- Session recordings may contain credential attempts
- Artifacts are retained for 30 days
- Consider shorter retention if sensitive data is a concern

## Troubleshooting

### OpenCode Not Available

If the "Check OpenCode CLI" step fails:

1. Verify OpenCode is installed:
   ```bash
   which opencode
   opencode --version
   ```

2. Check it's in PATH for the GitHub Actions runner

3. If using custom runners, ensure OpenCode is baked into the image

### High Costs

1. Reduce timeout: select 10 minutes instead of 15
2. Test fewer providers at once
3. Skip expensive providers (Modal is typically slowest)

### Inconsistent Results

This is expected for AI-driven benchmarks:
- Same prompt may produce different outcomes
- Network conditions affect discovery step
- Provider API rate limits may cause intermittent failures

Run multiple times and look at trends, not single results.

## Support

For issues with:
- **OpenCode**: Contact OpenCode support
- **This benchmark**: Open an issue in this repo
- **Provider SDKs**: Contact the provider directly
