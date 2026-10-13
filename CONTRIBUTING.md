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
pnpm install
cp benchmarks/.env.example benchmarks/.env
```

### Running Tests Locally

```bash
# Run the sandbox TTI benchmark (burst shape; sequential/staggered retired)
pnpm run bench

# Run a single provider (bench:* scripts forward flags)
pnpm run bench:e2b

# Combine flags
pnpm run bench:e2b -- --iterations 5 --concurrency 5

# Run browser benchmarks
pnpm run bench:browser
pnpm run bench:browser -- --provider browserbase

# Run storage benchmarks
pnpm run bench:storage
pnpm run bench:storage -- --provider aws-s3
pnpm run bench:storage -- --file-size 16MB
```


---

## Submitting a Benchmark

This is about contributing a new **benchmark** — a workload that measures something you
actually care about — as opposed to adding a provider (see *For Sandbox Providers*
above). Here you contribute the *thing being measured*.

> **In one sentence:** you author a realistic workload against a category's common
> ComputeSDK interface, wire it to that category's existing provider list, and ship it
> as a folder that runs across **every** provider in the category with a single
> `npm run` — no special machinery required.

### What a community benchmark is

A community benchmark is a **self-contained, runnable workload scoped to a category**
(sandboxes, browsers, storage, and more to come). You are not benchmarking a single
provider — you describe a representative piece of real work, and your script measures
how each provider in that category performs it.

The MVP is deliberately simple: **there is no repo-side harness to build or wait for.**
Your submission *is* the runner. It reuses the category's existing provider registry to
fan out, uses [`@computesdk/bench`](https://github.com/computesdk/computesdk/tree/main/packages/bench)
to time the work, and runs with one command both for you locally and for maintainers in
CI.

| | |
|---|---|
| **You contribute** | a workload (what to do) + a tiny runner that runs it across the category + the metrics that matter + a short rationale |
| **The repo provides** | the per-category provider registry your runner imports |
| **What runs** | your workload, against every provider in that category that has credentials available |

Concretely, a sandbox workload might be: *"create a sandbox, clone a repo, run
`npm install && npm run build`, and report build time."* Your runner imports the sandbox
provider list and runs that workload across e2b, Modal, Vercel, and every other sandbox
provider — and the result is a comparison of those providers **on that build workload**.

### Core principles

These five rules define a valid submission. The rest of this section explains how to
satisfy them.

1. **Built on `@computesdk/bench`.** Every community benchmark uses
   [`@computesdk/bench`](https://github.com/computesdk/computesdk/tree/main/packages/bench)
   to define and time its steps. This is what makes results comparable, ingestible by
   the platform, and safe (logs are redacted, uploads never fail the run). It is a
   hard requirement.
2. **Provider-agnostic.** A workload uses *only* the category's common interface
   (e.g. `compute.sandbox.create / runCommand / destroy`). No provider-specific
   branching, no calling into one vendor's extra features. If it can't run on every
   provider unchanged, it isn't a fair cross-provider benchmark.
3. **Fans out over the category's provider registry.** You don't hardcode a provider
   list. Your runner imports the category's existing registry (e.g.
   `src/sandbox/providers.ts`) and loops over it, so any provider added later is picked
   up automatically.
4. **A missing capability or credential is a recorded skip/failure, not a crash.** If a
   provider lacks credentials on the machine, skip it. If it can't perform your workload,
   that's a *failure result* for that provider — recorded by `bench`, never an uncaught
   error that aborts the run for the other providers. When a provider later gains the
   capability (or you add its key), it starts passing automatically — no edit required.
5. **Self-contained and runnable.** The whole submission lives in one folder and runs
   with a single `npm run bench:<category>:<slug>`. No harness, no central registry of
   workloads, no maintainer plumbing has to exist for your PR to work.

> **Note on existing benchmarks.** The current sandbox, browser, and storage tests
> predate this model and do not yet use `@computesdk/bench`. They are grandfathered.
> The requirements here apply to **new community submissions**.

### Step 1 — Choose a category

Pick the category your workload belongs to. The category determines two things: the
**common interface** you write against, and the **provider registry** your runner
imports and loops over.

| Category | Common interface (illustrative) | Provider registry to import |
|----------|----------------------------------|------------------------------|
| `sandbox` | `compute.sandbox.create / runCommand / destroy` | `src/sandbox/providers.ts` → `providers` |
| `browser` | `provider.session.create / destroy` (+ CDP) | `src/browser/providers.ts` → `browserProviders` |
| `storage` | `storage.upload / download / delete` | `src/storage/providers.ts` → `storageProviders` |

Each registry entry is a `{ name, requiredEnvVars, createCompute() }` config — exactly
what your runner needs to skip providers without credentials and instantiate the rest.

If your workload needs a *new* category, open an issue first — a new category requires a
new provider registry and is a larger change than a single workload.

### Step 2 — Author the workload as `bench` steps

Model your workload as an ordered pipeline of named steps. Let `iterations` represent
the number of units (e.g. sandboxes) you want, and use `ctx.iteration` to index them.
This is the lifecycle-as-steps pattern from the
[`bench` README](https://github.com/computesdk/computesdk/tree/main/packages/bench#scale-lifecycle-pattern).

```ts
// src/sandbox/workloads/repo-build/workload.ts
import { createBench } from '@computesdk/bench';

