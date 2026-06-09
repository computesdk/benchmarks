# Workload Harness — Design Sketch

> **Status:** design sketch / follow-up. This describes the repo-side machinery that
> [submitting-benchmarks.md](./submitting-benchmarks.md) assumes exists. Nothing here
> is built yet. It exists so we can agree on the contract before writing code.

## Purpose

Community benchmarks are *workloads* dropped into `src/<category>/workloads/<slug>/` as
self-contained folders (see the contributor guide). This harness is what turns one of
those folders into published, comparable results. Its job is four steps:

```
discover → validate → run → score
```

- **discover** every workload by globbing the filesystem — no central registry.
- **validate** each manifest against the contract before running anything.
- **run** the workload across the whole provider registry for its category, using
  `@computesdk/bench`, so a failing provider never aborts the others.
- **score** each provider on the workload using the manifest's declarative spec.

The `WorkloadManifest` type below is the contract between a submission and this harness.
It ships *with* the harness so submissions can import it.

---

## The types

```ts
// src/bench/types.ts — repo-owned, imported by every submission's manifest.ts

import type { createBench } from '@computesdk/bench';

type Bench = ReturnType<typeof createBench>;

/** A category whose providers a workload can run against. Extensible. */
export type Category = 'sandbox' | 'browser' | 'storage';

/** Built by the submission; the harness hands it a provider's compute instance. */
export type BuildWorkload = (compute: any, provider: string) => Bench;

/** One metric the workload emits via bench.emit(name, { value }). */
export interface MetricDecl {
  name: string;                 // snake_case, unit-suffixed, e.g. 'build_ms'
  unit: 'ms' | 'bytes' | 'count';
}

/** How the workload wants to be run. Lives in the submission, not the runner. */
export interface RunParams {
  iterations: number;           // unit count (e.g. number of sandboxes)
  concurrency?: number;         // in-flight cap in concurrent mode
  warmup?: number;              // default 0 for workloads
  timeoutMs?: number;           // per-iteration ceiling
}

/** One scored metric: how it folds into the 0–100 composite. */
export interface ScoredMetric {
  metric: string;               // must match a MetricDecl.name (or a built-in below)
  direction: 'lower-better' | 'higher-better';
  weight: number;               // weights across metrics sum to 1.0
  ceiling: number;              // value at/beyond which the metric scores 0 (or 100)
  stat?: 'median' | 'p95' | 'mean'; // which aggregate to score; default 'median'
}

/** The declarative scoring spec the submitter proposes (maintainer-editable). */
export interface ScoringSpec {
  metrics: ScoredMetric[];
  successMultiplier?: boolean;  // multiply timing score by success rate (default true)
}

/** The whole self-describing submission, exported from manifest.ts. */
export interface WorkloadManifest {
  slug: string;                 // kebab-case; must equal the folder name
  category: Category;
  label: string;                // `${category}.${slug}`; provider appended at run time
  build: BuildWorkload;
  scoring: ScoringSpec;
  run: RunParams;
  metrics: MetricDecl[];        // every metric the workload emits
}
```

Two **built-in metrics** every workload gets for free (derived by the harness from the
`bench` result, not emitted by the workload), usable in `scoring.metrics`:

| Metric | Source |
|--------|--------|
| `total_ms` | wall-clock per unit across all steps |
| `<step>_ms` | duration of a named step (e.g. `create_ms`, `build_ms` if `build` is a step) |

Anything else a scoring spec references must appear in `manifest.metrics`.

---

## Step 1 — Discover

Glob the workload folders; import each manifest. No central list, so two submissions
never touch the same file.

```ts
// pseudo — actual impl uses the repo's module loader
const manifestPaths = glob('src/*/workloads/*/manifest.ts');
const manifests = await Promise.all(
  manifestPaths.map(async (p) => ({ path: p, ...(await import(p)) }))
);
```

Each loaded module must export `manifest: WorkloadManifest`.

## Step 2 — Validate

Reject a submission *before running it* if any of these fail. Validation is cheap and
catches the failure modes that would otherwise silently corrupt results.

```ts
function validate(m: WorkloadManifest, folderName: string): string[] {
  const errs: string[] = [];

  if (m.slug !== folderName)
    errs.push(`slug "${m.slug}" must equal folder name "${folderName}"`);
  if (m.label !== `${m.category}.${m.slug}`)
    errs.push(`label must be "${m.category}.${m.slug}"`);

  // every scored metric must be declared or built-in
  const declared = new Set(m.metrics.map((x) => x.name));
  const builtin = (name: string) => name === 'total_ms' || name.endsWith('_ms');
  for (const s of m.scoring.metrics)
    if (!declared.has(s.metric) && !builtin(s.metric))
      errs.push(`scoring references undeclared metric "${s.metric}"`);

  // weights must sum to ~1.0
  const sum = m.scoring.metrics.reduce((a, s) => a + s.weight, 0);
  if (Math.abs(sum - 1) > 0.001)
    errs.push(`scoring weights sum to ${sum}, must be 1.0`);

  if (m.run.iterations < 1) errs.push('run.iterations must be >= 1');

  return errs;
}
```

A non-empty error list fails CI — the submission never runs.

## Step 3 — Run

For each provider in the category's registry, run the workload. The two things that
make this safe and self-contained:

