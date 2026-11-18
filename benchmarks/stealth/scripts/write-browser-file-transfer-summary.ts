#!/usr/bin/env tsx
/**
 * Write a GitHub Actions step summary for merged browser-file-transfer
 * results.
 *
 * Reads results/browser_file_transfer/latest.json and writes a markdown
 * table to GITHUB_STEP_SUMMARY (or stdout when not running in Actions).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');
const SUMMARY_FILE = process.env.GITHUB_STEP_SUMMARY;
const RESULTS_PATH = path.join(ROOT, 'results/browser_file_transfer/latest.json');

function write(text: string): void {
  if (SUMMARY_FILE) {
    fs.appendFileSync(SUMMARY_FILE, `${text}\n`);
  } else {
    console.log(text);
  }
}

function flag(v: number | undefined): string {
  return v === 1 ? '✅' : v === 0 ? '❌' : '—';
}

function ms(v: number | undefined): string {
  return typeof v === 'number' ? `${(v / 1000).toFixed(2)}s` : '—';
}

function medianOf(records: any[], key: string): number | undefined {
  const xs = records
    .map((r) => r?.data?.[key])
    .filter((v): v is number => typeof v === 'number')
    .sort((a, b) => a - b);
  return xs.length ? xs[Math.floor(xs.length / 2)] : undefined;
}

if (!fs.existsSync(RESULTS_PATH)) {
  write('## Browser File Transfer\n\nNo merged results found.');
  process.exit(0);
}

const merged = JSON.parse(fs.readFileSync(RESULTS_PATH, 'utf8'));
const results = (merged.results ?? []) as any[];

write('## Browser File Transfer');
write('');
write(
  [
    '| Provider | Composite | Download | Mechanism | Download ms | Bytes | Match | Upload | Upload ms | Match | Total |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...results
      .sort((a, b) => (b.compositeScore ?? -1) - (a.compositeScore ?? -1))
      .map((r) => {
        const records = r.records ?? [];
        const first = records[0]?.data ?? {};
        return [
          r.provider,
          r.compositeScore !== undefined ? String(Math.round(r.compositeScore)) : '—',
          flag(medianOf(records, 'downloadSupported')),
          first.downloadMechanism ?? '—',
          ms(medianOf(records, 'downloadMs')),
          medianOf(records, 'downloadBytes') ?? '—',
          flag(medianOf(records, 'downloadMatch')),
          flag(medianOf(records, 'uploadSupported')),
          ms(medianOf(records, 'uploadMs')),
          flag(medianOf(records, 'uploadMatch')),
          ms(medianOf(records, 'totalMs')),
        ].join(' | ')
          .replace(/^/, '| ')
          .replace(/$/, ' |');
      }),
  ].join('\n'),
);
write('');
write(`_Merged at ${merged.timestamp ?? 'unknown'}._`);
