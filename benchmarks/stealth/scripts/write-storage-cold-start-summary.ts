#!/usr/bin/env tsx
/**
 * GitHub Actions step summary for merged storage-cold-start results
 * (results/storage_cold_start/latest.json); prints to stdout outside Actions.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_PATH = path.resolve(__dirname, '../../../results/storage_cold_start/latest.json');
const SUMMARY_FILE = process.env.GITHUB_STEP_SUMMARY;
const TITLE = process.env.BENCHMARK_NAME ?? 'Storage Cold First Request';

function write(text: string): void {
  if (SUMMARY_FILE) fs.appendFileSync(SUMMARY_FILE, `${text}\n`);
  else console.log(text);
}

const ms = (v: unknown) => (typeof v === 'number' ? v.toFixed(1) : '—');

if (!fs.existsSync(RESULTS_PATH)) {
  write(`## ${TITLE}\n\nNo merged results found.`);
  process.exit(0);
}

const merged = JSON.parse(fs.readFileSync(RESULTS_PATH, 'utf8'));
const results = (merged.results ?? []) as any[];
write(`## ${TITLE}`);
write('');
write('Medians in ms (p95 in parentheses). Cold = first request from a fresh process.');
write('');
write('| Provider | Composite | Success | Cold GET | Warm GET | Cold penalty | Cold PUT | Warm PUT | Client init | Spawn (unscored) |');
write('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
for (const r of results.sort((a, b) => (b.compositeScore ?? -1) - (a.compositeScore ?? -1))) {
  const s = r.summary ?? {};
  const cell = (k: string) => `${ms(s[k]?.median)} (${ms(s[k]?.p95)})`;
  write(
    `| ${r.provider} | ${typeof r.compositeScore === 'number' ? r.compositeScore.toFixed(1) : '—'} | ${Math.round((r.successRate ?? 0) * 100)}% | ${cell('coldGetMs')} | ${ms(s.warmGetMs?.median)} | ${ms(s.coldPenaltyMs?.median)} | ${cell('coldPutMs')} | ${ms(s.warmPutMs?.median)} | ${ms(s.clientInitMs?.median)} | ${ms(s.processSpawnMs?.median)} |`,
  );
}
const failing = results.filter((r) => (r.errors ?? []).length > 0);
if (failing.length > 0) {
  write('');
  write('### Failures');
  for (const r of failing) write(`- **${r.provider}**: ${String(r.errors[0]).slice(0, 300)}`);
}
write('');
write(`_Merged at ${merged.timestamp ?? 'unknown'}._`);