- **`throwOnError: false`** so a provider that can't do the workload produces failed
  spans instead of aborting the run for everyone (the "failure, not crash" rule).
- **`onEvent`** captures the metric values the workload emits *locally*, so scoring
  needs no round-trip to the platform query API. (Events still upload in the
  background as usual.)

```ts
import { createBench } from '@computesdk/bench';

async function runWorkload(m: WorkloadManifest) {
  const registry = loadRegistry(m.category); // src/<category>/providers.ts
  const perProvider = [];

  for (const provider of registry) {
    // skip providers whose credentials aren't present (same as existing tests)
    const missing = provider.requiredEnvVars.filter((v) => !process.env[v]);
    if (missing.length) {
      perProvider.push({ provider: provider.name, skipped: true, reason: missing });
      continue;
    }

    const metrics = new MetricCollector(m.metrics); // captures bench.emit values

    // rebuild the bench per provider, tapping events for local metric capture
    const compute = provider.createCompute();
    const bench = m.build(compute, provider.name);
    bench.onEvent?.((e) => metrics.ingest(e)); // benchmark.metric / benchmark.span

    const result = await bench.run({
      mode: 'concurrent',
      iterations: m.run.iterations,
      concurrency: m.run.concurrency ?? m.run.iterations,
      warmup: m.run.warmup ?? 0,
      provider: provider.name,
      throwOnError: false,
    });

    perProvider.push({
      provider: provider.name,
      runId: result.runId,
      tasks: result.tasks,           // per-step timing + success/failure counts
      metrics: metrics.summarize(),  // { build_ms: { median, p95, mean }, ... }
      successRate: successRateOf(result),
    });
  }

  return perProvider;
}
```

`successRateOf` is computed from the `bench` result — the fraction of units that
completed every required (non-`runOnFailed`) step. Providers that hit a capability gap
land here with a low success rate rather than crashing the run.

> Like the existing methodology, providers should be run **sequentially** (one provider
> finishes before the next starts) to avoid contention and rate-limiting on the runner,
> with order randomized per run to remove time-of-day bias. See
> [METHODOLOGY.md](./METHODOLOGY.md).

## Step 4 — Score

Apply the manifest's declarative `ScoringSpec`. This deliberately mirrors the composite
scoring already documented in [METHODOLOGY.md](./METHODOLOGY.md): each metric scored
against a **fixed ceiling** (so scores are absolute, not relative to the field),
weighted sum, then multiplied by success rate.

```ts
function score(spec: ScoringSpec, row: ProviderRow): number {
  if (row.skipped) return 0;

  let timing = 0;
  for (const s of spec.metrics) {
    const value = pickStat(row, s.metric, s.stat ?? 'median');
    if (value == null) { /* metric never emitted → contributes 0 */ continue; }

    const ratio = value / s.ceiling;            // 0 = perfect, 1 = at ceiling
    const raw = s.direction === 'lower-better'
      ? 100 * (1 - ratio)
      : 100 * ratio;
    timing += clamp(raw, 0, 100) * s.weight;
  }

  const mult = (spec.successMultiplier ?? true) ? row.successRate : 1;
  return timing * mult;
}
```

Notes / decisions worth pinning down with maintainers:

- **Outlier trimming.** METHODOLOGY trims the top/bottom 5% of successful iterations
  before computing timing stats. The harness should do the same in `MetricCollector`
  for consistency.
- **Skipped vs failed.** A *skipped* provider (missing creds on the runner) is omitted
  from the published comparison; a *failed* provider (ran but couldn't do the workload)
  scores low and is shown, with the option to filter it out of the headline view.
- **Which stat to score.** Default `median` (robust, matches METHODOLOGY); the spec can
  override per metric via `stat`.

---

## Where this lives

```
src/bench/
  types.ts        # WorkloadManifest + supporting types (the submission contract)
  discover.ts     # glob + import manifests
  validate.ts     # the validation rules above
  run.ts          # run a workload across a category registry
  score.ts        # apply a ScoringSpec → composite per provider
  collector.ts    # MetricCollector — captures bench.emit values via onEvent
```

A CLI entry (e.g. `npm run workloads -- --category sandbox [--slug repo-build]`) ties
them together: discover → validate (fail fast) → run → score → write results in the
same per-test JSON shape used today (see METHODOLOGY's *Results Storage*).

## Open questions

1. **Metric source.** This sketch captures metrics locally via `onEvent`. The
   alternative is reading them back from the platform query API
   (`createBenchQueryClient`, as the scale module does). Local capture is simpler and
   removes a network dependency from scoring; the query API is the right choice if we
   want scoring to run against *already-ingested* historical data. Pick one.
2. **Built-in step metrics.** Deriving `<step>_ms` requires the `bench` result to expose
   per-step per-unit timing (the README shows per-task aggregate stats). Confirm the
   result shape carries what we need, or have the harness time steps itself.
3. **Result schema versioning.** Community workloads emit arbitrary metric sets, so the
   stored JSON schema needs a per-workload `metrics` section. Extend the existing schema
   (METHODOLOGY *JSON Schema*) rather than forking it.
4. **Migration.** Whether to port the grandfathered sandbox/browser/storage tests onto
   this harness later, or leave them as-is. (Currently grandfathered.)
