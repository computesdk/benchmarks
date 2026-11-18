#!/usr/bin/env tsx
/**
 * Write a GitHub Actions step summary for merged web-data scrape results.
 *
 * Reads results/web_data_scrape/latest.json and writes a markdown
 * table to GITHUB_STEP_SUMMARY (or stdout when not running in Actions).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');
const SUMMARY_FILE = process.env.GITHUB_STEP_SUMMARY;
const RESULTS_PATH = path.join(ROOT, 'results/web_data_scrape/latest.json');

function write(text: string): void {
  if (SUMMARY_FILE) {
    fs.appendFileSync(SUMMARY_FILE, `${text}\n`);
  } else {
    console.log(text);
  }
}

function ms(v: number | undefined): string {
  return typeof v === 'number' && v > 0 ? `${(v / 1000).toFixed(2)}s` : '—';
}

function pct(v: number | undefined): string {
  return typeof v === 'number' ? `${Math.round(v * 100)}%` : '—';
}

function bucket(b: { success: number; total: number } | undefined): string {
  return b ? `${b.success}/${b.total}` : '—';
}

if (!fs.existsSync(RESULTS_PATH)) {
  write('## Web Data Scrape\n\nNo merged results found.');
  process.exit(0);
}

const merged = JSON.parse(fs.readFileSync(RESULTS_PATH, 'utf8'));
const results = (merged.results ?? []) as any[];

write('## Web Data Scrape');
write('');
write(
  [
    '| Provider | Composite | Success | Scrape median | p95 | p99 | Static | JS | Protected |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...results
      .sort((a, b) => (b.compositeScore ?? -1) - (a.compositeScore ?? -1))
      .map((r) => {
        const buckets = r.summary?.buckets ?? {};
        return [
          r.provider,
          r.compositeScore !== undefined ? String(Math.round(r.compositeScore)) : '—',
          pct(r.successRate),
          ms(r.summary?.scrapeMs?.median),
          ms(r.summary?.scrapeMs?.p95),
          ms(r.summary?.scrapeMs?.p99),
          bucket(buckets.static),
          bucket(buckets.js),
          bucket(buckets.protected),
        ].join(' | ')
          .replace(/^/, '| ')
          .replace(/$/, ' |');
      }),
  ].join('\n'),
);
write('');
write(`_Merged at ${merged.timestamp ?? 'unknown'}._`);
