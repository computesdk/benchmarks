# Self-Setup Benchmark

This directory contains the **AI Self-Setup Benchmark** implementation — testing whether AI agents can autonomously discover, install, configure, and integrate sandbox providers.

> **Status**: Production-ready with OpenCode integration
> 
> 📖 **[Production Guide →](./PRODUCTION.md)** - Deployment guide and troubleshooting

## Requirements

- **OpenCode CLI** - Must be installed on the runner
- **OPENCODE_API_KEY** - Set in GitHub Secrets

## Quick Start

### List available providers

```bash
npm run selfsetup:list
```

### Run local test

```bash
npm run selfsetup:e2b
npm run selfsetup:daytona
npm run selfsetup:modal
```

## How It Works

1. **Environment Setup** - Creates fresh Node.js project in temp directory
2. **Prompt Generation** - Loads template with provider-specific credentials
3. **AI Execution** - OpenCode agent executes the 8-step protocol
4. **Validation** - Result is scored (0-100) based on the benchmark spec
5. **Reporting** - Results committed to `results/selfsetup/`

## The 8-Step Protocol

1. **Discovery** — Find official SDK and docs
2. **Installation** — `npm install <package>`
3. **Configuration** — Read credentials from env
4. **Integration** — Write code to create sandbox + run `node -v`
5. **Execution** — Run the code
6. **Verification** — Confirm it worked
7. **Scoring** — 0-100 based on 5 weighted criteria
8. **Cleanup** — Save results

## Scoring (0-100)

| Category | Weight | Criteria |
|----------|--------|----------|
| Fully Autonomous | 40% | Zero human intervention |
| Time | 20% | ≤5min=100, ≤10min=70, ≤15min=40 |
| Code Quality | 20% | Clean, idiomatic, handles errors |
| Error Recovery | 10% | Graceful failure handling |
| Documentation | 10% | No AI complaints about docs |

**Pass threshold: ≥90/100**

## Files

| File | Purpose |
|------|---------|
| `types.ts` | TypeScript interfaces |
| `providers.ts` | Provider configurations (9 providers) |
| `prompt.md` | AI agent prompt template |
| `score.ts` | 0-100 scoring algorithm |
| `run.ts` | Test runner and CLI |
| `validate.ts` | Result validator with defaults |
| `merge-results.ts` | Merge multiple provider results |
| `summarize.ts` | Generate markdown summary |
| `agent.ts` | OpenCode agent runner |
| `PRODUCTION.md` | Production deployment guide |

## CI/CD

Weekly runs via `.github/workflows/self-setup.yml`:
- **Schedule**: Sunday at midnight UTC
- **Cost Control**: Max 3 providers per scheduled run
- **Artifacts**: Session recordings, result JSON (30-day retention)
- **Reporting**: PR comments + committed results

### Manual Triggers

Via GitHub Actions UI:
- **Provider**: Single or all providers
- **Timeout**: 10/15/20/30 minutes

## Provider Credentials

Reused from TTI tests (GitHub Secrets):
- `E2B_API_KEY`
- `DAYTONA_API_KEY`
- `MODAL_TOKEN_ID` + `MODAL_TOKEN_SECRET`
- `BL_API_KEY` + `BL_WORKSPACE`
- `RUNLOOP_API_KEY`
- `NSC_TOKEN`
- `HOPX_API_KEY`
- `CSB_API_KEY`
- `VERCEL_TOKEN` + `VERCEL_TEAM_ID` + `VERCEL_PROJECT_ID`
- `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`

Plus:
- `OPENCODE_API_KEY`

## Local Development

Requires OpenCode CLI installation.

```bash
# Ensure opencode is in PATH
which opencode

# Run test
npm run selfsetup:e2b
```

## Cost Estimates

| Run Type | Providers | Est. Cost |
|----------|-----------|-----------|
| Scheduled (weekly) | 3 | ~$1.50-6.00 |
| Full test | 9 | ~$4.50-18.00 |
| Single provider | 1 | ~$0.50-2.00 |

Monthly budget: ~$6-24 (weekly, 3 providers)

## Troubleshooting

See [PRODUCTION.md](./PRODUCTION.md) for:
- OpenCode CLI installation
- Debugging session recordings
- Common failures and solutions
- Production checklist
