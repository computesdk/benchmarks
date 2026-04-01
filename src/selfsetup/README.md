# Self-Setup Benchmark

This directory contains the **AI Self-Setup Benchmark** implementation — testing whether AI agents can autonomously discover, install, configure, and integrate sandbox providers.

## Quick Start

### List available providers

```bash
npm run selfsetup:list
```

### Run local test (creates environment, generates prompt)

```bash
npm run selfsetup:e2b
npm run selfsetup:daytona
npm run selfsetup:modal
# ... etc
```

## How It Works

1. **Environment Setup**: Creates fresh Node.js project in temp directory
2. **Prompt Generation**: Loads template with provider-specific credentials
3. **AI Execution**: OpenCode agent executes the 8-step protocol
4. **Validation**: Result is scored (0-100) based on the benchmark spec
5. **Reporting**: Results committed to `results/selfsetup/`

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

- `types.ts` — TypeScript interfaces
- `providers.ts` — Provider configurations (reuses TTI credentials)
- `prompt.md` — OpenCode prompt template
- `score.ts` — Scoring algorithm (0-100)
- `run.ts` — Test runner and CLI entry point
- `validate.ts` — Result validator
- `merge-results.ts` — Merge multiple provider results
- `summarize.ts` — Generate markdown summary

## CI/CD

Weekly runs via `.github/workflows/self-setup.yml`:
- Runs on Sunday at midnight UTC
- Uses OpenCode agent with full tool access
- Posts results to PR (if triggered by PR)
- Commits results to repo (on schedule/manual)

## Provider Credentials

Credentials are reused from existing TTI tests (in GitHub Secrets):
- `E2B_API_KEY`
- `DAYTONA_API_KEY`
- `MODAL_TOKEN_ID` + `MODAL_TOKEN_SECRET`
- `BL_API_KEY` + `BL_WORKSPACE`
- `RUNLOOP_API_KEY`
- `NSC_TOKEN`
- `HOPX_API_KEY`
- `CSB_API_KEY`
- `VERCEL_TOKEN` + `VERCEL_TEAM_ID` + `VERCEL_PROJECT_ID`

## Local Development

To test without OpenCode (setup only):

```bash
npm run selfsetup:e2b
# Then manually run the generated prompt with OpenCode
```
