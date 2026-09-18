import { mkdirSync, copyFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ParticipantRecords } from '@benchsdk/runner';
import type { JsonObject, TaskResultRecord } from '@benchsdk/api';
import type { PricingBenchmarkResult } from './pricing.js';

const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

function recordToPricingResult(r: TaskResultRecord, provider: string, url: string): PricingBenchmarkResult {
  const d = (r.data ?? {}) as JsonObject;
  const rates =
    d.rates && typeof d.rates === 'object' && !Array.isArray(d.rates)
      ? (d.rates as Record<string, number>)
      : {};
  const result: PricingBenchmarkResult = {
    provider,
    url: str(d.url) ?? url,
    hourlyRate: num(d.hourlyRate) ?? null,
    rates,
    fieldsMatched: num(d.fieldsMatched) ?? 0,
    fieldsTotal: num(d.fieldsTotal) ?? 0,
  };
  const fee = num(d.perSandboxFee);
  if (fee !== undefined && fee > 0) result.perSandboxFee = fee;
  const httpStatus = num(d.httpStatus);
  if (httpStatus !== undefined) result.httpStatus = httpStatus;
  const error = str(d.error) ?? (r.status === 'error' ? r.errorCode ?? 'error' : undefined);
  if (error) result.error = error;
  return result;
}

/**
 * Map records -> PricingBenchmarkResult[] and write `<YYYY-MM-DD>.json` and
 * `latest.json` into resultsDir, matching the results/<benchmark>/ shape that
 * dotcom reads off raw.githubusercontent.com.
 * TEMPORARY BRIDGE until the platform read API exposes record data.
 */
export async function writePricingLegacyResults(
  participants: ParticipantRecords[],
  opts: { resultsDir: string },
): Promise<void> {
  const results: PricingBenchmarkResult[] = participants.map((participant) =>
    recordToPricingResult(participant.records[0], participant.participant, ''),
  );

  mkdirSync(opts.resultsDir, { recursive: true });

  const timestamp = new Date().toISOString().slice(0, 10);
  const outPath = path.join(opts.resultsDir, `${timestamp}.json`);
  writeFileSync(
    outPath,
    JSON.stringify({ timestamp: new Date().toISOString(), spec: '8 vCPU / 16 GiB', results }, null, 2) + '\n',
  );

  const latestPath = path.join(opts.resultsDir, 'latest.json');
  copyFileSync(outPath, latestPath);
  console.log(`Copied latest: ${latestPath}`);
}
