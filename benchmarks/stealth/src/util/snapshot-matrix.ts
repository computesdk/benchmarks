/**
 * Shared matrix-dataset builder + uploader for the snapshot benchmarks
 * (`type: 'index'`, `index.layout: 'matrix'`).
 *
 * The platform's matrix layout renders a rows × participants grid uploaded
 * as a run-level `kind: 'matrix'` artifact (see "Index: the generic matrix
 * layout" in benchmarks-platform's docs/2026-09-29-benchmark-types.md). Each
 * Actions leg uploads its own provider's slice; the platform unions slices
 * per run (later uploads win per cell).
 *
 * Display contract: the matrix answers "did the full create+restore cycle
 * verify, and how fast was the verified path" — not "did each API call
 * return". Latency cells only show a number when the stage genuinely ran;
 * `snapshot-restore`/`verify` additionally require `verifyPassed`, so a
 * provider whose restore returns but loses files shows '—' with the failure
 * in the cell tooltip rather than a meaningless latency. The participant
 * card carries the verdict (restore ms when verified, otherwise the
 * failure/not-supported label).
 *
 * All cell values are milliseconds, so the shared spec is
 * `{ unit: 'ms', decimals: 0, direction: 'lower-better' }`.
 */
import type { JsonObject } from '@benchsdk/client';
import type { BenchmarkRunOutcome, ParticipantRecords } from '@benchsdk/runner';

const FETCH_TIMEOUT_MS = 30_000;

/** `config.index.spec` value shared by every snapshot matrix bench. */
export const SNAPSHOT_MATRIX_SPEC: JsonObject = {
  cell: { unit: 'ms', decimals: 0, direction: 'lower-better' },
  highlight: 'best-in-row',
};

interface MatrixCell {
  value?: number;
  detail?: string;
  state: 'data' | 'missing';
}

interface MatrixDataset {
  version: 1;
  rows: { key: string; label: string }[];
  participants: { key: string; label: string }[];
  cells: Record<string, Record<string, MatrixCell>>;
  cards: Record<
    string,
    {
      headline: { label: string; value: number | string };
      facts: { label: string; value: string }[];
    }
  >;
}

const ROWS: { key: string; label: string }[] = [
  { key: 'createMs', label: 'Create sandbox' },
  { key: 'populateMs', label: 'Populate filesystem' },
  { key: 'snapshotCreateMs', label: 'Snapshot create' },
  { key: 'downMs', label: 'Take source down' },
  { key: 'snapshotRestoreMs', label: 'Restore from snapshot' },
  { key: 'verifyMs', label: 'Verify' },
  { key: 'destroyMs', label: 'Destroy' },
  { key: 'wallClockMs', label: 'Wall clock' },
];

/** ms metrics displayed for any stage that ran, whatever the verdict. */
const ALWAYS_MS = new Set(['createMs', 'populateMs', 'snapshotCreateMs', 'downMs', 'destroyMs', 'wallClockMs']);
/** ms metrics only meaningful when the whole lifecycle verified. */
const VERIFIED_MS = new Set(['snapshotRestoreMs', 'verifyMs']);

