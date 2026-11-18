import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ParticipantRecords } from '@benchsdk/runner';
import type { TaskResultRecord } from '@benchsdk/client';
import { byTaskIndex } from '../src/util/records.js';
import { computeStats } from '../src/util/stats.js';
import { browserRecordEvidence } from './browsers-record-evidence.js';
import { scoreBrowserRecords } from './browsers-runtime-scoring.js';

interface Options {
  /** Absolute path to results/browser_session_persistence/ */
  resultsDir: string;
  /** measure() keys to summarize with median/p95/p99. */
  metricKeys: string[];
}

interface SessionPersistenceData {
  resumeSupported?: number;
  resumeMechanism?: string;
  reconnectMs?: number;
  totalMs?: number;
  cookiesPreserved?: number;
  storagePreserved?: number;
  tabsPreserved?: number;
}

/**
 * Local composite for the committed result files, mirroring the bench scoring
 * manifest: resume capability gates everything (a provider that cannot
 * reconnect scores 0), then reconnect speed plus the preservation flags.
 */
export function scoreSessionPersistenceRecords(records: TaskResultRecord[]): number {
  return scoreBrowserRecords('session', records);
}

/**
 * Map per-participant task records to legacy result rows and write both
 * `<YYYY-MM-DD>.json` and `latest.json` into resultsDir.
 * TEMPORARY BRIDGE until the platform read API exposes per-iteration data.
 */
export function writeSessionPersistenceLegacyResults(
  participants: ParticipantRecords[],
  opts: Options,
): void {
  const results = participants.map((participant) => {
    const records = byTaskIndex(participant.records);
    const summary: Record<string, unknown> = {};
    for (const key of opts.metricKeys) {
      const values = records
        .map((r: TaskResultRecord) => Number((r.data as SessionPersistenceData | undefined)?.[key as keyof SessionPersistenceData]))
        .filter((v) => Number.isFinite(v) && v > 0);
      if (values.length) summary[key] = computeStats(values);
    }
    const succeeded = records.filter((r) => r.status === 'success').length;
    const resumeRate = records.length
      ? records.filter((r) => (r.data as SessionPersistenceData | undefined)?.resumeSupported === 1).length /
        records.length
      : 0;
    const mechanism = (records[0]?.data as SessionPersistenceData | undefined)?.resumeMechanism;
    return {
      provider: participant.participant,
      ...(mechanism ? { mechanism } : {}),
      iterations: records.map((r) => r.data),
      records: browserRecordEvidence(records),
      summary,
      compositeScore: scoreSessionPersistenceRecords(records),
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
