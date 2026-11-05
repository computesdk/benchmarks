import { mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ParticipantRecords, ResolvedRunConfig } from '@benchsdk/runner';
import type { TaskResultRecord } from '@benchsdk/client';
import type { ProviderCapabilityMatrix, CapabilityMatrixResult, CapabilityFeatureResult } from './types.js';
import { byTaskIndex } from '../src/util/records.js';

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

/**
 * Combine per-iteration feature matrices into a single provider matrix.
 *
 * A feature passes only when *every* iteration reports it passed. The error
 * message comes from the first failing iteration, making the aggregate
 * deterministic regardless of completion order.
 */
function aggregateFeatureMatrices(matrices: ProviderCapabilityMatrix[]): ProviderCapabilityMatrix {
  const allKeys = new Set<string>();
  for (const matrix of matrices) {
    for (const key of Object.keys(matrix)) {
      allKeys.add(key);
    }
  }

  const aggregate: ProviderCapabilityMatrix = {};
  for (const key of allKeys) {
    const entries: (CapabilityFeatureResult | undefined)[] = matrices.map((matrix) => matrix[key]);
    const passed = entries.every((entry) => entry?.passed === true);
    const firstFailure = entries.find((entry) => entry && !entry.passed && entry.error);
    aggregate[key] = passed ? { passed: true } : { passed: false, ...(firstFailure?.error ? { error: firstFailure.error } : {}) };
  }
  return aggregate;
}

/** Aggregate per-provider capability matrices and write dated + latest JSON. */
export async function writeSandboxCapabilitiesResults(
  participants: ParticipantRecords[],
  opts: { resultsDir: string; runConfig: ResolvedRunConfig },
): Promise<void> {
  const results: CapabilityMatrixResult[] = participants.map((participant) => {
    const orderedRecords = byTaskIndex(participant.records);
    const matrices = orderedRecords.map(extractMatrix);
    const features = aggregateFeatureMatrices(matrices);
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
      benchmarkSlug: 'sandbox-capabilities',
      iterations: opts.runConfig.iterations,
      concurrency: opts.runConfig.concurrency,
    },
    results,
  };

  writeFileSync(outPath, JSON.stringify(output, null, 2));
  copyFileSync(outPath, latestPath);
  console.log(`Capabilities results written: ${outPath} -> ${latestPath}`);
}
