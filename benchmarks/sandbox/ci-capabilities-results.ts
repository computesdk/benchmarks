import { mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ParticipantRecords, ResolvedRunConfig } from '@benchsdk/runner';
import type { TaskResultRecord } from '@benchsdk/client';
import type { ProviderCapabilityMatrix, CapabilityMatrixResult } from './types.js';

const RESULTS_VERSION = '1.0';

/**
 * Prefer the task-level `features` matrix the capability task returns in
 * `record.data`. As a fallback, reconstruct from per-step measurements when a
 * step failed and the matrix wasn't emitted.
 */
function extractMatrix(record: TaskResultRecord): ProviderCapabilityMatrix {
  const data = record.data ?? {};
  if (data && typeof data === 'object' && 'features' in data && data.features && typeof data.features === 'object' && !Array.isArray(data.features)) {
    return data.features as unknown as ProviderCapabilityMatrix;
  }

  const matrix: ProviderCapabilityMatrix = {};
  for (const step of record.steps ?? []) {
    const stepData = step.data ?? {};
    if (stepData && typeof stepData === 'object' && 'passed' in stepData) {
      const { passed, error } = stepData as { passed: boolean; error?: string };
      matrix[step.name] = passed ? { passed: true } : { passed: false, ...(error ? { error } : {}) };
    }
  }
  return matrix;
}

/** Aggregate per-provider capability matrices and write dated + latest JSON. */
export async function writeCiCapabilitiesResults(
  participants: ParticipantRecords[],
  opts: { resultsDir: string; runConfig: ResolvedRunConfig },
): Promise<void> {
  const results: CapabilityMatrixResult[] = participants.map((participant) => {
    const record = participant.records[0];
    const features = record ? extractMatrix(record) : {};
    return { provider: participant.participant, features };
  });

  mkdirSync(opts.resultsDir, { recursive: true });

  const timestamp = new Date().toISOString();
  const outPath = path.join(opts.resultsDir, `${timestamp.slice(0, 10)}.json`);
  const latestPath = path.join(opts.resultsDir, 'latest.json');

  const output = {
    version: RESULTS_VERSION,
    timestamp,
    environment: {
      node: process.version,
      platform: os.platform(),
      arch: os.arch(),
    },
    config: {
      benchmarkSlug: 'sandbox-ci-capabilities',
      iterations: opts.runConfig.iterations,
      concurrency: opts.runConfig.concurrency,
    },
    results,
  };

  writeFileSync(outPath, JSON.stringify(output, null, 2));
  copyFileSync(outPath, latestPath);
  console.log(`CI capabilities results written: ${outPath} -> ${latestPath}`);
}