function median(values: number[]): number | null {
  const sorted = values.filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function num(data: JsonObject | undefined, key: string): number | null {
  const v = data?.[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Truncate an error string for a cell tooltip / card fact. */
function short(text: string, max = 140): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Per-iteration verify detail, e.g. "3/11 files matched" or "marker verified". */
function verifyDetail(data: JsonObject | undefined): string {
  const filesVerified = num(data, 'filesVerified');
  const fileCount = num(data, 'fileCount');
  if (filesVerified !== null && fileCount !== null) {
    return `${filesVerified}/${fileCount + 1} files matched`;
  }
  return data?.verifyPassed === true ? 'marker verified' : 'marker not found';
}

interface ProviderSummary {
  name: string;
  iterations: number;
  passed: number;
  supported: boolean;
  boxIdentity: boolean;
  error?: string;
  /** Median per metric key across iterations. */
  medians: Record<string, number | null>;
  /** Detail strings for the restore/verify cells when not fully verified. */
  failureDetail: string;
  /** Last iteration's data, for verify detail text. */
  lastData?: JsonObject;
}

function summarize(provider: ParticipantRecords): ProviderSummary {
  const records = provider.records;
  const datas = records.map((r) => r.data);

  const medians: Record<string, number | null> = {};
  for (const row of ROWS) {
    medians[row.key] = median(
      datas.map((d) => num(d, row.key)).filter((v): v is number => v !== null),
    );
  }

  const passed = datas.filter((d) => d?.verifyPassed === true).length;
  const supported = datas.some((d) => d?.snapshotSupported === true);
  const boxIdentity = datas.some((d) => d?.snapshotIsBoxIdentity === true);
  const error = datas
    .map((d) => d?.snapshotError)
    .find((e): e is string => typeof e === 'string' && e.length > 0);

  let failureDetail: string;
  if (!supported) {
    failureDetail = 'snapshot not supported by provider';
  } else if (boxIdentity) {
    failureDetail = 'box-identity snapshot (pause/resume) is not create+restore';
  } else if (passed === records.length && records.length > 0) {
    failureDetail = `${passed}/${records.length} iterations verified`;
  } else if (error) {
    failureDetail = short(error);
  } else {
    const last = datas[datas.length - 1];
    failureDetail = `verification failed — ${verifyDetail(last)}`;
  }

  return {
    name: provider.participant,
    iterations: records.length,
    passed,
    supported,
    boxIdentity,
    error,
    medians,
    failureDetail,
    lastData: datas[datas.length - 1],
  };
}

function cellFor(summary: ProviderSummary, rowKey: string): MatrixCell {
  const value = summary.medians[rowKey];

  if (ALWAYS_MS.has(rowKey)) {
    if (value !== null) {
      const detail =
        rowKey === 'snapshotCreateMs' && summary.boxIdentity
          ? 'box-identity snapshot (pause/resume)'
          : undefined;
      return { value, detail, state: 'data' };
    }
    return { detail: summary.supported ? 'step did not run' : summary.failureDetail, state: 'missing' };
  }

  // snapshotRestoreMs / verifyMs: only a verified lifecycle earns a number —
  // a returned-but-wrong restore would otherwise render a meaningless latency.
  if (summary.passed > 0) {
    if (value === null) {
      return { detail: summary.failureDetail, state: 'missing' };
    }
    const detail =
      summary.passed === summary.iterations
        ? verifyDetail(summary.lastData)
        : `${summary.passed}/${summary.iterations} iterations verified — ${summary.failureDetail}`;
    return { value, detail, state: 'data' };
  }
  return { detail: summary.failureDetail, state: 'missing' };
}

/**
 * Build the run-level `kind: 'matrix'` dataset from the leg's participants.
 * Each provider becomes one column; every snapshot stage a row.
 */
export function buildSnapshotMatrixDataset(participants: ParticipantRecords[]): MatrixDataset {
  const summaries = participants.map(summarize);

  const cells: MatrixDataset['cells'] = {};
  for (const row of ROWS) {
    cells[row.key] = {};
    for (const summary of summaries) {
      cells[row.key][summary.name] = cellFor(summary, row.key);
    }
  }

  const cards: MatrixDataset['cards'] = {};
  for (const summary of summaries) {
    const restore = summary.medians.snapshotRestoreMs;
    const verified = summary.iterations > 0 && summary.passed === summary.iterations;
    let headline: { label: string; value: number | string };
    if (verified && restore !== null) {
      headline = { label: 'Snapshot restore', value: restore };
    } else if (!summary.supported) {
      headline = { label: 'Result', value: 'not supported' };
    } else if (summary.passed === 0) {
      headline = { label: 'Result', value: 'failed' };
    } else {
      headline = { label: 'Result', value: `${summary.passed}/${summary.iterations} verified` };
    }

    const facts: { label: string; value: string }[] = [
      { label: 'Iterations verified', value: `${summary.passed}/${summary.iterations}` },
    ];
    if (summary.supported) {
      facts.push({ label: 'Verify', value: verifyDetail(summary.lastData) });
    } else {
      facts.push({ label: 'Reason', value: summary.failureDetail });
    }
    if (summary.error) facts.push({ label: 'Error', value: short(summary.error, 80) });

    cards[summary.name] = { headline, facts };
  }

  return {
    version: 1,
    rows: ROWS.map((row) => ({ ...row })),
    participants: summaries.map((s) => ({ key: s.name, label: s.name })),
    cells,
    cards,
  };
}

/** POST a run-level artifact and PUT its body to the returned upload URL. */
export async function uploadRunArtifact(
  benchmarkSlug: string,
  runId: string,
  input: { kind: string; name: string; contentType: string; metadata: Record<string, unknown> },
  body: string,
): Promise<void> {
  const base = (process.env.BENCHMARKS_PLATFORM_URL ?? 'https://platform.computesdk.com').replace(/\/+$/, '');
  const key = process.env.BENCHMARKS_PLATFORM_API_KEY;
  if (!key) throw new Error('BENCHMARKS_PLATFORM_API_KEY is required');

  const res = await fetch(
    `${base}/api/v1/benchmarks/${encodeURIComponent(benchmarkSlug)}/runs/${encodeURIComponent(runId)}/artifacts`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    },
  );
  if (!res.ok) throw new Error(`matrix artifact create failed: HTTP ${res.status}`);
  const created = (await res.json().catch(() => null)) as { uploadUrl?: string } | null;
  if (!created?.uploadUrl) throw new Error('matrix artifact create returned no uploadUrl');
  const put = await fetch(created.uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': input.contentType },
    body,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!put.ok) throw new Error(`matrix artifact upload failed: HTTP ${put.status}`);
}

/**
 * Build and upload this leg's matrix slice. Additive to the standard summary —
 * an upload failure is logged, never thrown. `--no-ingest` runs have no run to
 * attach to, so the payload is printed instead.
 */
export async function uploadSnapshotMatrix(
  outcome: BenchmarkRunOutcome,
  benchmarkSlug: string,
): Promise<void> {
  const body = JSON.stringify(buildSnapshotMatrixDataset(outcome.participants));
  if (outcome.runId === 'no-ingest') {
    console.log(`[matrix] no-ingest run — dataset payload (not uploaded):\n${body}`);
    return;
  }
  try {
    await uploadRunArtifact(
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
