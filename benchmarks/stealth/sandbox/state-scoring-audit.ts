/**
 * Read-only artifact analysis, not a benchmark/test runner. Reports aggregate
 * evidence only: no provider names, per-provider measurements or credentials.
 * Usage: pnpm exec tsx benchmarks/stealth/sandbox/state-scoring-audit.ts [results-root]
 *   [private-volume-task-json private-volume-run-json]
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  STATE_SCORING_CANDIDATES,
  evaluateStateCandidate,
  type StateBenchmarkId,
  type StateCandidateObservation,
} from './state-scoring-candidate.js';

const artifactDirs: Partial<Record<StateBenchmarkId, string>> = {
  'filesystem-snapshot-stealth': 'filesystem_snapshot',
  'sandbox-fidelity-stealth': 'sandbox_fidelity',
  'sandbox-pause-resume-stealth': 'sandbox_pause_resume',
  'sandbox-snapshot-fanout-stealth': 'sandbox_snapshot_fanout',
  'sandbox-snapshot-stealth': 'sandbox_snapshot',
};

type ArtifactRow = {
  compositeScore: number;
  successRate: number;
  iterations: { ok: boolean; meta: Record<string, unknown> }[];
};

function tiePairs(values: number[]): number {
  const groups = new Map<number, number>();
  for (const value of values) groups.set(value, (groups.get(value) ?? 0) + 1);
  return [...groups.values()].reduce((sum, n) => sum + n * (n - 1) / 2, 0);
}

const resultsRoot = path.resolve(process.argv[2] ?? 'results');
for (const [benchmarkId, dir] of Object.entries(artifactDirs)) {
  const artifact = JSON.parse(readFileSync(path.join(resultsRoot, dir!, 'latest.json'), 'utf8')) as {
    timestamp: string; results: ArtifactRow[];
  };
  const spec = STATE_SCORING_CANDIDATES[benchmarkId as StateBenchmarkId];
  const candidates = artifact.results.map((row) => evaluateStateCandidate(spec, row.iterations.map((i) => ({
    // Legacy wrappers expose ok, not the original task status. This is an
    // evidence limitation; do not present this analysis as canonical replay.
    status: i.ok ? 'success' as const : 'error' as const,
    data: i.meta,
  }))));
  const stored = artifact.results.map((row) => row.compositeScore);
  const complete = candidates.flatMap((row) => row.compositeScore === null ? [] : [row.compositeScore]);
  const positiveStored = stored.filter((score) => score > 0);
  const positiveCandidate = complete.filter((score) => score > 0);
  let positivePairOrderReversals = 0;
  let positiveComparablePairs = 0;
  for (let i = 0; i < stored.length; i++) {
    for (let j = i + 1; j < stored.length; j++) {
      const a = candidates[i].compositeScore;
      const b = candidates[j].compositeScore;
      if (stored[i] <= 0 || stored[j] <= 0 || a === null || b === null || a <= 0 || b <= 0) continue;
      positiveComparablePairs++;
      if ((stored[i] - stored[j]) * (a - b) < 0) positivePairOrderReversals++;
    }
  }
  console.log(JSON.stringify({
    benchmarkId,
    timestamp: artifact.timestamp,
    providers: stored.length,
    rawIterations: artifact.results.reduce((sum, row) => sum + row.iterations.length, 0),
    storedPositive: positiveStored.length,
    storedZero: stored.filter((score) => score === 0).length,
    storedTiedPairs: tiePairs(stored),
    storedPositiveTiedPairs: tiePairs(positiveStored),
    candidateScored: candidates.filter((row) => row.outcome === 'scored').length,
    candidateZero: complete.filter((score) => score === 0).length,
    candidateMissing: candidates.filter((row) => row.outcome === 'missing').length,
    candidateIncomplete: candidates.filter((row) => row.outcome === 'incomplete').length,
    candidatePositiveTiedPairs: tiePairs(positiveCandidate),
    candidatePositiveTiedPairsAtTwoDecimals: tiePairs(positiveCandidate.map((score) => Math.round(score * 100) / 100)),
    previouslyZeroPassingNowPositive: artifact.results.filter((row, i) =>
      row.compositeScore === 0 && row.successRate > 0 && (candidates[i].compositeScore ?? 0) > 0,
    ).length,
    positivePairOrderReversals,
    positiveComparablePairs,
  }));
}
const [volumeTasksFile, volumeRunFile] = process.argv.slice(3);
if (Boolean(volumeTasksFile) !== Boolean(volumeRunFile)) throw new Error('provide both volume task and run JSON files');
if (volumeTasksFile && volumeRunFile) {
  const taskSource = JSON.parse(readFileSync(volumeTasksFile, 'utf8')) as {
    tasks: { participantSlug: string; status: 'success' | 'error'; data: Record<string, unknown> }[];
  };
  const runSource = JSON.parse(readFileSync(volumeRunFile, 'utf8')) as {
    id: string; createdAt: string; status: string;
    summary: { results: { provider: string; compositeScore: number }[] };
  };
  const spec = STATE_SCORING_CANDIDATES['sandbox-volumes-stealth'];
  // Explicit lossy projection for historical sensitivity analysis. This does
  // NOT recover or relabel rounded observations as new full-precision data.
  const roundedProjection = { ...spec, metrics: spec.metrics.map((m) => ({ ...m, key: m.key.replace('Raw', '') })) };
  const byParticipant = new Map<string, StateCandidateObservation[]>();
  for (const row of taskSource.tasks) {
    if (row.status !== 'success' && row.status !== 'error') throw new Error('unrecognized volume task status');
    byParticipant.set(row.participantSlug, [...(byParticipant.get(row.participantSlug) ?? []), { status: row.status, data: row.data }]);
  }
  const projected = runSource.summary.results.map((row) => evaluateStateCandidate(roundedProjection, byParticipant.get(row.provider) ?? []));
  const fullPrecision = runSource.summary.results.map((row) => evaluateStateCandidate(spec, byParticipant.get(row.provider) ?? []));
  const verified = taskSource.tasks.filter((r) => r.status === 'success' && r.data.verifyPassed === 1);
  const storedPositive = runSource.summary.results.map((r) => r.compositeScore).filter((score) => score > 0);
  const projectedPositive = projected.flatMap((r) => r.compositeScore !== null && r.compositeScore > 0 ? [r.compositeScore] : []);
  const throughput = spec.metrics.filter((m) => m.higherIsBetter);
  const invalidVerifiedThroughputObservations = throughput.reduce((sum, m) => sum + verified.filter((r) => {
    const value = r.data[m.key.replace('Raw', '')];
    return typeof value !== 'number' || !Number.isFinite(value) || value < 0;
  }).length, 0);
  console.log(JSON.stringify({
    benchmarkId: 'sandbox-volumes-stealth',
    runId: runSource.id,
    timestamp: runSource.createdAt,
    runStatus: runSource.status,
    providers: runSource.summary.results.length,
    tasks: taskSource.tasks.length,
    successfulTasks: taskSource.tasks.filter((r) => r.status === 'success').length,
    verifiedTasks: verified.length,
    storedPositive: storedPositive.length,
    storedPositiveTiedPairs: tiePairs(storedPositive),
    roundedProjectionPositive: projectedPositive.length,
    roundedProjectionPositiveTiedPairs: tiePairs(projectedPositive),
    roundedProjectionIncomplete: projected.filter((r) => r.outcome === 'incomplete').length,
    fullPrecisionIncomplete: fullPrecision.filter((r) => r.outcome === 'incomplete').length,
    invalidVerifiedThroughputObservations,
    upperCappedThroughputObservations: throughput.reduce((sum, m) =>
      sum + verified.filter((r) => {
        const value = r.data[m.key.replace('Raw', '')];
        return typeof value === 'number' && Number.isFinite(value) && value >= m.reference;
      }).length, 0),
    evidence: 'Rounded historical projection only; full-precision companion values were not collected.',
  }));
} else {
  console.log(JSON.stringify({ benchmarkId: 'sandbox-volumes-stealth', evidence: 'No checked-in result artifact. Optional private task/run JSON enables explicitly rounded historical projection.' }));
}
