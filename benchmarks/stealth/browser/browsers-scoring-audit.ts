/**
 * Read-only aggregate comparison of local diagnostic evidence. Never
 * emits provider identities, raw task data, logs or session/upgrade fields.
 *
 * pnpm exec tsx benchmarks/stealth/browser/browsers-scoring-audit.ts
 *
 * Status-less iterations are reported as insufficient, never guessed into
 * successful observations. This does not rewrite results or call a provider.
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeStats } from '../src/util/stats.js';
import { scoreFileTransferCandidate, type BrowserObservation } from './browsers-scoring-v2.js';

interface ArtifactRow {
  compositeScore?: number;
  records?: BrowserObservation[];
  iterations?: Record<string, unknown>[];
  passRate?: number;
}

function tiePairs(values: number[]): number {
  return values.reduce((count, value, index) => count + values.slice(index + 1).filter((other) => other === value).length, 0);
}

const resultsRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../results');
for (const slug of ['browser_file_transfer', 'browser_idle_resume', 'browser_session_persistence', 'browser_protected_sites']) {
  const artifact = path.join(resultsRoot, slug, 'latest.json');
  if (!existsSync(artifact)) {
    console.log(JSON.stringify({ benchmark: slug, status: 'no-local-artifact' }));
    continue;
  }
  const input = JSON.parse(readFileSync(artifact, 'utf8')) as { timestamp?: string; results: ArtifactRow[] };
  const rows = input.results;
  const report: Record<string, unknown> = {
    benchmark: slug,
    timestamp: input.timestamp,
    providers: rows.length,
    records: rows.reduce((sum, row) => sum + (row.records?.length ?? row.iterations?.length ?? 0), 0),
    hasTaskStatus: rows.every((row) => row.records?.every((record) => record.status === 'success' || record.status === 'error')),
  };
  if (slug === 'browser_file_transfer' && report.hasTaskStatus === true) {
    const eligible = rows.filter((row) => row.records!.length > 0);
    // Current manifest scores each task's already-rounded composite, then
    // multiplies by the status/benchCompleted success fraction. Stored legacy
    // provider scores use the first record, so compare both separately.
    const oldRunner = eligible.map((row) => {
      const measured = row.records!.filter((record) => record.status === 'success');
      const scores = measured.map((record) => record.data?.compositeScore)
        .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
      const success = measured.filter((record) => record.data?.benchCompleted === 1).length / row.records!.length;
      return scores.length ? Math.round(computeStats(scores).median * success * 100) / 100 : 0;
    });
    const candidate = eligible.map((row) => scoreFileTransferCandidate(row.records!).compositeScore)
      .filter((value): value is number => value !== null);
    const stored = eligible.map((row) => row.compositeScore).filter((value): value is number => typeof value === 'number');
    report.comparison = {
      eligibleProviders: eligible.length,
      candidateComparableProviders: candidate.length,
      candidateIncompleteProviders: eligible.length - candidate.length,
      oldRunnerUnique: new Set(oldRunner).size,
      oldRunnerTiePairs: tiePairs(oldRunner),
      candidateUniqueAtFullPrecision: new Set(candidate).size,
      candidateUniqueAtTwoDecimals: new Set(candidate.map((value) => Number(value.toFixed(2)))).size,
      candidateTiePairsAtFullPrecision: tiePairs(candidate),
      storedLegacyUnique: new Set(stored).size,
      storedLegacyTiePairs: tiePairs(stored),
      note: 'Same limited historical tasks, no new provider experiment; methodology is an inactive proposal.',
    };
  } else {
    report.comparison = 'Insufficient: iterations omit per-task status. No v2 score or provider rank reconstructed.';
    const stored = rows.map((row) => row.compositeScore).filter((value): value is number => typeof value === 'number');
    if (stored.length) report.storedLegacy = { scored: stored.length, unique: new Set(stored).size, tiePairs: tiePairs(stored) };
    const passRates = rows.map((row) => row.passRate).filter((value): value is number => typeof value === 'number');
    if (passRates.length) report.storedCapability = { scored: passRates.length, unique: new Set(passRates).size, tiePairs: tiePairs(passRates) };
  }
  console.log(JSON.stringify(report));
}
console.log(JSON.stringify({ benchmark: 'browser_concurrency', status: 'No checked-in raw artifact; no measured tie/rank comparison.' }));
