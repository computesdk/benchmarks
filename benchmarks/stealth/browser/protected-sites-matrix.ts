/**
 * Index-layout (matrix) dataset builder for browser-protected-sites.
 *
 * Modeled on provider-weekly-composite's index declaration: rows are the
 * protected sites, participants are the browser providers, and each cell is
 * the provider's score for that site (pass fraction ×100, higher-better) with
 * the raw outcomes in `detail`. Provider cards headline overall pass rate and
 * list median time-to-pass and CAPTCHA solves as facts. Built from the run's
 * participant records and uploaded as a `kind: 'matrix'` run artifact.
 */
import type { BenchmarkRunOutcome } from '@benchsdk/runner';
import { PlatformApi, type MatrixDataset } from '../composite/provider-weekly-composite.js';

interface SiteRecord {
  site?: string;
  phase?: string;
  passed?: number;
  timeToPassMs?: number;
  captchaEncountered?: number;
  captchaSolved?: number;
  outcome?: string;
}

interface ProviderBucket {
  name: string;
  records: SiteRecord[];
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/** Round to the cell spec's 1 decimal without stringifying. */
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Assemble the matrix dataset. Every configured site is a row even if every
 * provider timed out on it; every run participant is a column. Cells a
 * provider has no record for are `state: 'missing'` (rendered '—').
 */
export function buildProtectedSitesMatrix(
  siteSlugs: string[],
  providers: ProviderBucket[],
): MatrixDataset {
  const cells: MatrixDataset['cells'] = {};
  const cards: MatrixDataset['cards'] = {};

  for (const slug of siteSlugs) {
    const row: Record<string, MatrixDataset['cells'][string][string]> = {};
    for (const provider of providers) {
      const records = provider.records.filter((r) => (r.site ?? r.phase) === slug);
      if (records.length === 0) {
        row[provider.name] = { detail: 'not run', state: 'missing' };
        continue;
      }
      const passedCount = records.filter((r) => r.passed === 1).length;
      const outcomes = records.map((r) => r.outcome ?? 'error').join(', ');
      const passTimes = records.filter((r) => r.passed === 1).map((r) => r.timeToPassMs ?? 0);
      const medianPass = median(passTimes);
      row[provider.name] = {
        value: round1((passedCount / records.length) * 100),
        detail: medianPass !== null ? `${outcomes} · ${Math.round(medianPass)}ms` : outcomes,
        state: 'data',
      };
    }
    cells[slug] = row;
  }

  for (const provider of providers) {
    const records = provider.records;
    const passedCount = records.filter((r) => r.passed === 1).length;
    const passRate = records.length === 0 ? null : round1((passedCount / records.length) * 100);
    const passTimes = records.filter((r) => r.passed === 1).map((r) => r.timeToPassMs ?? 0);
    const medianPass = median(passTimes);
    const captchasSeen = records.filter((r) => r.captchaEncountered === 1).length;
    const captchasSolved = records.filter((r) => r.captchaSolved === 1).length;
    cards[provider.name] = {
      ...(passRate === null ? {} : { headline: { label: 'Pass rate', value: passRate } }),
      facts: [
        { label: 'Sites passed', value: `${passedCount}/${records.length}` },
        { label: 'Median time to pass', value: medianPass !== null ? `${Math.round(medianPass)}ms` : '—' },
        { label: 'CAPTCHAs solved', value: `${captchasSolved}/${captchasSeen}` },
      ],
    };
  }

  return {
    version: 1,
    rows: siteSlugs.map((slug) => ({ key: slug, label: slug })),
    participants: providers.map((provider) => ({ key: provider.name, label: provider.name })),
    cells,
    cards,
  };
}

/**
 * Build the matrix dataset from the run's participant records and upload it
 * as a run-level artifact. Additive to the standard summary — an upload
 * failure is logged, never thrown. `--no-ingest` runs print the payload.
 */
export async function uploadProtectedSitesMatrix(
  siteSlugs: string[],
  outcome: BenchmarkRunOutcome,
  benchmarkSlug: string,
): Promise<void> {
  const dataset = buildProtectedSitesMatrix(
    siteSlugs,
    outcome.participants.map((p) => ({
      name: p.participant,
      records: p.records.map((record) => (record.data ?? {}) as SiteRecord),
    })),
  );
  const body = JSON.stringify(dataset);
  if (outcome.runId === 'no-ingest') {
    console.log(`[matrix] no-ingest run — dataset payload (not uploaded):\n${body}`);
    return;
  }
  try {
    await new PlatformApi().uploadRunArtifact(
      benchmarkSlug,
      outcome.runId,
      { kind: 'matrix', name: 'matrix', contentType: 'application/json', metadata: {} },
      body,
    );
    console.log(`[matrix] uploaded dataset artifact to run ${outcome.runId}`);
  } catch (error) {
    console.warn(`[matrix] artifact upload failed (standard summary already submitted): ${error}`);
  }
}
