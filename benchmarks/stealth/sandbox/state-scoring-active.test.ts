import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { scoringConfigToSpec, type BenchmarkScoringConfig, type ParticipantRecords } from '@benchsdk/runner';
import { assertContinuousRunner, scoreParticipantRecords, type ContinuousScoringConfig } from '../src/util/scoring.js';
import { config as filesystem } from './filesystem-snapshot.bench.js';
import { config as fidelity } from './sandbox-fidelity.bench.js';
import { config as pause } from './sandbox-pause-resume.bench.js';
import { config as fanout } from './sandbox-snapshot-fanout.bench.js';
import { config as snapshot } from './sandbox-snapshot.bench.js';
import { config as volumes } from './volumes.bench.js';
import { config as burst } from './sandbox-burst-survival.bench.js';
import { config as soak } from './sandbox-soak.bench.js';
import { config as weekly } from '../composite/provider-weekly-composite.bench.js';
import { writeFilesystemSnapshotLegacyResults } from './filesystem-snapshot-legacy-results.js';
import { writeFidelityLegacyResults } from './sandbox-fidelity.js';
import { writePauseResumeLegacyResults } from './sandbox-pause-resume.js';
import { writeSnapshotFanoutLegacyResults } from './sandbox-snapshot-fanout.js';
import { writeSnapshotLegacyResults } from './sandbox-snapshot.js';
import { writeBurstSurvivalLegacyResults } from './sandbox-burst-survival-legacy-results.js';
import { writeSoakLegacyResults } from './sandbox-soak-legacy-results.js';

assertContinuousRunner();
const platform = process.env.BENCHSDK_PLATFORM_SCORING_ENTRYPOINT
  ? await import(pathToFileURL(process.env.BENCHSDK_PLATFORM_SCORING_ENTRYPOINT).href)
  : undefined;
const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);
function records(config: BenchmarkScoringConfig, multipliers = [0.123456789]): ParticipantRecords[] {
  return [{
    participant: 'fixture',
    records: multipliers.map((multiplier, taskIndex) => ({
      taskIndex,
      status: 'success' as const,
      latencyMs: 123,
      data: {
        provider: 'fixture', wallClockMs: 123, snapshotSupported: true, filesystemSupported: true,
        pauseSupported: true, resumeSupported: true, allVerified: true, verifyPassed: true,
        ...config.success?.requireData,
        ...Object.fromEntries(config.metrics.map((metric) => [metric.key, metric.ceiling * multiplier])),
      },
    })) as ParticipantRecords['records'],
  }];
}
const score = (participants: ParticipantRecords[], config: BenchmarkScoringConfig) => {
  const result = scoreParticipantRecords(participants, config)[0];
  if (platform) {
    const parsed = platform.parseBenchmarkScoringSpec(JSON.parse(JSON.stringify(config)));
    assert.ok(parsed, 'platform must retain the actual active config');
    const metrics = Object.fromEntries(result.metrics.map((metric) => [metric.name, metric]));
    assert.equal(platform.computeCompositeScore(metrics, result.successRate, parsed), result.compositeScore);
  }
  return result;
};
const configurations = [filesystem, fidelity, pause, fanout, snapshot, volumes];
for (const { benchmarkSlug, scoring } of configurations) {
  assert.ok(scoring, benchmarkSlug);
  const config = scoring as ContinuousScoringConfig;
  assert.equal(config.precision, 'full', benchmarkSlug);
  close(config.metrics.reduce((sum, metric) => sum + Object.values(metric.weights).reduce((a, b) => a + b, 0), 0), 1);
  for (const metric of config.metrics) {
    assert.deepEqual(metric.transform, { kind: 'reciprocal', reference: metric.ceiling });
  }
  const serialized = JSON.parse(JSON.stringify(scoringConfigToSpec(config)));
  assert.equal(serialized.precision, 'full');
  assert.ok(serialized.metrics.every((metric: any) => metric.transform?.kind === 'reciprocal'));
  const original = records(config);
  const value = score(original, config).compositeScore;
  assert.notEqual(value, Math.round(value * 100) / 100, benchmarkSlug);
  const nearby = records(config, [0.123456788]);
  assert.notEqual(score(nearby, config).compositeScore, value, benchmarkSlug);
  const failure = { ...original[0].records[0], taskIndex: 1, status: 'error' as const };
  close(score([{ participant: 'fixture', records: [original[0].records[0], failure] }], config).compositeScore, value / 2);
  assert.equal(score([{ participant: 'fixture', records: [failure] }], config).compositeScore, 0);
  const rejected = records(config);
  const gate = Object.keys(config.success!.requireData!)[0];
  (rejected[0].records[0].data as any)[gate] = false;
  assert.equal(score(rejected, config).compositeScore, 0, `${benchmarkSlug} correctness gate`);
  const zero = score(records(config, [0]), config).compositeScore;
  const expectedZero = config.metrics.reduce((sum, metric) => sum + (metric.higherIsBetter ? 0 : 100 * Object.values(metric.weights).reduce((a, b) => a + b, 0)), 0);
  close(zero, expectedZero);
  const invalid = records(config);
  (invalid[0].records[0].data as any)[config.metrics[0].key] = -1;
  assert.throws(() => score(invalid, config), /statistic/);
  const even = score(records(config, [0.5, 2]), config);
  const expected = config.metrics.reduce((sum, metric) => sum + Object.entries(metric.weights).reduce((part, [statistic, weight]) => {
    const raw = statistic === 'median' ? 1.25 : 2;
    return part + weight * (metric.higherIsBetter ? 100 / (1 + 1 / raw) : 100 / (1 + raw));
  }, 0), 0);
  close(even.compositeScore, expected);
  console.log(`${benchmarkSlug}: active config, precision, gates, failures, zero, percentiles passed`);
}

