import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ParticipantRecords } from '@benchsdk/runner';
import type { TaskResultRecord } from '@benchsdk/client';
import { byTaskIndex } from '../src/util/records.js';
import { computeStats } from '../src/util/stats.js';
import { browserRecordEvidence } from './browsers-record-evidence.js';
import { scoreBrowserRecords } from './browsers-runtime-scoring.js';

interface Options {
  /** Absolute path to results/browser_protected_sites/ */
  resultsDir: string;
}

/**
 * Map per-participant task records to legacy result rows and write both
 * `<YYYY-MM-DD>.json` and `latest.json` into resultsDir.
 * TEMPORARY BRIDGE until the platform read API exposes per-iteration data.
 *
 * Each record is one site visit (phases are sites; data.phase = site slug).
 * `sites` rolls records up per site with the classified outcomes; `summary`
 * carries the provider-level pass rate and time-to-pass stats that the merge
 * and summary scripts rank on.
 */
export function writeProtectedSitesLegacyResults(
  participants: ParticipantRecords[],
  opts: Options,
): void {
  const results = participants.map((participant) => {
    const records = byTaskIndex(participant.records);

    const sites: Record<string, {
      outcome: string[];
      passed: number;
      iterations: number;
      captchaEncountered: number;
      captchaSolved: number;
    }> = {};
    const passTimes: number[] = [];
    const solveTimes: number[] = [];
    let passed = 0;

    for (const r of records) {
      const data = (r.data ?? {}) as Record<string, any>;
      const site = typeof data.site === 'string' ? data.site : (data.phase ?? 'unknown');
      const entry = (sites[site] ??= {
        outcome: [],
        passed: 0,
        iterations: 0,
        captchaEncountered: 0,
        captchaSolved: 0,
      });
      entry.iterations += 1;
      entry.outcome.push(String(data.outcome ?? 'timeout'));
      if (data.passed === 1) {
        entry.passed += 1;
        passed += 1;
        if (Number.isFinite(data.timeToPassMs) && data.timeToPassMs > 0) {
          passTimes.push(data.timeToPassMs);
        }
      }
      if (data.captchaEncountered === 1) entry.captchaEncountered += 1;
      if (data.captchaSolved === 1) {
        entry.captchaSolved += 1;
        if (Number.isFinite(data.captchaSolveMs) && data.captchaSolveMs > 0) {
          solveTimes.push(data.captchaSolveMs);
        }
      }
    }

    const summary: Record<string, unknown> = {};
    if (passTimes.length) summary.timeToPassMs = computeStats(passTimes);
    if (solveTimes.length) summary.captchaSolveMs = computeStats(solveTimes);

    const successRate = records.length ? passed / records.length : 0;
    return {
      provider: participant.participant,
      compositeScore: scoreBrowserRecords('protected', records),
      iterations: records.map((r: TaskResultRecord) => r.data),
      records: browserRecordEvidence(records),
      sites,
      summary,
      passRate: successRate,
      successRate,
    };
  });

  mkdirSync(opts.resultsDir, { recursive: true });
  const out = {
    version: '1.0',
    timestamp: new Date().toISOString(),
    environment: { node: process.version, platform: os.platform(), arch: os.arch() },
    results,
  };
  const datePath = path.join(opts.resultsDir, `${out.timestamp.slice(0, 10)}.json`);
  writeFileSync(datePath, JSON.stringify(out, null, 2));
  copyFileSync(datePath, path.join(opts.resultsDir, 'latest.json'));
}
