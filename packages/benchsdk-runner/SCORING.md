# Version-separated scoring

Unversioned specs keep the existing linear curves, completed-task sample
population and two-decimal composite rounding. No benchmark opts in here.

An explicit `version: 2` and nonempty `methodology` identifier opt into:

```ts
{ version: 2, methodology: 'my-calibration-1', metrics: [{
  key: 'durationMs', ceiling: 1000,
  transform: { kind: 'reciprocal', reference: 1000 },
  weights: { median: 0.6, p95: 0.25, p99: 0.15 }
}] }
```

Lower utility is `100/(1+x/reference)`; higher utility is
`x === 0 ? 0 : 100/(1+reference/x)`. Reference is a fixed half-score point,
not a timeout or competitor-relative baseline. Omitting transform retains a
linear metric (useful for capability percentages). References and weights
are methodology decisions; this mechanism does not calibrate them.

v2 uses status + success-gate passing records only. Trim raw observations,
compute arithmetic median and nearest-rank upper p95/p99, then transform.
Weights are never redistributed. Any missing, negative or nonfinite required
sample makes a passing participant's composite null. No records is null;
observed all-failed/unsupported outcomes are zero; measured zero is valid.
Unweighted diagnostics do not require measurements. Composite precision is
retained and `scoringVersion` identifies methodology. Equal evidence can tie;
small numerical gaps are not statistical confidence.

Unknown versions/transforms fail closed. Keep the numerical contract identical
to benchmarks-platform. Platform must deploy compatible ingestion before an
opt-in client runs; release packages normally before dependency adoption.
Never apply new specs to historical runs, backfill, or mix calibration versions
in a weekly comparison. Exports must understand the same sample gates or refuse
v2. Browser means/per-metric predicates and custom domain curves are deliberately
not added: those require separate methodology/API review.

Verification is offline synthetic fixtures, not a real-provider ranking claim.
No release or benchmark workload is performed by this change.