const directory = mkdtempSync(path.join(tmpdir(), 'state-scoring-active-'));
try {
  const writers = [
    [filesystem, writeFilesystemSnapshotLegacyResults], [fidelity, writeFidelityLegacyResults],
    [pause, writePauseResumeLegacyResults], [fanout, writeSnapshotFanoutLegacyResults],
    [snapshot, writeSnapshotLegacyResults], [burst, writeBurstSurvivalLegacyResults], [soak, writeSoakLegacyResults],
  ] as const;
  for (const [config, write] of writers) {
    const scoring = config.scoring!;
    const participants = records(scoring);
    const expected = score(participants, scoring);
    const resultsDir = path.join(directory, config.benchmarkSlug);
    await write(participants, { resultsDir, scoring });
    const row = JSON.parse(readFileSync(path.join(resultsDir, 'latest.json'), 'utf8')).results[0];
    assert.equal(row.compositeScore, expected.compositeScore, config.benchmarkSlug);
    assert.equal(row.successRate, expected.successRate, config.benchmarkSlug);
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}
const burstConfig = burst.scoring as ContinuousScoringConfig;
assert.equal(burstConfig.metrics.find((metric) => metric.key === 'alivePct')!.transform, undefined);
assert.equal(burstConfig.metrics.find((metric) => metric.key === 'alivePct')!.weights.median, 0.85);
assert.ok(burstConfig.metrics.filter((metric) => metric.key !== 'alivePct').every((metric) => metric.transform?.kind === 'reciprocal'));
for (const metric of (soak.scoring as ContinuousScoringConfig).metrics) assert.equal(metric.transform, undefined);
const weeklyRecords = records(weekly.scoring!);
weeklyRecords[0].records[0].data!.weeklyComposite = 54.123456789;
close(score(weeklyRecords, weekly.scoring!).compositeScore, 54.123456789);
assert.equal((weekly.scoring as ContinuousScoringConfig).precision, 'full');
console.log('State/Burst/Soak legacy exporters match actual runner scores; weekly precision passed');