// `compute` is the instance your runner hands you for the provider under test.
// You write against the common interface only — never a specific provider's SDK.
export function buildWorkload(compute: any, provider: string) {
  const bench = createBench({ label: `sandbox.repo-build.${provider}` });
  const sandboxes: Array<any | undefined> = [];

  bench
    .add('create', async (ctx) => {
      sandboxes[ctx.iteration] = await compute.sandbox.create();
    }, { concurrency: 10 })
    .add('clone', async (ctx) => {
      await sandboxes[ctx.iteration]?.runCommand('git clone https://github.com/example/repo .');
    })
    .add('build', async (ctx) => {
      const start = performance.now();
      await sandboxes[ctx.iteration]?.runCommand('npm install && npm run build');
      bench.emit('build_ms', { value: performance.now() - start });
    })
    .add('destroy', async (ctx) => {
      await sandboxes[ctx.iteration]?.destroy();
    }, { runOnFailed: true }); // cleanup even for units that failed earlier

  return bench;
}
```

Key points:

- **Steps run in declaration order**, each fully across all units before the next.
  Each step's `Runs` maps to your unit count, giving you per-phase timing
  (`create` vs `clone` vs `build` vs `destroy`).
- **`runOnFailed: true`** on cleanup steps ensures teardown happens even for units
  that failed an earlier step.
- **`ctx.log(...)`** attaches messages to that unit's span (redacted automatically).
- **`bench.emit(name, { value })`** records a custom metric — this is how you surface
  the numbers your benchmark cares about (see Step 5).

### Step 3 — Write the runner

The runner is what makes the MVP work without a harness. It imports the category's
provider registry, loops over it, skips providers without credentials, and runs your
workload against the rest with `throwOnError: false` so one failing provider never
aborts the others.

```ts
// src/sandbox/workloads/repo-build/run.ts
import '../../../env.js';                       // loads .env, exactly like src/run.ts
import { providers } from '../../providers.js'; // the category's existing registry
import { buildWorkload } from './workload.js';

const ITERATIONS = 10;

