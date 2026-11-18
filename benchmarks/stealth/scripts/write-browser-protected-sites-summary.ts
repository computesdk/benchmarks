#!/usr/bin/env tsx
/**
 * Write a GitHub Actions step summary for merged browser-protected-sites
 * results.
 *
 * Reads results/browser_protected_sites/latest.json and writes a markdown
 * table to GITHUB_STEP_SUMMARY (or stdout when not running in Actions).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');
const SUMMARY_FILE = process.env.GITHUB_STEP_SUMMARY;

const lines: string[] = [];
function write(text: string): void {
  if (SUMMARY_FILE) fs.appendFileSync(SUMMARY_FILE, `${text}\n`);
  else console.log(text);
}

interface SiteRollup {
  outcome: string[];
  passed: number;
  iterations: number;
  captchaEncountered: number;
  captchaSolved: number;
}

interface ProviderResult {
  provider: string;
  sites: Record<string, SiteRollup>;
  summary: { timeToPassMs?: { median: number }; captchaSolveMs?: { median: number } };
  passRate: number;
}

function main(): void {
  const file = path.join(ROOT, 'results', 'browser_protected_sites', 'latest.json');
  write('# Browser Protected Sites Results');
  write('');
  if (!fs.existsSync(file)) {
    write('No merged results found.');
    return;
  }

  const data = JSON.parse(fs.readFileSync(file, 'utf-8')) as { results: ProviderResult[] };
  const results = data.results ?? [];
  if (results.length === 0) {
    write('No provider results found.');
    return;
  }

  const siteSlugs = Array.from(
    new Set(results.flatMap((r) => Object.keys(r.sites ?? {}))),
  );

  const sorted = [...results].sort((a, b) => {
    if (b.passRate !== a.passRate) return b.passRate - a.passRate;
    return (a.summary?.timeToPassMs?.median ?? Infinity) - (b.summary?.timeToPassMs?.median ?? Infinity);
  });

  const headers = ['Provider', 'Pass rate', 'Median pass time', 'CAPTCHAs solved', ...siteSlugs];
  const sep = headers.map(() => '---').join(' | ');
  const rows = sorted.map((r) => {
    const siteCells = siteSlugs.map((slug) => {
      const s = r.sites?.[slug];
      return s ? s.outcome.join(', ') : '—';
    });
    const solved = Object.values(r.sites ?? {}).reduce((n, s) => n + s.captchaSolved, 0);
    const seen = Object.values(r.sites ?? {}).reduce((n, s) => n + s.captchaEncountered, 0);
    return [
      r.provider,
      `${(r.passRate * 100).toFixed(0)}%`,
      r.summary?.timeToPassMs ? `${(r.summary.timeToPassMs.median / 1000).toFixed(1)}s` : '—',
      `${solved}/${seen}`,
      ...siteCells,
    ];
  });

  write(headers.join(' | '));
  write(sep);
  for (const row of rows) write(row.join(' | '));
  write('');
  write('Per-site cells list each iteration outcome: pass, solved, challenge, blocked, timeout.');
}

main();
