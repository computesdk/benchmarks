# create-bench

Scaffold a new ComputeSDK benchmark project that uses [`@benchsdk/runner`](https://github.com/computesdk/benchmarks/tree/master/packages/benchsdk-runner).

## Usage

```sh
npx create-bench my-benchmark
```

Or with npm:

```sh
npm create bench my-benchmark
```

## What gets created

The CLI creates a directory with the given project name and writes:

- `package.json` — with `@benchsdk/runner`, `tsx`, and benchmark scripts
- `tsconfig.json` — basic TypeScript configuration
- `bench.ts` — a minimal benchmark using `defineBenchmarkConfig` / `defineTask`
- `.env.example` — environment variables to configure the worker
- `README.md` — instructions for the new project

## Next steps

1. `cd my-benchmark`
2. `pnpm install`
3. Copy `.env.example` to `.env` and fill in the required values
4. `pnpm bench`

For a full guide to authoring benchmarks and runnable examples covering every capability, see [`WRITING_BENCHMARKS.md`](../../WRITING_BENCHMARKS.md) and the [`examples/`](../../examples) directory.

For the full `bench` CLI reference (auth, runs, results, artifacts, export), see the [benchsdk-cli skill](../../.agents/skills/benchsdk-cli/SKILL.md).
