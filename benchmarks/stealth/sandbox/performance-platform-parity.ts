import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { score, scoringConfigToSpec, type BenchmarkRunOutcome, type BenchmarkScoringConfig } from '@benchsdk/runner';
import type { TaskResultRecord } from '@benchsdk/client';

/** Optional local verification against the real platform implementation. */
export async function assertPlatformParity(config: BenchmarkScoringConfig, records: TaskResultRecord[]): Promise<void> {
  const entrypoint = process.env.BENCHSDK_PLATFORM_SCORING_ENTRYPOINT;
  assert.ok(entrypoint, 'Provide the actual platform scoring.ts path');
  const platform = await import(pathToFileURL(entrypoint).href);
  const spec = platform.parseBenchmarkScoringSpec(JSON.parse(JSON.stringify(config)));
  assert.ok(spec, 'Actual serializable benchmark scoring config must parse');
  const outcome = { participants: [{ participant: 'fixture', records }] } as unknown as BenchmarkRunOutcome;
  for (const row of score(outcome, scoringConfigToSpec(config))) {
    const metrics = Object.fromEntries(row.metrics.map(({ name, ...stats }) => [name, stats]));
    assert.equal(platform.computeCompositeScore(metrics, row.successRate, spec), row.compositeScore,
      `Platform differs for ${JSON.stringify(row.dimensions)}`);
  }
}
