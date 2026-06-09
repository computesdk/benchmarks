# Submitting a Benchmark

This guide is for **community members who want to contribute a new benchmark** — a
workload that measures something they actually care about — for consideration in
ComputeSDK Benchmarks.

It is **not** about getting a provider added. If you want your provider included in
the existing tests, see [CONTRIBUTING.md](./CONTRIBUTING.md) instead. This guide is
about contributing the *thing being measured*.

> **In one sentence:** you author a realistic workload against a category's common
> ComputeSDK interface, and the repo runs it across **every** provider in that
> category so they can be compared on *your* workload.

---

## What a community benchmark is

A community benchmark is a **workload scoped to a category** (sandboxes, browsers,
storage, and more to come). You are not benchmarking a single provider — you are
describing a representative piece of real work, and we measure how each provider in
that category performs it.

| | |
|---|---|
| **You contribute** | a workload (what to do) + the metrics that matter + a proposed score and why |
| **The repo owns** | the provider registry, the per-category harness, and the final say on scoring |
| **What runs** | your workload, unchanged, against every provider registered in the category |

Concretely, a sandbox workload might be: *"create a sandbox, clone a repo, run
`npm install && npm run build`, and report build time."* That workload then runs
across e2b, Modal, Vercel, and every other sandbox provider — and the result is a
comparison of those providers **on that build workload**.

---

## Core principles

These five rules define a valid submission. The rest of this guide explains how to
satisfy them.

