import { copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { BenchmarkScoringConfig, ParticipantRecords } from '@benchsdk/runner';
import { recordsToSuiteResults, writeSuiteResultsJson } from '../src/util/suite.js';
import { SOAK_SUITE } from './sandbox-soak.js';
import { soakLegacyScore } from './scoring-capabilities.js';

/**
 * Bridge runner records -> results/sandbox_soak/<date>.json + latest.json.
 *
 * The generic suite scoring is lower-is-better and cannot express the soak's
 * percentages, so compositeScore is patched per provider after the
 * record->result mapping. Compute per-iteration medians and the measured
 * success rate, matching the runner/platform rather than taking the last
 * passing record's percentages when an iteration fails.
 */
export async function writeSoakLegacyResults(
  participants: ParticipantRecords[],
  opts: { resultsDir: string; scoring?: BenchmarkScoringConfig },
): Promise<void> {
  const results = recordsToSuiteResults(SOAK_SUITE, participants, opts.scoring);

  for (const [index, r] of results.entries()) {
    if (!opts.scoring) r.compositeScore = soakLegacyScore(participants[index].records);
    r.tier = r.iterations.some((i) => i.ok) ? 'pass' : 'fail';
  }

  mkdirSync(opts.resultsDir, { recursive: true });
  const timestamp = new Date().toISOString().slice(0, 10);
  const outPath = path.join(opts.resultsDir, `${timestamp}.json`);
  await writeSuiteResultsJson(SOAK_SUITE, results, outPath, opts.scoring !== undefined);
  copyFileSync(outPath, path.join(opts.resultsDir, 'latest.json'));
}