for (const provider of providers) {
  const missing = provider.requiredEnvVars.filter((v) => !process.env[v]);
  if (missing.length) {
    console.log(`skip ${provider.name} — missing ${missing.join(', ')}`);
    continue; // no credentials on this machine → skipped, not failed
  }

  const compute = provider.createCompute();
  const bench = buildWorkload(compute, provider.name);

  const result = await bench.run({
    mode: 'concurrent',
    iterations: ITERATIONS,
    warmup: 0,
    provider: provider.name, // tags every span with the provider under test
    throwOnError: false,     // a failing provider does not abort the others
  });

  for (const task of result.tasks) {
    console.log(
      `${provider.name} ${task.taskName}: p95=${task.stats.p95Ms}ms ` +
      `(${task.successes} ok / ${task.failures} failed)`
    );
  }
}
```

Then add one line to `package.json` so it runs with a single command:

```jsonc
{
  "scripts": {
    "bench:sandbox:repo-build": "tsx src/sandbox/workloads/repo-build/run.ts"
  }
}
```

That's the entire mechanism. There is no discovery, validation, or scoring service to
build — the loop above is the runner, and it lives in your folder.

### Step 4 — Respect the portability rule

A community benchmark must run on **every** provider in the category with no changes.
That means:

- **Use only the common interface.** Don't reach into a specific provider's SDK or
  pass provider-only options. If you find yourself writing `if (provider === 'x')`,
  the workload isn't portable.
- **Handle capability gaps as failures, not throws.** If your workload relies on
  something a provider may not support, the step should surface the gap as a failed
  span rather than crash. With `throwOnError: false`, `bench` records the failed span
  and keeps every other provider running. The provider simply ranks as failing on this
  benchmark.

```ts
.add('snapshot', async (ctx) => {
  const sbx = sandboxes[ctx.iteration];
  if (typeof sbx?.snapshot !== 'function') {
    // capability gap → recorded failure, NOT a thrown crash that aborts peers
    throw new Error('readiness_failed: provider does not support snapshot');
  }
  await sbx.snapshot();
})
```

The thrown error here is caught by `bench` (because `throwOnError: false`), recorded
against this unit's span, and classified — it does not abort peers. The distinction
that matters: a *recorded* failure is fine; an *unhandled* failure that takes down the
whole run is not.

When a provider later adds the capability, the `typeof` check passes and the provider
starts succeeding — automatically, with no edit to your benchmark.

### Step 5 — Metrics & naming conventions

Comparability depends on consistent naming. Results are aggregated by these names, so
they are load-bearing, not cosmetic.

| What | Convention | Example |
|------|-----------|---------|
| Run label | `<category>.<workload>.<provider>` | `sandbox.repo-build.e2b` |
| Step names | lowercase, dotted for sub-phases | `create`, `exec.initial`, `destroy` |
| Custom metrics | `snake_case`, unit-suffixed | `build_ms`, `tti_ms`, `bytes_written` |

Emit each metric that matters via `bench.emit('<name>', { value })`. Always include the
unit in the name (`_ms`, `_bytes`, `_count`) so it can't be misread.

### Step 6 — Report what you measured, and why

You decide what "good" means for your workload — that's the whole point of a community
benchmark. For the MVP you don't ship a scoring service; you ship a `README.md` in the
folder that makes your measurement legible:

- **What the workload does** and why it's representative of real use.
- **Which metrics matter** (the names you `emit`) and what each captures.
- **What "good" vs "unusably slow" looks like** for this workload — the rough
  thresholds a maintainer would use when folding your results into the published
  comparison.

This mirrors the project's scoring philosophy (see the *Composite Score* section of
[METHODOLOGY.md](./METHODOLOGY.md)) — fixed thresholds, success rate as a multiplier —
without requiring any scoring code to exist yet. If and when the results are published
on the site, maintainers turn this rationale into a concrete score; writing it clearly
is what lets them do that responsibly.

### Step 7 — Lay out your submission

A submission is a **single self-contained folder** plus a one-line `package.json` script
so it can be run.

```
src/<category>/workloads/<slug>/
  workload.ts     # exports buildWorkload(compute, provider) → bench   (Step 2)
  run.ts          # the runnable entry point that fans out             (Step 3)
  README.md       # what it measures, the metrics, and the thresholds  (Step 6)
  fixtures/       # optional — pinned assets so the workload never depends on live external state
