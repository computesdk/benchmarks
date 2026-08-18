import { mkdirSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { summarizeRounds, writeConcurrentResultsJson } from './concurrent-benchmark.js';
import { computeConcurrentCompositeScores } from './concurrent-scoring.js';
import {
  CONCURRENCY_LEVELS,
  type ConcurrentBenchmarkResult,
  type RoundResult,
} from './concurrent-types.js';

/** Every round of the sweep, keyed by provider then concurrency level. */
export type CollectedRounds = Map<string, Map<number, RoundResult[]>>;

/**
 * Write one result file per concurrency level, keeping the per-level layout the
 * merge step and the SVG generators already read:
 *   results/browser-concurrent/c1/latest.json ... c50/latest.json
 *
 * Written from the rounds collected in process rather than from the records
 * sent to the platform. The task payload carries per-round aggregates only, so
 * reconstructing a round from it would silently drop every session and action.
 */
export async function writeConcurrentSweepResults(
  collected: CollectedRounds,
  opts: { resultsRoot: string; timeoutMs: number },
): Promise<void> {
  const timestamp = new Date().toISOString().slice(0, 10);

  for (const level of CONCURRENCY_LEVELS) {
    const results: ConcurrentBenchmarkResult[] = [];

    // Alphabetical, so the file does not reorder when providers finish in a
    // different order. Rankings are applied by the scoring step, not by this.
    for (const provider of [...collected.keys()].sort()) {
      const rounds = collected.get(provider)?.get(level);
      if (!rounds || rounds.length === 0) continue;
      const ordered = [...rounds].sort((a, b) => a.roundIndex - b.roundIndex);
      results.push({
        provider,
        mode: 'browser-concurrent' as const,
        concurrencyLevel: level,
        rounds: ordered,
        summary: summarizeRounds(ordered),
      });
    }

    // A level with no rounds at all never ran: the run was interrupted before
    // reaching it. Writing an empty file would overwrite a good result from an
    // earlier run with one that has nothing in it.
    if (results.length === 0) {
      console.log(`No rounds recorded at c${level}; leaving its results untouched.`);
      continue;
    }

    computeConcurrentCompositeScores(results);

    const dir = path.join(opts.resultsRoot, `c${level}`);
    mkdirSync(dir, { recursive: true });

    const outPath = path.join(dir, `${timestamp}.json`);
    await writeConcurrentResultsJson(results, outPath, {
      concurrencyLevel: level,
      timeoutMs: opts.timeoutMs,
    });

    const latestPath = path.join(dir, 'latest.json');
    copyFileSync(outPath, latestPath);
    console.log(`Copied latest: ${latestPath}`);
  }
}