1. **Built on `@computesdk/bench`.** Every community benchmark uses
   [`@computesdk/bench`](https://github.com/computesdk/computesdk/tree/main/packages/bench)
   to define and run its steps. This is what makes results comparable, ingestible by
   the platform, and safe (logs are redacted, uploads never fail the run). It is a
   hard requirement.
2. **Provider-agnostic.** A workload uses *only* the category's common interface
   (e.g. `compute.sandbox.create / runCommand / destroy`). No provider-specific
   branching, no calling into one vendor's extra features. If it can't run on every
   provider unchanged, it isn't a fair cross-provider benchmark.
3. **Runs against the whole category registry.** You don't pick providers. Your
   workload runs against every provider currently registered in the category, and any
   provider added later is picked up automatically.
4. **A missing capability is a recorded failure, not a crash.** If a provider can't
   perform your workload, that's a *failure result* for that provider on this
   benchmark — noted, and optionally filtered out of the displayed comparison. It must
   **never** throw an uncaught error that aborts the run for everyone else. When that
   provider later gains the capability, it starts passing automatically — no edit to
   your benchmark required.
5. **You propose the scoring, and you explain it.** You declare which metrics matter
   and how they combine into a score, in a **declarative, maintainer-editable** form,
   with a written rationale. Maintainers may retune it.

> **Note on existing benchmarks.** The current sandbox, browser, and storage tests
> predate this model and do not yet use `@computesdk/bench`. They are grandfathered.
> The requirements here apply to **new community submissions**.

---

## Step 1 — Choose a category

Pick the category your workload belongs to. The category determines two things: the
**common interface** you write against, and the **provider registry** you run against.

| Category | Common interface (illustrative) | Registry |
|----------|----------------------------------|----------|
| `sandbox` | `compute.sandbox.create / runCommand / destroy` | `src/sandbox/providers.ts` |
| `browser` | `provider.session.create / destroy` (+ CDP) | `src/browser/providers.ts` |
| `storage` | `storage.upload / download / delete` | `src/storage/providers.ts` |

If your workload needs a *new* category, open an issue first — a new category requires
a repo-side harness and is a larger change than a single workload.

---

## Step 2 — Author the workload as `bench` steps

Model your workload as an ordered pipeline of named steps. Let `iterations` represent
the number of units (e.g. sandboxes) you want, and use `ctx.iteration` to index them.
This is the lifecycle-as-steps pattern from the
[`bench` README](https://github.com/computesdk/computesdk/tree/main/packages/bench#scale-lifecycle-pattern).

```ts
import { createBench } from '@computesdk/bench';

// `compute` is the category instance the harness hands you for the provider
// currently under test. You write against the common interface only.
export function buildWorkload(compute, provider: string) {
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

Then the harness runs it (this part is repo-side, shown so you understand the shape):

```ts
await bench.run({
  mode: 'concurrent',
  iterations: 10,
  warmup: 0,
  provider,            // tags every span with the provider under test
  throwOnError: false, // a failing provider does not abort the others
});
```

Key points:

- **Steps run in declaration order**, each fully across all units before the next.
  Each step's `Runs` maps to your unit count, giving you per-phase timing
  (`create` vs `clone` vs `build` vs `destroy`).
- **`runOnFailed: true`** on cleanup steps ensures teardown happens even for units
  that failed an earlier step.
- **`ctx.log(...)`** attaches messages to that unit's span (redacted automatically).
- **`bench.emit(name, { value })`** records a custom metric — this is how you surface
  the numbers your scoring cares about (see Step 4).

---

## Step 3 — Respect the portability rule

A community benchmark must run on **every** provider in the category with no changes.
That means:

- **Use only the common interface.** Don't reach into a specific provider's SDK or
  pass provider-only options. If you find yourself writing `if (provider === 'x')`,
  the workload isn't portable.
- **Handle capability gaps as failures, not throws.** If your workload relies on
  something a provider may not support, the step should *catch* the gap and record a
  failure rather than let it crash. With `throwOnError: false`, `bench` records the
  failed span and keeps every other provider running. The provider simply ranks as
  failing on this benchmark.

```ts
.add('snapshot', async (ctx) => {
  const sbx = sandboxes[ctx.iteration];
  if (typeof sbx?.snapshot !== 'function') {
    // capability gap → recorded failure, NOT a thrown crash
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

---

## Step 4 — Metrics & naming conventions

Comparability depends on consistent naming. The platform aggregates results by these
names, so they are load-bearing, not cosmetic.

| What | Convention | Example |
|------|-----------|---------|
| Run label | `<category>.<workload>.<provider>` | `sandbox.repo-build.e2b` |
| Step names | lowercase, dotted for sub-phases | `create`, `exec.initial`, `destroy` |
| Custom metrics | `snake_case`, unit-suffixed | `build_ms`, `tti_ms`, `bytes_written` |

Emit each metric your score depends on via `bench.emit('<name>', { value })`. Always
include the unit in the name (`_ms`, `_bytes`, `_count`) so it can't be misread.

---

## Step 5 — Propose a score, and explain it

You decide what "good" means for your workload — that's the whole point of a community
benchmark. But the scoring must be **declarative** (so maintainers can retune it
without touching your measurement code) and **explained** (so reviewers and readers
know what the numbers mean). No unexplained magic numbers.

Ship two things alongside the workload:

### 1. A declarative scoring spec

A plain data object — a list of the metrics you emit, each with a direction, a weight,
and a ceiling. A maintainer can adjust a weight or flip a direction by editing this
block alone.

```ts
export const scoring = {
  // 0–100, higher = better
  metrics: [
    { metric: 'build_ms', direction: 'lower-better', weight: 0.7, ceilingMs: 120_000 },
    { metric: 'tti_ms',   direction: 'lower-better', weight: 0.3, ceilingMs: 10_000 },
  ],
  // multiply the weighted timing score by the success rate (0–1)
  successMultiplier: true,
};
```

This mirrors the project's existing scoring philosophy (see the *Composite Score*
section of [METHODOLOGY.md](./METHODOLOGY.md)): each metric is scored against a fixed
ceiling so scores are absolute, weights sum to 1.0, and success rate is a
non-negotiable multiplier.

### 2. A written rationale

A short prose block — in your PR and as a comment by the spec — answering:

- **Why these metrics?** What about your real workflow do they capture?
- **Why these weights?** What matters most, and why?
- **Why these ceilings?** What counts as "unusably slow" for this workload?

Maintainers may edit the spec for fairness or comparability. The rationale is what lets
them do that responsibly, so make it clear.

---

## Step 6 — Lay out your submission

A submission is a **single self-contained folder**. The runner finds it by scanning
`src/<category>/workloads/*/` — there is **no central list to edit**, so two
submissions can never touch the same file (no merge conflicts), and everything about a
benchmark lives in one place.

```
src/<category>/workloads/<slug>/
  workload.ts     # exports buildWorkload(compute, provider) → bench   (Step 2)
  manifest.ts     # describes the benchmark so the runner can find and run it
  scoring.ts      # the declarative scoring spec                       (Step 5)
  README.md       # the written rationale                             (Step 5)
  fixtures/       # optional — pinned assets so the workload never depends on live external state
```

Rules:

- **`<slug>`** is kebab-case and *is* the `<workload>` segment of every run label —
  `repo-build` → `sandbox.repo-build.<provider>`. One name, one source of truth.
- **One workload per folder, one folder per PR** — keeps review and the scoring
  discussion scoped.
- **Everything the runner needs lives in the folder.** You never edit a shared file.

### The manifest

`manifest.ts` is what makes the folder *self-describing* — the runner reads it to learn
what to run and how, without looking anywhere else:

```ts
import type { WorkloadManifest } from '../../../bench/types'; // repo-owned type
import { buildWorkload } from './workload';
import { scoring } from './scoring';

export const manifest: WorkloadManifest = {
  slug: 'repo-build',
  category: 'sandbox',
  label: 'sandbox.repo-build',       // provider is appended at run time
  build: buildWorkload,              // your workload (Step 2)
  scoring,                           // your scoring spec (Step 5)
  run: {                             // this workload's run parameters
    iterations: 10,
    concurrency: 10,
    warmup: 0,
    timeoutMs: 120_000,
  },
  metrics: [                         // every metric the workload emits, declared
    { name: 'build_ms', unit: 'ms' },
    { name: 'tti_ms', unit: 'ms' },
  ],
};
```

Why each field matters:

- `slug` / `category` / `label` — identity, and which registry to run against.
- `build` / `scoring` — point at the two code pieces you authored.
- `run` — run parameters live *in the submission*, not hardcoded in the runner, so your
  workload controls its own iteration count, concurrency, and timeouts.
- `metrics` — declares every metric you emit. If `scoring.ts` references a metric not
  listed here, the submission is **rejected before it ever runs** — this catches a typo
  that would otherwise silently score nothing.

### The only two conditional touch-points

These are the *sole* cases where a submission edits anything outside its folder:

- **`package.json`** — only if your workload needs a new dependency (e.g. a browser
  workload pulling in Playwright).
- **`env.example`** — only if the *workload itself* takes config or secrets (a target
  URL, a token), separate from provider credentials. Document the variable there; never
  commit its value.

If your workload needs neither, **your PR is exactly one new folder.**

---

## Step 7 — Run it locally before submitting

First, get the repo set up:

```bash
git clone https://github.com/computesdk/benchmarks.git
cd benchmarks
npm install
cp env.example .env   # add API keys for whichever providers you can test
```

You don't need credentials for every provider to test locally. The repo runs your
workload across the *whole* registry on merge, but for pre-submission testing you only
need to confirm it works against one or two providers you have keys for. Do that with a
small **throwaway driver** that imports a single provider directly and runs your
workload — no repo-side harness required:

```ts
// scratch/run-local.ts — for local testing only, NOT part of your submission
import { e2b } from '@computesdk/e2b';
import { buildWorkload } from '../src/sandbox/workloads/repo-build/workload';

const compute = e2b({ apiKey: process.env.E2B_API_KEY! });
const bench = buildWorkload(compute, 'e2b');

const result = await bench.run({
  mode: 'concurrent',
  iterations: 3,        // keep it small while iterating
  warmup: 0,
  provider: 'e2b',
  throwOnError: false,  // same as production — capability gaps surface as failures
});

for (const task of result.tasks) {
  console.log(
    `${task.taskName}: p95=${task.stats.p95Ms}ms  ` +
    `(${task.successes} ok / ${task.failures} failed)`
  );
}
```

Run it:

```bash
npx tsx scratch/run-local.ts
```

Swap the import and constructor to test a second provider (e.g. `modal` from
`@computesdk/modal`). To check the **failure-not-crash** behavior, point the driver at
a provider you expect *can't* do the workload and confirm the run still finishes and
prints failed tasks rather than throwing.

> The `scratch/` driver is throwaway — don't include it in your PR. On merge, the
> repo's harness handles the cross-provider fan-out for you; you only ever write the
> workload (and its scoring spec), never the driver.

When you run it, confirm:

- The workload completes against the providers you have keys for.
- A provider that can't do the workload shows up as a **failure**, and the run still
  finishes (it doesn't throw and abort).
- Your metrics appear with the names your scoring spec references (`build_ms`, etc.).

---

## Opening the PR

Submissions follow a consistent shape so reviewers always know where everything is:

| | Convention |
|---|---|
| **Branch** | `benchmark/<category>-<slug>` — e.g. `benchmark/sandbox-repo-build` |
| **PR title** | `Add <category> benchmark: <slug>` |
| **Scope** | One workload (one folder) per PR |
| **Description** | What the workload does · why it's representative of real use · which providers you tested locally · a link to the folder's `README.md` rationale |

## Submission checklist

Before you open the PR, confirm:

**Format**
- [ ] One self-contained folder at `src/<category>/workloads/<slug>/`.
- [ ] Contains `workload.ts`, `manifest.ts`, `scoring.ts`, and `README.md`.
- [ ] `<slug>` is kebab-case and matches the `<workload>` segment of the label.
- [ ] No central/shared file edited (aside from the conditional `package.json` /
      `env.example` touch-points, if your workload needs them).

**Workload**
- [ ] Built on `@computesdk/bench` (`createBench` / `add` / `run`).
- [ ] Uses **only** the category's common interface — no provider-specific branching.
- [ ] Runs against the whole registry; no hardcoded provider list.
- [ ] Capability gaps are **recorded failures**, never uncaught crashes
      (`throwOnError: false`, gaps caught and classified).
- [ ] Cleanup steps use `runOnFailed: true`.
- [ ] Metrics emitted via `bench.emit`, follow the naming conventions, and are all
      declared in `manifest.ts`.

**Scoring & rationale**
- [ ] A **declarative** scoring spec is included (`scoring.ts`).
- [ ] A **written rationale** (`README.md`) explains the metrics, weights, and ceilings.

**Safety & verification**
- [ ] No secrets committed; any workload config comes from env vars documented in
      `env.example`.
- [ ] You ran it locally against at least one provider (Step 7).

## What happens next

1. A maintainer reviews the workload for portability and the scoring for fairness.
2. We may propose edits to the scoring spec (weights, ceilings) — the rationale guides
   this discussion.
3. Once accepted, your workload runs across the full category registry and its results
   are published alongside the others.

Methodology and scoring changes affect comparability, so expect discussion before a
new benchmark is merged. See the *Methodology Improvements* note in
[CONTRIBUTING.md](./CONTRIBUTING.md).

---

## Prerequisite for maintainers

The grandfathered sandbox/browser/storage tests do not yet expose a generic
"run a `bench` workload across this category's registry" harness — only the scale
module (`src/scale/`) drives `@computesdk/bench` today, and it is sandbox-specific.
The code shapes in this guide assume a repo-side harness that does not exist yet. To
accept community submissions, it needs to:

1. **Discover** workloads by globbing `src/<category>/workloads/*/manifest.ts` — no
   central registry, so submissions never conflict.
2. **Validate** each manifest — required fields present, `<slug>` matches the folder
   and label, and every metric referenced by `scoring.ts` is declared in
   `manifest.metrics` (reject otherwise, before running).
3. **Run** each workload across the category registry: load the registry, instantiate
   each provider, hand `buildWorkload` a `compute` instance + provider name, and run
   with `throwOnError: false` so a failing provider never aborts the others.
4. **Score** results by applying the manifest's declarative `scoring` spec.

The `WorkloadManifest` type (imported by every submission's `manifest.ts`) is the
contract between submissions and this harness, and should ship with it.

A full design sketch of this harness — the `WorkloadManifest` type and the
discover/validate/run/score pipeline — is in
[workload-harness-design.md](./workload-harness-design.md).

## Questions

Open a GitHub issue. For methodology or scoring disputes, see the *Questions &
Disputes* section of [METHODOLOGY.md](./METHODOLOGY.md).
