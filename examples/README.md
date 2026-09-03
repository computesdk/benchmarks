# benchsdk Examples

Each `*.bench.ts` file here demonstrates one benchsdk capability. All examples are self-contained and use only local Node APIs, but `bench run` requires a platform API key or OAuth token even with `--dry-run` (the flag only skips uploading).

## Running an example

```bash
pnpm -r --filter "./packages/**" build
BENCHMARKS_PLATFORM_API_KEY=bp-... pnpm exec bench run examples/01-hello.bench.ts --dry-run
```

## Examples

| File | Capability |
|------|-----------|
| [01-hello.bench.ts](./01-hello.bench.ts) | Minimal config, task, `step`, `measure`, `log` |
| [02-shapes.bench.ts](./02-shapes.bench.ts) | `shapes` — named benchmark variants |
| [03-phases.bench.ts](./03-phases.bench.ts) | `phases` — named run segments |
| [04-round-robin.bench.ts](./04-round-robin.bench.ts) | `groupBy: 'round'` — fair participant interleaving |
| [05-scoring.bench.ts](./05-scoring.bench.ts) | `scoring` — metrics, success rules, higher/lower-is-better |
| [06-custom-flags.bench.ts](./06-custom-flags.bench.ts) | `customCliFlags` — pass benchmark-specific CLI flags |
| [07-error-handling.bench.ts](./07-error-handling.bench.ts) | `TaskError`, step `timeoutMs`, `try/finally`, and leveled `log` |
| [08-env-gated.bench.ts](./08-env-gated.bench.ts) | `requiredEnvVars` and `defaultProviders` |
| [09-on-complete.bench.ts](./09-on-complete.bench.ts) | `onScore` and `onComplete` hooks |
| [10-shared-run.bench.ts](./10-shared-run.bench.ts) | `--run-key` for multi-process shared runs |
| [11-logging.bench.ts](./11-logging.bench.ts) | leveled `log`, step output capture, and `captureOutput` |

For the full authoring guide, see [`WRITING_BENCHMARKS.md`](../WRITING_BENCHMARKS.md).
