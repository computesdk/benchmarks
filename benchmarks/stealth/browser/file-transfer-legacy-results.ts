import { mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ParticipantRecords, ResolvedRunConfig } from '@benchsdk/runner';
import { scoreBrowserRecords } from './browsers-runtime-scoring.js';

const RESULTS_VERSION = '1.0';

/**
 * Flat latest.json writer for browser-file-transfer: one record per provider
 * per round (groupBy: 'round' produces a record per iteration). Writes both a
 * dated file and latest.json under results/browser_file_transfer/ so the
 * collect job can merge artifacts across the provider matrix.
 */
export async function writeFileTransferResults(
  participants: ParticipantRecords[],
  opts: { resultsDir: string; runConfig: ResolvedRunConfig; benchmarkSlug?: string },
): Promise<void> {
  const benchmarkSlug = opts.benchmarkSlug ?? 'browser-file-transfer';
  const results = participants.map((participant) => {
    const records = participant.records ?? [];
    // Failed records carry no data; a provider with no scored record scores 0.
    return {
      provider: participant.participant,
      compositeScore: scoreBrowserRecords('transfer', records),
      records: records.map((r) => ({ data: r.data, latencyMs: r.latencyMs, status: r.status, errorCode: r.errorCode })),
      summary: summarize(records),
    };
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
      benchmarkSlug,
      iterations: opts.runConfig.iterations,
      concurrency: opts.runConfig.concurrency,
    },
    results,
  };

  writeFileSync(outPath, JSON.stringify(output, null, 2));
  copyFileSync(outPath, latestPath);
  console.log(`${benchmarkSlug} results written: ${outPath} -> ${latestPath}`);
}

function summarize(records: ParticipantRecords['records']) {
  const nums = (key: string) =>
    records
      .map((r) => r.data?.[key])
      .filter((v): v is number => typeof v === 'number')
      .sort((a, b) => a - b);
  const median = (key: string) => {
    const xs = nums(key);
    return xs.length ? xs[Math.floor(xs.length / 2)] : undefined;
  };
  return {
    rounds: records.length,
    downloadSupported: median('downloadSupported'),
    downloadMs: { median: median('downloadMs') },
    downloadMatch: median('downloadMatch'),
    uploadSupported: median('uploadSupported'),
    uploadMs: { median: median('uploadMs') },
    uploadMatch: median('uploadMatch'),
    totalMs: { median: median('totalMs') },
  };
}
