#!/usr/bin/env tsx
/**
 * Write a GitHub Actions step summary for merged browser-idle-resume
 * results.
 *
 * Reads results/browser_idle_resume/latest.json and writes a markdown
 * table to GITHUB_STEP_SUMMARY (or stdout when not running in Actions).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');
const SUMMARY_FILE = process.env.GITHUB_STEP_SUMMARY;
const RESULTS_PATH = path.join(ROOT, 'results/browser_idle_resume/latest.json');

const GAP_KEYS = ['resume10s', 'resume30s', 'resume60s', 'resume300s'] as const;
const GAP_LABELS: Record<string, string> = {
  resume10s: '10s',
  resume30s: '30s',
  resume60s: '60s',
  resume300s: '300s',
};

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
    .map((r) => r?.[key])
    .filter((v): v is number => typeof v === 'number')
    .sort((a, b) => a - b);
  return xs.length ? xs[Math.floor(xs.length / 2)] : undefined;
}

if (!fs.existsSync(RESULTS_PATH)) {
  write('## Browser Idle Resume\n\nNo merged results found.');
  process.exit(0);
}

const merged = JSON.parse(fs.readFileSync(RESULTS_PATH, 'utf8'));
const results = (merged.results ?? []) as any[];

write('## Browser Idle Resume');
write('');
write('Whether a browser-agent session can be resumed after sitting disconnected.');
write('A gap passes only when the session reconnects AND keeps cookie/localStorage/tab state.');
write('');
write(
  [
    '| Provider | Composite | Idle 10s | Idle 30s | Idle 60s | Idle 300s | Mechanism | Reconnect | Cookies | Storage | Tabs |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...results
      .sort((a, b) => (b.compositeScore ?? -1) - (a.compositeScore ?? -1))
      .map((r) => {
        const records = r.iterations ?? r.records ?? [];
        const data = records.map((it: any) => it?.data ?? it ?? {});
        const mechanisms = [...new Set(data.map((d: any) => d.resumeMechanism).filter(Boolean))];
        return [
          r.provider,
          r.compositeScore !== undefined ? String(Math.round(r.compositeScore)) : '—',
          ...GAP_KEYS.map((k) => flag(medianOf(data, k))),
          mechanisms.length ? mechanisms.join(', ') : '—',
          ms(medianOf(data, 'reconnectMs')),
          flag(medianOf(data, 'cookiesPreserved')),
          flag(medianOf(data, 'storagePreserved')),
          flag(medianOf(data, 'tabsPreserved')),
        ].join(' | ')
          .replace(/^/, '| ')
          .replace(/$/, ' |');
      }),
  ].join('\n'),
);
write('');
write(`_Merged at ${merged.timestamp ?? 'unknown'}._`);
