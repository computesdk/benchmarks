#!/usr/bin/env tsx
/**
 * Write a GitHub Actions step summary for merged browser-session-persistence
 * results.
 *
 * Reads results/browser_session_persistence/latest.json and writes a markdown
 * table to GITHUB_STEP_SUMMARY (or stdout when not running in GitHub Actions).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');
const SUMMARY_FILE = process.env.GITHUB_STEP_SUMMARY;

const lines: string[] = [];

function write(text: string): void {
  if (SUMMARY_FILE) {
    fs.appendFileSync(SUMMARY_FILE, `${text}\n`);
  } else {
    console.log(text);
  }
}

interface ProviderRow {
  provider: string;
  mechanism?: string;
  iterations?: Record<string, unknown>[];
  summary?: Record<string, { median: number; p95: number; p99: number }>;
  compositeScore?: number;
  successRate?: number;
  resumeRate?: number;
}

function formatTable(headers: string[], rows: string[][]): string {
  const sep = headers.map(() => '---').join(' | ');
  const body = rows.map((row) => row.join(' | ')).join('\n');
  return [headers.join(' | '), sep, body].join('\n');
}

function buildTable(results: ProviderRow[]): string {
  const sorted = [...results].sort((a, b) => (b.compositeScore ?? -1) - (a.compositeScore ?? -1));
  const headers = ['Provider', 'Score', 'Resume', 'Mechanism', 'Reconnect', 'Cookies', 'Storage', 'Tabs', 'Success'];
  const pct = (v?: number) => (v === undefined ? '—' : `${(v * 100).toFixed(0)}%`);
  const flagCount = (row: ProviderRow, key: string) => {
    const values = (row.iterations ?? [])
      .map((d) => Number(d[key]))
      .filter((v) => Number.isFinite(v));
    if (values.length === 0) return '—';
    return `${values.filter((v) => v === 1).length}/${values.length}`;
  };
  const rows = sorted.map((r) => [
    r.provider,
    r.compositeScore?.toFixed(1) ?? '—',
    pct(r.resumeRate),
    r.mechanism ?? '—',
    r.summary?.reconnectMs ? `${Math.round(r.summary.reconnectMs.median)}ms` : '—',
    flagCount(r, 'cookiesPreserved'),
    flagCount(r, 'storagePreserved'),
    flagCount(r, 'tabsPreserved'),
    pct(r.successRate),
  ]);
  return formatTable(headers, rows);
}

function main(): void {
  write('# Browser Session Persistence Benchmark Results');
  write('');

  const file = path.join(ROOT, 'results', 'browser_session_persistence', 'latest.json');
  if (!fs.existsSync(file)) {
    write('No merged results were generated.');
    return;
  }

  const data = JSON.parse(fs.readFileSync(file, 'utf-8')) as { results: ProviderRow[] };
  const results = data.results || [];
  if (results.length === 0) {
    write('No results.');
    return;
  }

  write('Whether a browser-agent session survives a client disconnect: reconnect success,');
  write('then how fast it reconnects and whether cookie / localStorage / tab state survived.');
  write('');
  write(buildTable(results));
  write('');
}

main();