```

Rules:

- **`<slug>`** is kebab-case and *is* the `<workload>` segment of every run label —
  `repo-build` → `sandbox.repo-build.<provider>`. One name, one source of truth.
- **One workload per folder, one folder per PR** — keeps review scoped.
- **Everything specific to your benchmark lives in the folder.** The only shared files
  you touch are the conditional ones below.

#### Files you touch outside your folder

- **`package.json`** — always: add the one `bench:<category>:<slug>` script (Step 3).
  Also add `@computesdk/bench` to `dependencies` if it isn't there yet — the first
  submission introduces it.
- **`env.example`** — only if the *workload itself* takes config or secrets (a target
  URL, a token), separate from provider credentials. Document the variable there; never
  commit its value.

So a typical PR is your new folder plus a one-line script entry.

### Step 8 — Run it locally before submitting

After the [Development Setup](#development-setup) below (`npm install`, `cp env.example
.env`, add keys for whichever providers you can test), run your benchmark with the
script you added:

```bash
npm run bench:sandbox:repo-build
```

You don't need credentials for every provider. Your runner skips any provider whose
`requiredEnvVars` aren't set, so locally it runs against the one or two you have keys
for; in CI, maintainers run it with the full set. Confirm:

- The workload completes against the providers you have keys for, and providers without
  keys print a `skip` line rather than erroring.
- A provider that *can't do the workload* shows up as a **failure** (failed tasks in the
  output) and the run still finishes — it doesn't throw and abort. To check this, keep
  a provider you expect can't do the workload in the loop and confirm the run completes.
- Your metrics appear with the names your README references (`build_ms`, etc.).

While iterating, drop `ITERATIONS` to `2`–`3` in `run.ts` so each pass is fast, then
restore it before submitting.

### Opening the PR

You submit by opening a pull request against `master`. Submissions follow a consistent
shape so reviewers always know where everything is:

| | Convention |
|---|---|
| **Branch** | `benchmark/<category>-<slug>` — e.g. `benchmark/sandbox-repo-build` |
| **PR title** | `Add <category> benchmark: <slug>` |
| **Scope** | One workload (one folder) per PR |
| **Description** | What the workload does · why it's representative of real use · which providers you tested locally · a link to the folder's `README.md` rationale |

### Submission checklist

Before you open the PR, confirm:

**Format**
- [ ] One self-contained folder at `src/<category>/workloads/<slug>/`.
- [ ] Contains `workload.ts`, `run.ts`, and `README.md`.
- [ ] `<slug>` is kebab-case and matches the `<workload>` segment of the label.
- [ ] One `bench:<category>:<slug>` script added to `package.json`.
- [ ] `@computesdk/bench` is in `dependencies` (add it if it isn't yet).

**Workload**
- [ ] Built on `@computesdk/bench` (`createBench` / `add` / `run`).
- [ ] Uses **only** the category's common interface — no provider-specific branching.
- [ ] The runner imports the category's provider registry and loops over it — no
      hardcoded provider list.
- [ ] Providers without credentials are **skipped**; providers that can't do the
      workload are **recorded failures**, never uncaught crashes (`throwOnError: false`).
- [ ] Cleanup steps use `runOnFailed: true`.
- [ ] Metrics emitted via `bench.emit` follow the naming conventions.

**Rationale & safety**
- [ ] `README.md` explains the metrics and what "good" vs "unusably slow" means.
- [ ] No secrets committed; any workload config comes from env vars documented in
      `env.example`.
- [ ] You ran it locally against at least one provider (Step 8).

### What happens next

1. A maintainer reviews the workload for portability and the README for fairness.
2. We may discuss thresholds and how your results fold into the published comparison —
   the rationale guides this.
3. Once accepted, your benchmark runs across the full category registry and its results
   are published alongside the others.

Methodology and scoring changes affect comparability, so expect discussion before a new
benchmark is merged (see *Methodology Improvements* above).

> **Looking further ahead.** Once there are several workloads, we may add a small
> repo-side runner that discovers and scores them uniformly so contributors don't each
> write a `run.ts`. That is explicitly **post-MVP** and not required for your submission
> today — a design sketch lives in
> [workload-harness-design.md](./workload-harness-design.md). The MVP flow above needs
> none of it.

---

### Code Style

- TypeScript with strict mode
- ES modules (`import`/`export`)
- Prettier for formatting (run `pnpm run format` if available)

## Code of Conduct

- Be respectful and constructive
- Focus on technical merit
- No promotional content in issues/PRs
- Disclose any conflicts of interest (e.g., if you work for a benchmarked provider)

## Questions

- **General questions**: Open a GitHub issue
- **Sponsorship inquiries**: See [SPONSORSHIP.md](./SPONSORSHIP.md) or email garrison@computesdk.com