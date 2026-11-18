import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ParticipantRecords } from '@benchsdk/runner';
import type { TaskResultRecord } from '@benchsdk/client';
import { byTaskIndex } from '../src/util/records.js';
import { computeStats } from '../src/util/stats.js';
import { browserRecordEvidence } from './browsers-record-evidence.js';
import { scoreBrowserRecords } from './browsers-runtime-scoring.js';

interface Options {
  /** Absolute path to results/browser_idle_resume/ */
  resultsDir: string;
  /** measure() keys to summarize with median/p95/p99. */
  metricKeys: string[];
}

interface IdleResumeData {
  resumeSupported?: number;
  resumeMechanism?: string;
  reconnectMs?: number;
  totalMs?: number;
  cookiesPreserved?: number;
  storagePreserved?: number;
  tabsPreserved?: number;
  resume10s?: number;
  resume30s?: number;
  resume60s?: number;
  resume300s?: number;
}

/**
 * Local composite for the committed result files, mirroring the bench scoring
 * manifest: each gap's pass flag contributes its weight (a pass requires the
 * resume AND all seeded state), and reconnectMs is scored only over the
 * phases the provider actually resumed. There is no success.requireData
 * gate on the platform side either — a provider that never resumes scores 0
 * because every pass flag is 0 and it emits no reconnectMs samples; genuine
 * task failures still scale the composite via successRate.
 */
export function scoreIdleResumeRecords(records: TaskResultRecord[]): number {
  return scoreBrowserRecords('idle', records);
}

/**
 * Map per-participant task records to legacy result rows and write both
 * `<YYYY-MM-DD>.json` and `latest.json` into resultsDir.
 * TEMPORARY BRIDGE until the platform read API exposes per-iteration data.
 */
export function writeIdleResumeLegacyResults(
  participants: ParticipantRecords[],
  opts: Options,
): void {
  const results = participants.map((participant) => {
    const records = byTaskIndex(participant.records);
    const summary: Record<string, unknown> = {};
    for (const key of opts.metricKeys) {
      const values = records
        .map((r: TaskResultRecord) => Number((r.data as IdleResumeData | undefined)?.[key as keyof IdleResumeData]))
        .filter((v) => Number.isFinite(v) && v > 0);
      if (values.length) summary[key] = computeStats(values);
    }
    const succeeded = records.filter((r) => r.status === 'success').length;
    const resumeRate = records.length
      ? records.filter((r) => (r.data as IdleResumeData | undefined)?.resumeSupported === 1).length /
        records.length
      : 0;
    return {
      provider: participant.participant,
      iterations: records.map((r) => r.data),
      records: browserRecordEvidence(records),
      summary,
      compositeScore: scoreIdleResumeRecords(records),
      successRate: records.length ? succeeded / records.length : 0,
      resumeRate,
    };
  });

  mkdirSync(opts.resultsDir, { recursive: true });
  const out = {
    version: '1.0',
    timestamp: new Date().toISOString(),
    results,
  };
  const datePath = path.join(opts.resultsDir, `${out.timestamp.slice(0, 10)}.json`);
  writeFileSync(datePath, JSON.stringify(out, null, 2));
  copyFileSync(datePath, path.join(opts.resultsDir, 'latest.json'));
}
