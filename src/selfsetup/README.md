# Self-Setup Benchmark

This directory contains the **AI Self-Setup Benchmark** implementation — testing whether AI agents can autonomously discover, install, configure, and integrate sandbox providers.

> **Status**: Production-ready with multi-backend support (OpenCode, Aider, Mock)
> 
> 📖 **[Production Guide →](./PRODUCTION.md)** - Cost controls, troubleshooting, deployment

## Quick Start

### List available providers

```bash
npm run selfsetup:list
```

### Run local test (Mock mode - free)

```bash
npm run selfsetup:e2b      # Uses mock if OpenCode not installed
npm run selfsetup:daytona
npm run selfsetup:modal
```

### Test specific backend

```bash
# OpenCode (requires CLI installation)
BACKEND=opencode npm run selfsetup:e2b

# Aider (pip install aider-chat)
BACKEND=aider npm run selfsetup:e2b

# Mock (simulation, no API costs)
BACKEND=mock npm run selfsetup:e2b
```

## How It Works

1. **Environment Setup**: Creates fresh Node.js project in temp directory
2. **Backend Detection**: Tries OpenCode → Aider → Mock (in that order)
3. **Prompt Generation**: Loads template with provider-specific credentials
4. **AI Execution**: Agent executes the 8-step protocol
5. **Validation**: Result is scored (0-100) based on the benchmark spec
6. **Reporting**: Results committed to `results/selfsetup/`

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
| `agent.ts` | **Multi-backend agent runner** |
| `PRODUCTION.md` | **Production deployment guide** |

## CI/CD

Weekly runs via `.github/workflows/self-setup.yml`:
- **Schedule**: Sunday at midnight UTC
- **Cost Control**: Max 3 providers per scheduled run (~$3-6)
- **Backends**: OpenCode → Aider → Mock (auto-fallback)
- **Artifacts**: Session recordings, result JSON (30-day retention)
- **Reporting**: PR comments + committed results

### Manual Triggers

Via GitHub Actions UI:
- **Provider**: Single or all providers
- **Backend**: auto / opencode / aider / mock
- **Timeout**: 10/15/20/30 minutes

## Agent Backends

| Backend | Status | Cost/Run | Pros | Cons |
|---------|--------|----------|------|------|
| **OpenCode** | Requires install | $0.50-2.00 | Full computer use, browser | Not publicly available |
| **Aider** | `pip install` | $0.10-0.50 | Open source, cheaper | No browser access |
| **Mock** | Always ready | $0 | Fast, testing | Simulated results |

See [PRODUCTION.md](./PRODUCTION.md) for installation and configuration.

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

Plus API keys for backends:
- `OPENCODE_API_KEY`
- `OPENAI_API_KEY` (for Aider)
- `ANTHROPIC_API_KEY` (for Aider)

## Local Development

### Test the pipeline (free)

```bash
# Uses mock backend - no API costs
npm run selfsetup:e2b
```

### With real OpenCode

```bash
# Install OpenCode CLI first (when available)
# Then:
npx tsx src/selfsetup/run.ts e2b
```

### With Aider

```bash
pip install aider-chat
BACKEND=aider npx tsx src/selfsetup/run.ts e2b
```

## Cost Estimates

| Run Type | Providers | Backend | Est. Cost |
|----------|-----------|---------|-----------|
| Scheduled (weekly) | 3 | OpenCode | ~$1.50-6.00 |
| Full test | 9 | OpenCode | ~$4.50-18.00 |
| Development | Any | Mock | $0 |
| CI Testing | 1 | Aider | ~$0.10-0.50 |

Monthly budget: ~$6-24 (weekly, 3 providers, OpenCode)

## Troubleshooting

See [PRODUCTION.md](./PRODUCTION.md) for:
- Backend installation
- Cost optimization
- Debugging session recordings
- Common failures and solutions
- Production checklist
