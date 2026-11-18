#!/usr/bin/env tsx
/**
 * Merge per-provider browser-session-persistence benchmark artifacts into a
 * single results/browser_session_persistence/latest.json.
 *
 * Usage: tsx benchmarks/stealth/scripts/merge-browser-session-persistence-results.ts --input <artifacts-dir>
 *
 * Provider artifacts are scoped to this benchmark's results dir, so each
 * `results-<provider>/` artifact holds `latest.json` at its root. Older
 * artifacts carried the whole results/ tree; for those, only files under a
 * `browser_session_persistence/` dir belong to this merge.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TaskResultRecord } from '@benchsdk/client';
import { scoreSessionPersistenceRecords } from '../browser/session-persistence-legacy-results.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');

const args = process.argv.slice(2);
const inputDir = (() => {
  const idx = args.indexOf('--input');
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : 'artifacts';
})();

interface ProviderRow {
  provider: string;
  mechanism?: string;
  iterations?: unknown[];
  records?: TaskResultRecord[];
  summary?: Record<string, { median: number; p95: number; p99: number }>;
  compositeScore?: number;
  successRate?: number;
  resumeRate?: number;
}

function findResultFiles(dir: string): string[] {
  const files: string[] = [];
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (path.basename(entry.name) !== 'browser_session_persistence') {
        if (entry.name.startsWith('results-')) {
          const scoped = path.join(full, 'latest.json');
          if (fs.existsSync(scoped) && fs.statSync(scoped).isFile()) {
            files.push(scoped);
          }
        }
        files.push(...findResultFiles(full));
      } else {
        for (const inner of fs.readdirSync(full, { withFileTypes: true })) {
          if (inner.isFile() && inner.name === 'latest.json') {
            files.push(path.join(full, inner.name));
          }
        }
      }
    }
  }
  return files;
}

function main(): void {
  const resolvedInput = path.resolve(inputDir);
  const files = findResultFiles(resolvedInput);
  if (files.length === 0) {
    console.error(`No browser_session_persistence latest.json files found in ${resolvedInput}`);
    process.exit(1);
  }
  console.log(`Found ${files.length} result files`);

  // Prefer a file holding exactly one provider row (a per-provider artifact)
  // over a previously merged multi-provider file.
  const seen = new Map<string, { result: ProviderRow; fromSingleProvider: boolean }>();
  for (const file of files) {
    let raw: { results?: ProviderRow[] };
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch {
      console.warn(`Skipping invalid JSON: ${file}`);
      continue;
    }
    if (!raw || !Array.isArray(raw.results)) continue;
    const fromSingleProvider = raw.results.length === 1;
    for (const result of raw.results) {
      if (!result || typeof result.provider !== 'string') continue;
      const existing = seen.get(result.provider);
      if (!existing || (fromSingleProvider && !existing.fromSingleProvider)) {
        seen.set(result.provider, { result, fromSingleProvider });
      }
    }
  }
  if (seen.size === 0) {
    console.error('No provider results found to merge.');
    process.exit(1);
  }

  const deduped = Array.from(seen.values()).map((e) => e.result);

  // Recompute composites from the per-iteration records so the merged file is
  // self-consistent even if providers were written by different revisions.
  for (const r of deduped) {
    // Old artifacts lack status evidence. Keep their saved score untouched.
    const records = r.records ?? [];
    if (records.length > 0) {
      r.compositeScore = scoreSessionPersistenceRecords(records);
      r.resumeRate = records.filter(
        (rec) => (rec.data as { resumeSupported?: number } | undefined)?.resumeSupported === 1,
      ).length / records.length;
    }
  }
  deduped.sort((a, b) => (b.compositeScore ?? -1) - (a.compositeScore ?? -1));

  const timestamp = new Date().toISOString().slice(0, 10);
  const resultsDir = path.resolve(ROOT, 'results', 'browser_session_persistence');
  fs.mkdirSync(resultsDir, { recursive: true });
  const out = { version: '1.0', timestamp: new Date().toISOString(), results: deduped };
  fs.writeFileSync(path.join(resultsDir, `${timestamp}.json`), JSON.stringify(out, null, 2));
  fs.writeFileSync(path.join(resultsDir, 'latest.json'), JSON.stringify(out, null, 2));
  console.log(`Merged ${deduped.length} provider(s) into ${path.join(resultsDir, 'latest.json')}`);

  console.log(`\n${'='.repeat(110)}`);
  console.log('  BROWSER SESSION PERSISTENCE RESULTS');
  console.log('='.repeat(110));
  console.log(
    ['Provider', 'Score', 'Resume', 'Mechanism', 'Reconnect', 'Cookies', 'Storage', 'Tabs', 'Success']
      .map((h, i) => h.padEnd([14, 8, 8, 14, 12, 9, 9, 7, 10][i]))
      .join(' | '),
  );
  console.log('='.repeat(110));
  for (const r of deduped) {
    const s = r.summary ?? {};
    const pct = (v?: number) => (v === undefined ? '—' : `${(v * 100).toFixed(0)}%`);
    const flagMed = (key: string) => {
      const values = (r.iterations ?? [])
        .map((d) => Number((d as Record<string, unknown>)[key]))
        .filter((v) => Number.isFinite(v));
      if (values.length === 0) return '—';
      const hits = values.filter((v) => v === 1).length;
      return `${hits}/${values.length}`;
    };
    console.log(
      [
        r.provider.padEnd(14),
        (r.compositeScore !== undefined ? r.compositeScore.toFixed(1) : '—').padEnd(8),
        pct(r.resumeRate).padEnd(8),
        (r.mechanism ?? '—').padEnd(14),
        (s.reconnectMs ? `${Math.round(s.reconnectMs.median)}ms` : '—').padEnd(12),
        flagMed('cookiesPreserved').padEnd(9),
        flagMed('storagePreserved').padEnd(9),
        flagMed('tabsPreserved').padEnd(7),
        pct(r.successRate).padEnd(10),
      ].join(' | '),
    );
  }
  console.log('='.repeat(110));
}

main();
