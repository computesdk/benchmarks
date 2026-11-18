import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BenchmarkRunOutcome } from '@benchsdk/runner';
import { HEADLINE_CELL } from './storage-range-reads.js';

export const STORAGE_RANGE_READS_RESULTS_DIR = path.resolve('results/storage_range_reads');

function isCell(value: unknown): value is Record<string, unknown> & { cell: string } {
  return typeof value === 'object' && value !== null && typeof (value as { cell?: unknown }).cell === 'string';
}

/**
 * Writes one `results/storage_range_reads/<provider>.json` per participant in
 * the shape the generic `benchmarks/stealth/src/merge-results.ts` merges into
 * `latest.json`. Failed cells are kept (their data carries the reason).
 */
export function writeStorageRangeReadsResults(outcome: BenchmarkRunOutcome): void {
  fs.mkdirSync(STORAGE_RANGE_READS_RESULTS_DIR, { recursive: true });
  for (const participant of outcome.participants) {
    const cells = participant.records.flatMap((record) => (isCell(record.data) ? [record.data] : []));
    const headline = cells.find((cell) => cell.cell === HEADLINE_CELL);
    const validCells = cells.filter((cell) => cell.valid === true).length;
    const output = {
      version: '1.0',
      timestamp: new Date().toISOString(),
      runId: outcome.runId,
      environment: { node: process.version, platform: os.platform(), arch: os.arch() },
      results: [{
        provider: participant.participant,
        headlineP50Ms: headline?.valid === true ? headline.p50Ms : null,
        rangeMode: headline?.rangeMode ?? cells[0]?.rangeMode ?? null,
        successRate: cells.length > 0 ? validCells / cells.length : 0,
        cells,
      }],
    };
    const file = path.join(STORAGE_RANGE_READS_RESULTS_DIR, `${participant.participant}.json`);
    fs.writeFileSync(file, `${JSON.stringify(output, null, 2)}\n`);
    console.log(`Storage range-reads results written to ${file}`);
  }
}
