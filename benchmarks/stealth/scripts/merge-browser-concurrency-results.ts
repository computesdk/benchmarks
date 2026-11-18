#!/usr/bin/env tsx
/**
 * Merge per-provider browser-concurrency benchmark artifacts into combined
 * result files.
 *
 * Usage: tsx benchmarks/stealth/scripts/merge-browser-concurrency-results.ts --input <artifacts-dir>
 *
 * Reads latest.json files grouped by concurrency level directory (c1, c5,
 * c10, c25, c50), deduplicates by provider, computes composite scores, and
 * writes merged files to results/browser_concurrency/<level>/latest.json.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeConcurrentResultsJson } from '../browser/concurrent-benchmark.js';
import { computeConcurrentCompositeScores, computeSweepScore, sortConcurrentByCompositeScore, supportedP95 } from '../browser/concurrent-scoring.js';
import { CONCURRENCY_LEVELS, SWEEP_WEIGHTS, type ConcurrentBenchmarkResult } from '../browser/concurrent-types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');

const args = process.argv.slice(2);
const inputDir = (() => {
  const idx = args.indexOf('--input');
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : 'artifacts';
})();

function printConcurrentSweepTable(
  scoresByProvider: Map<string, Map<number, number | undefined>>,
  quotaLimited: Set<string>,
): void {
  if (scoresByProvider.size === 0) return;

  const rows = Array.from(scoresByProvider.entries())
    .map(([provider, byLevel]) => ({ provider, byLevel, sweep: computeSweepScore(byLevel) }))
    .sort((a, b) => b.sweep - a.sweep);

  const weights = CONCURRENCY_LEVELS.map((l) => `c${l} ${(SWEEP_WEIGHTS[l] * 100).toFixed(0)}%`).join('  ');
  console.log(`\n${'='.repeat(120)}`);
  console.log('  BROWSER CONCURRENCY SWEEP SCORE');
  console.log('='.repeat(120));
  console.log(`  weights: ${weights}   (a level with no result scores 0 and keeps its weight)`);
  console.log('-'.repeat(120));
  console.log(['Provider'.padEnd(14), 'Sweep'.padEnd(8), ...CONCURRENCY_LEVELS.map((l) => `c${l}`.padEnd(8))].join(' | '));
  console.log('-'.repeat(120));
  for (const { provider, byLevel, sweep } of rows) {
    const cells = CONCURRENCY_LEVELS.map((l) => {
      const score = byLevel.get(l);
      return (score === undefined ? '--' : score.toFixed(1)).padEnd(8);
    });
    const name = `${provider}${quotaLimited.has(provider) ? '*' : ''}`;
    console.log([name.padEnd(14), sweep.toFixed(1).padEnd(8), ...cells].join(' | '));
  }
  console.log('='.repeat(120));
  const missing = rows.filter((r) => CONCURRENCY_LEVELS.some((l) => r.byLevel.get(l) === undefined));
  if (missing.length > 0) {
    console.log(
      `  -- levels with no result count as 0: ${missing
        .map((r) => `${r.provider} (${CONCURRENCY_LEVELS.filter((l) => r.byLevel.get(l) === undefined).map((l) => `c${l}`).join(', ')})`)
        .join('; ')}`,
    );
  }
  if (quotaLimited.size > 0) {
    console.log(`  *  capped by an account limit, not capacity: ${Array.from(quotaLimited).join(', ')}`);
  }
}

async function main(): Promise<void> {
  const resolvedInput = path.resolve(inputDir);
  const jsonFiles: string[] = [];

  // Provider artifacts carry the whole results/ tree, including committed
  // latest.json files from other benchmarks (oci_tti, sandbox_*, ...). Only
  // files under a `browser_concurrency/c<N>` level dir belong to this merge —
  // other benches' results are not ConcurrentBenchmarkResult and crash
  // scoring (e.g. `rounds` is undefined → "cNaN" level group).
  function walk(dir: string) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (
        entry.name === 'latest.json' &&
        /^c\d+$/.test(path.basename(dir)) &&
        path.basename(path.dirname(dir)) === 'browser_concurrency'
      ) {
        jsonFiles.push(full);
      }
    }
  }
  walk(resolvedInput);

  if (jsonFiles.length === 0) {
    console.error(`No latest.json files found in ${resolvedInput}`);
    process.exit(1);
  }

  console.log(`Found ${jsonFiles.length} result files`);

  const filesByLevel = new Map<string, string[]>();
  for (const file of jsonFiles) {
    const levelDir = path.basename(path.dirname(file));
    if (!filesByLevel.has(levelDir)) filesByLevel.set(levelDir, []);
    filesByLevel.get(levelDir)!.push(file);
  }

  const scoresByProvider = new Map<string, Map<number, number | undefined>>();
  const quotaLimitedProviders = new Set<string>();

  for (const [levelDir, files] of filesByLevel) {
    const seen = new Map<string, { result: ConcurrentBenchmarkResult; fromSingleProvider: boolean }>();

    for (const file of files) {
      const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as { results: ConcurrentBenchmarkResult[] };
      const fromSingleProvider = raw.results.length === 1;
      for (const result of raw.results) {
        const existing = seen.get(result.provider);
        if (!existing || (fromSingleProvider && !existing.fromSingleProvider)) {
          seen.set(result.provider, { result, fromSingleProvider });
        }
      }
    }

    const deduped = Array.from(seen.values()).map((e) => e.result);
    const concurrencyLevel = deduped[0]?.concurrencyLevel ?? parseInt(levelDir.replace('c', ''), 10);
    console.log(`\nMerging ${deduped.length} provider results for mode: browser-concurrent (c${concurrencyLevel})`);

    computeConcurrentCompositeScores(deduped);

    for (const r of deduped) {
      if (!scoresByProvider.has(r.provider)) scoresByProvider.set(r.provider, new Map());
      scoresByProvider.get(r.provider)!.set(concurrencyLevel, r.skipped ? 0 : r.compositeScore);
      if (r.quotaLimited) quotaLimitedProviders.add(r.provider);
    }

    const sorted = sortConcurrentByCompositeScore(deduped);
    console.log(`\n${'='.repeat(120)}`);
    console.log(`  BROWSER CONCURRENT BENCHMARK RESULTS (c${concurrencyLevel})`);
    console.log('='.repeat(120));
    console.log(
      ['Provider', 'Score', 'Create', 'Loop', 'Loop (p95)', 'Screenshot', 'APS/sess', 'Peak', 'Success']
        .map((h, i) => h.padEnd([14, 8, 10, 10, 10, 12, 10, 8, 10][i]))
        .join(' | '),
    );
    console.log('='.repeat(120));
    for (const r of sorted) {
      if (r.skipped) continue;
      const score = r.compositeScore !== undefined ? r.compositeScore.toFixed(1) : '--';
      const hideLatency = r.latencyRepresentative === false;
      const createMed = hideLatency ? '--' : `${(r.summary.createMs.median / 1000).toFixed(2)}s`;
      const loop = r.summary.loopMs;
      const taskMed = hideLatency || !loop ? '--' : `${(loop.median / 1000).toFixed(2)}s`;
      const p95 = loop ? supportedP95(loop) : null;
      const taskP95 = hideLatency || p95 === null ? '--' : `${(p95 / 1000).toFixed(2)}s`;
      const screenshotMed = hideLatency
        ? '--'
        : `${Math.round(r.summary.perActionType.screenshot?.median ?? 0)}ms`;
      const aps = hideLatency ? '--' : r.summary.perSessionActionsPerSecond.median.toFixed(2);
      const measuredPeak = r.rounds.reduce(
        (max, round) => Math.max(max, round.maxConcurrentActions ?? 0),
        0,
      );
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
      console.log(
        [r.provider.padEnd(14), score.padEnd(8), createMed.padEnd(10), taskMed.padEnd(10), taskP95.padEnd(10), screenshotMed.padEnd(12), aps.padEnd(10), alive.padEnd(8), successPct.padEnd(10)].join(' | '),
      );
    }
    console.log('='.repeat(120));
    const withheld = sorted.filter((r) => !r.skipped && r.latencyRepresentative === false);
    if (withheld.length > 0) {
      console.log(
        `  -- latency withheld, load not sustained: ${withheld
          .map((r) => `${r.provider} held ${Math.round(r.concurrencyAchieved ?? 0)}/${r.concurrencyLevel}`)
          .join(', ')}`,
      );
    }
    const quotaCapped = sorted.filter((r) => r.quotaLimited);
    if (quotaCapped.length > 0) {
      console.log(`  *  capped by an account limit, not capacity: ${quotaCapped.map((r) => r.provider).join(', ')}`);
      for (const r of quotaCapped) {
        if (r.quotaEvidence) console.log(`     ${r.provider}: ${r.quotaEvidence}`);
      }
    }

    const timestamp = new Date().toISOString().slice(0, 10);
    const resultsDir = path.resolve(ROOT, 'results', 'browser_concurrency', levelDir);
    fs.mkdirSync(resultsDir, { recursive: true });

    const outPath = path.join(resultsDir, `${timestamp}.json`);
    await writeConcurrentResultsJson(deduped, outPath, { concurrencyLevel });

    const latestPath = path.join(resultsDir, 'latest.json');
    fs.copyFileSync(outPath, latestPath);
    console.log(`Copied latest: ${latestPath}`);
  }

  printConcurrentSweepTable(scoresByProvider, quotaLimitedProviders);
}

main().catch((err) => {
  console.error('Merge failed:', err);
  process.exit(1);
});
