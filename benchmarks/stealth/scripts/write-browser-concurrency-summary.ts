#!/usr/bin/env tsx
/**
 * Write a GitHub Actions step summary for merged browser-concurrent results.
 *
 * Reads results/browser_concurrency/c{1,5,10,25,50}/latest.json and writes a
 * markdown table to GITHUB_STEP_SUMMARY (or stdout if not running in GitHub Actions).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeSweepScore, sortConcurrentByCompositeScore, supportedP95 } from '../browser/concurrent-scoring.js';
import { CONCURRENCY_LEVELS, SWEEP_WEIGHTS, type ConcurrentBenchmarkResult } from '../browser/concurrent-types.js';

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

function formatTable(headers: string[], rows: string[][]): string {
  const sep = headers.map(() => '---').join(' | ');
  const body = rows.map((row) => row.join(' | ')).join('\n');
  return [headers.join(' | '), sep, body].join('\n');
}

function buildLevelTable(results: ConcurrentBenchmarkResult[]): string {
  const sorted = sortConcurrentByCompositeScore(results);
  const headers = ['Provider', 'Score', 'Create', 'Loop', 'Loop (p95)', 'Screenshot', 'APS/sess', 'Peak', 'Success'];
  const rows: string[][] = [];
  for (const r of sorted) {
    if (r.skipped) {
      rows.push([r.provider, '—', '—', '—', '—', '—', '—', '—', `skipped: ${r.skipReason || ''}`]);
      continue;
    }
    const hideLatency = r.latencyRepresentative === false;
    const createMed = hideLatency ? '—' : `${(r.summary.createMs.median / 1000).toFixed(2)}s`;
    const loop = r.summary.loopMs;
    const taskMed = hideLatency || !loop ? '—' : `${(loop.median / 1000).toFixed(2)}s`;
    const p95 = loop ? supportedP95(loop) : null;
    const taskP95 = hideLatency || p95 === null ? '—' : `${(p95 / 1000).toFixed(2)}s`;
    const screenshotMed = hideLatency ? '—' : `${Math.round(r.summary.perActionType.screenshot?.median ?? 0)}ms`;
    const aps = hideLatency ? '—' : r.summary.perSessionActionsPerSecond.median.toFixed(2);
    const measuredPeak = r.rounds.reduce((max, round) => Math.max(max, round.maxConcurrentActions ?? 0), 0);
    const sustained = measuredPeak > 0
      ? measuredPeak
      : r.concurrencyAchieved !== undefined
        ? Math.round(r.concurrencyAchieved)
        : r.summary.sessionsAlive.median;
    const alive = `${sustained}/${r.concurrencyLevel}${r.quotaLimited ? '*' : ''}`;
    let totalSessions = 0;
    let fullSuccess = 0;
    for (const round of r.rounds) {
      for (const session of round.sessions) {
        totalSessions++;
        const attempted = session.actions.length;
        if (!session.error && attempted > 0 && session.actionsCompleted === attempted) fullSuccess++;
      }
    }
    const successPct =
      r.successRate !== undefined
        ? `${(r.successRate * 100).toFixed(0)}%`
        : totalSessions > 0
          ? `${((fullSuccess / totalSessions) * 100).toFixed(0)}%`
          : '0%';
    rows.push([
      r.provider,
      r.compositeScore?.toFixed(1) ?? '—',
      createMed,
      taskMed,
      taskP95,
      screenshotMed,
      aps,
      alive,
      successPct,
    ]);
  }
  return formatTable(headers, rows);
}

function buildSweepTable(scoresByProvider: Map<string, Map<number, number | undefined>>, quotaLimited: Set<string>): string {
  const rows = Array.from(scoresByProvider.entries())
    .map(([provider, byLevel]) => ({ provider, byLevel, sweep: computeSweepScore(byLevel) }))
    .sort((a, b) => b.sweep - a.sweep);

  const headers = ['Provider', 'Sweep', ...CONCURRENCY_LEVELS.map((l) => `c${l}`)];
  const data = rows.map(({ provider, byLevel, sweep }) => {
    const cells = CONCURRENCY_LEVELS.map((l) => {
      const score = byLevel.get(l);
      return score === undefined ? '—' : score.toFixed(1);
    });
    const name = `${provider}${quotaLimited.has(provider) ? '*' : ''}`;
    return [name, sweep.toFixed(1), ...cells];
  });
  return formatTable(headers, data);
}

function main(): void {
  const scoresByProvider = new Map<string, Map<number, number | undefined>>();
  const quotaLimited = new Set<string>();

  write('# Browser Concurrency Benchmark Results');
  write('');

  for (const level of CONCURRENCY_LEVELS) {
    const file = path.join(ROOT, 'results', 'browser_concurrency', `c${level}`, 'latest.json');
    if (!fs.existsSync(file)) continue;

    const data = JSON.parse(fs.readFileSync(file, 'utf-8')) as { results: ConcurrentBenchmarkResult[] };
    const results = data.results || [];

    write(`## Concurrency level c${level}`);
    write('');
    if (results.length === 0) {
      write('No results for this level.');
    } else {
      write(buildLevelTable(results));
    }
    write('');

    for (const r of results) {
      if (!scoresByProvider.has(r.provider)) scoresByProvider.set(r.provider, new Map());
      scoresByProvider.get(r.provider)!.set(level, r.skipped ? 0 : r.compositeScore);
      if (r.quotaLimited) quotaLimited.add(r.provider);
    }
  }

  if (scoresByProvider.size > 0) {
    write('## Sweep score');
    write('');
    write(`Weights: ${CONCURRENCY_LEVELS.map((l) => `c${l} ${(SWEEP_WEIGHTS[l] * 100).toFixed(0)}%`).join('  ')}`);
    write('');
    write(buildSweepTable(scoresByProvider, quotaLimited));
    write('');
    if (quotaLimited.size > 0) {
      write(`\* capped by an account limit, not capacity: ${Array.from(quotaLimited).join(', ')}`);
    }
  }
}

main();
