# create-bench

Start a reproducible infrastructure benchmark with a TypeScript workload, configuration, and scripts powered by [`@benchsdk/runner`](https://www.npmjs.com/package/@benchsdk/runner).

[Public benchmarks](https://www.computesdk.com/benchmarks) · [Methodology](https://www.computesdk.com/methodology) · [Runnable examples](https://github.com/computesdk/benchmarks/tree/master/examples)

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

For authentication, runs, results, artifacts, and export, see the [Bench CLI guide](https://github.com/computesdk/benchmarks/blob/master/.agents/skills/benchsdk-cli/SKILL.md).
