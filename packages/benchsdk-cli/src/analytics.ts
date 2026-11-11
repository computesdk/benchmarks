import { writeFile } from 'node:fs/promises';
import { BenchmarkApiError } from '@benchsdk/api';
import type {
  BenchmarkMatrix,
  BenchmarkModelIndex,
  BenchmarkRankStat,
  BenchmarkRunOverview,
  BenchmarkRunOverviewInput,
  BenchmarkRunResults,
  BenchmarkRunTaskResults,
  BenchmarkRunTimeline,
  BenchmarkRunWorkerSummary,
} from '@benchsdk/api';
import { createApiClient } from './client.js';
import { isJsonOutput, optionChoice, optionNumber, optionString, type SubcommandOptions } from './options.js';
import { printData, type OutputOptions } from './output.js';

type Overrides = { baseUrl?: string; apiKey?: string; org?: string };

export const RANK_STATS: readonly BenchmarkRankStat[] = ['min', 'median', 'p95', 'p99', 'max'];

function ms(value: number | null | undefined): number | string {
  if (value === null || value === undefined) return '';
  return value < 10 ? Number(value.toFixed(2)) : Math.round(value);
}

function rate(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function positiveInteger(options: SubcommandOptions, key: string): number | undefined {
  const value = optionNumber(options, key);
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 1) throw new Error(`--${key} must be a whole number of at least 1`);
  return value;
}

function requireArgs(args: readonly (string | undefined)[], usage: string): string[] {
  if (args.some((arg) => !arg)) throw new Error(`Usage: ${usage}`);
  return args as string[];
}

/** `bench matrix <slug>`: a matrix index benchmark's newest dataset (`GET /benchmarks/{slug}/matrix`). */
export async function handleMatrix(
  slugArg: string | undefined,
  options: SubcommandOptions,
  overrides: Overrides,
  output: OutputOptions,
): Promise<void> {
  const [slug] = requireArgs([slugArg], 'bench matrix <benchmark-slug> [--source-org <slug>]');
  const { api } = await createApiClient(overrides);
  const matrix = await api.getBenchmarkMatrix(slug, { sourceOrg: optionString(options, 'source-org') });
  if (isJsonOutput(output)) {
    printData(matrix, output);
    return;
  }
  printMatrix(matrix);
}

function printMatrix({ benchmark, run, spec, dataset }: BenchmarkMatrix): void {
  console.log(`${benchmark.name} — run ${run.id} (${run.startedAt}) | ${spec.cell.unit}, ${spec.cell.direction}`);
  if (dataset.rows.length === 0) {
    console.log('No rows.');
    return;
  }
  const rows = dataset.rows.map((row) => {
    const cells = dataset.cells[row.key] ?? {};
    return Object.fromEntries([
      ['row', row.label],
      ...dataset.participants.map((participant) => {
        const cell = cells[participant.key];
        return [participant.label, cell?.state === 'data' && cell.value !== undefined ? Number(cell.value.toFixed(spec.cell.decimals)) : ''];
      }),
    ]);
  });
  console.table(rows);
}

/** `bench model-index <slug>`: a model index benchmark's newest results (`GET /benchmarks/{slug}/model-index`). */
export async function handleModelIndex(
  slugArg: string | undefined,
  options: SubcommandOptions,
  overrides: Overrides,
  output: OutputOptions,
): Promise<void> {
  const [slug] = requireArgs([slugArg], 'bench model-index <benchmark-slug> [--source-org <slug>]');
  const { api } = await createApiClient(overrides);
  const index = await api.getModelIndex(slug, { sourceOrg: optionString(options, 'source-org') });
  if (isJsonOutput(output)) {
    printData(index, output);
    return;
  }
  printModelIndex(index);
}

function printModelIndex({ benchmark, run, matrix }: BenchmarkModelIndex): void {
  console.log(`${benchmark.name} — run ${run.id} (${run.startedAt}) | ${matrix.rows.length} models, ${matrix.gateways.length} gateways`);
  if (matrix.rows.length === 0) return;
  console.table(
    matrix.rows.map((row) => ({
      model: row.key,
      name: row.name,
      author: row.author,
      gateways: row.gatewayCount,
      ...(row.context !== undefined ? { context: row.context } : {}),
    })),
  );
}

export function overviewInput(options: SubcommandOptions): BenchmarkRunOverviewInput {
  return {
    rankBy: optionString(options, 'rank-by'),
    stat: optionChoice(options, 'stat', RANK_STATS),
    dimension: optionString(options, 'dimension'),
  };
}

function hasOverviewInput(input: BenchmarkRunOverviewInput): boolean {
  return input.rankBy !== undefined || input.stat !== undefined || input.dimension !== undefined;
}

/**
 * `bench runs show <slug> <runId>`: the run, then its Overview (stats and
 * participant ranking). A platform without the overview route (404) or an
 * analytics outage (503) leaves the overview out with a note, unless an
 * overview flag asked for it.
 */
export async function handleRunsShow(
  slug: string,
  runId: string,
  options: SubcommandOptions,
  overrides: Overrides,
  output: OutputOptions,
): Promise<void> {
  const input = overviewInput(options);
  const { api } = await createApiClient(overrides);
  const [run, overview] = await Promise.all([
    api.getRun(slug, runId),
    api.getRunOverview(slug, runId, input).catch((err: unknown) => {
      if (!hasOverviewInput(input) && err instanceof BenchmarkApiError && (err.status === 404 || err.status === 503)) {
        return { unavailable: err.status === 503 ? 'analytics unavailable' : 'not served by this platform' };
      }
      throw err;
    }),
  ]);
  const available = 'ranking' in overview ? overview : null;
  if (isJsonOutput(output)) {
    printData({ ...run, overview: available }, output);
    return;
  }
  printData(run, output);
  if (available) printOverview(available);
  else console.log(`Overview: ${(overview as { unavailable: string }).unavailable}.`);
}

function printOverview({ progress, overall, customMetrics, ranking, dimension }: BenchmarkRunOverview): void {
  const { rankBy } = ranking;
  console.log(
    `Overview — ${progress.done}/${progress.total} tasks${progress.errors ? ` (${progress.errors} errors)` : ''} | overall: ${overall.successCount}/${overall.taskCount} ok (${rate(overall.successRate)}) | ranked by ${rankBy.label} (${rankBy.stat}, ${rankBy.direction})${ranking.dimension ? ` in ${dimension?.label ?? 'dimension'} ${ranking.dimension}` : ''}`,
  );
  const metricKeys = Object.keys(customMetrics);
  if (metricKeys.length > 0) {
    console.log(`Custom metrics (median): ${metricKeys.map((key) => `${key}=${customMetrics[key] ?? ''}`).join(', ')}`);
  }
  if (ranking.participants.length === 0) {
    console.log('No participants.');
    return;
  }
  console.table(
    ranking.participants.map((p) => ({
      rank: p.rank,
      participant: p.participantSlug,
      ...(p.dimension !== null ? { dimension: p.dimension } : {}),
      value: ms(p.value),
      tasks: p.taskCount,
      ok: p.successCount,
      err: p.errorCount,
      'ok%': rate(p.successRate),
      p50ms: ms(p.latencyMs.p50),
      p95ms: ms(p.latencyMs.p95),
      ...p.customMetrics,
    })),
  );
  if (ranking.options.length > 1) {
    console.log(`Rank by (--rank-by): ${ranking.options.map((option) => option.value).join(', ')}`);
  }
}

/** `bench results <slug> --run <id> --timeline`: event rate and concurrency over time. */
export function printTimeline(timeline: BenchmarkRunTimeline): void {
  const { eventRate, concurrency } = timeline;
  console.log(`Event rate per ${eventRate.bucketMs}ms bucket`);
  if (eventRate.buckets.length === 0) console.log('No events.');
  else
    console.table(
      eventRate.buckets.map((b) => ({
        participant: b.participantSlug,
        tMs: b.tMs,
        completed: b.completed,
        succeeded: b.succeeded,
        failed: b.failed,
      })),
    );
  console.log(
    `Concurrency: ${concurrency.points.length} points from ${concurrency.heartbeatCount} heartbeats${concurrency.firstRecordedAt ? ` since ${concurrency.firstRecordedAt}` : ''} (--json lists them)`,
  );
}

/** `bench results <slug> --run <id> --tasks`: latency per task-index bucket, and failures. */
export function printTaskResults(results: BenchmarkRunTaskResults): void {
  console.log(`Tasks in buckets of ${results.bucketSize}`);
  if (results.buckets.length === 0) console.log('No tasks.');
  else
    console.table(
      results.buckets.map((b) => ({
        participant: b.participantSlug,
        tasks: `${b.bucketStart}-${b.bucketEnd}`,
        count: b.taskCount,
        ok: b.successCount,
        err: b.errorCount,
        p50ms: ms(b.latencyMs.p50),
        p95ms: ms(b.latencyMs.p95),
        maxms: ms(b.latencyMs.max),
      })),
    );
  if (results.failures.length > 0) {
    console.log('Failures:');
    console.table(
      results.failures.map((f) => ({ participant: f.participantSlug, task: f.taskIndex, error: f.errorCode ?? '' })),
    );
  }
}

/** The `--timeline`/`--tasks` views of `bench results`; false when neither flag was given. */
export async function handleResultsView(
  slug: string,
  options: SubcommandOptions,
  overrides: Overrides,
  output: OutputOptions,
): Promise<boolean> {
  const timeline = options.timeline === true;
  const tasks = options.tasks === true;
  const viewFlags: Record<string, 'timeline' | 'tasks'> = {
    'bucket-ms': 'timeline',
    'bucket-size': 'tasks',
    'failure-limit': 'tasks',
  };
  for (const [flag, view] of Object.entries(viewFlags)) {
    if (options[flag] !== undefined && !(view === 'timeline' ? timeline : tasks)) {
      throw new Error(`--${flag} needs --${view}`);
    }
  }
  if (!timeline && !tasks) return false;
  if (timeline && tasks) throw new Error('--timeline and --tasks are separate views; pass one');
  const runId = optionString(options, 'run');
  if (!runId) throw new Error(`--${timeline ? 'timeline' : 'tasks'} needs --run <id>`);
  const extra = Object.keys(options).find(
    (key) => !['run', 'timeline', 'tasks', 'bucket-ms', 'bucket-size', 'failure-limit'].includes(key),
  );
  if (extra) throw new Error(`--${extra} does not apply to --${timeline ? 'timeline' : 'tasks'}`);

  const { api } = await createApiClient(overrides);
  if (timeline) {
    const result = await api.getRunTimeline(slug, runId, { bucketMs: positiveInteger(options, 'bucket-ms') });
    if (isJsonOutput(output)) printData(result, output);
    else printTimeline(result);
  } else {
    const result = await api.getRunTaskResults(slug, runId, {
      bucketSize: positiveInteger(options, 'bucket-size'),
      failureLimit: positiveInteger(options, 'failure-limit'),
    });
    if (isJsonOutput(output)) printData(result, output);
    else printTaskResults(result);
  }
  return true;
}

/** Custom metric medians printed under `bench results --run` tables. */
export function printCustomMetrics(customMetrics: BenchmarkRunResults['customMetrics']): void {
  if (!customMetrics || Object.keys(customMetrics.overall).length === 0) return;
  console.log('Custom metrics (median):');
  console.table([
    { participant: '(run)', ...customMetrics.overall },
    ...customMetrics.participants.map((p) => ({ participant: p.participantSlug, ...p.metrics })),
  ]);
}

function workerRow(worker: BenchmarkRunWorkerSummary): Record<string, unknown> {
  return {
    worker: worker.workerIndex,
    id: worker.workerId,
    participant: worker.participantSlug,
    status: worker.status,
    tasks: `${worker.taskIndexStart}-${worker.taskIndexEnd}`,
    progress: `${worker.progressDone}/${worker.progressTotal}`,
    errors: worker.progressErrors,
    artifacts: worker.artifacts.length,
  };
}

/** `bench workers <slug> <runId>`: every worker of a run (`GET …/runs/{runId}/workers`). */
export async function handleWorkers(
  slugArg: string | undefined,
  runIdArg: string | undefined,
  options: SubcommandOptions,
  overrides: Overrides,
  output: OutputOptions,
): Promise<void> {
  const [slug, runId] = requireArgs([slugArg, runIdArg], 'bench workers <benchmark-slug> <runId> [--participant <slug>]');
  const { api } = await createApiClient(overrides);
  const workers = await api.listRunWorkers(slug, runId, { participant: optionString(options, 'participant') });
  if (isJsonOutput(output)) {
    printData(workers, output);
    return;
  }
  if (workers.length === 0) {
    console.log('No workers.');
    return;
  }
  console.table(workers.map(workerRow));
}

function isTextContentType(contentType: string | null | undefined): boolean {
  if (!contentType) return false;
  const type = contentType.toLowerCase();
  return type.startsWith('text/') || type.includes('json') || type.includes('xml') || type.includes('ndjson');
}

/**
 * `bench artifacts download <slug> <runId> <workerId> <artifactId>`: the
 * artifact's bytes as stored (gzip stays gzip), to `--out <file>` or stdout.
 */
export async function handleArtifactsDownload(
  args: readonly (string | undefined)[],
  options: SubcommandOptions,
  overrides: Overrides,
  output: OutputOptions,
  stdout: { isTTY?: boolean; write(chunk: Uint8Array, callback: (error?: Error | null) => void): unknown } = process.stdout,
): Promise<void> {
  const [slug, runId, workerId, artifactId] = requireArgs(
    [args[0], args[1], args[2], args[3]],
    'bench artifacts download <benchmark-slug> <runId> <workerId> <artifactId> [--out <file>]',
  );
  const out = optionString(options, 'out');
  if (!out && isJsonOutput(output)) throw new Error('--json describes a written file: pass --out <file>');
  const { api } = await createApiClient(overrides);
  const { artifact, bytes } = await api.downloadWorkerArtifactBytes(slug, runId, workerId, artifactId);
  if (out) {
    await writeFile(out, bytes);
    if (isJsonOutput(output)) printData({ path: out, bytes: bytes.byteLength, artifact }, output);
    else console.log(`Wrote ${bytes.byteLength} bytes to ${out}${artifact.contentType ? ` (${artifact.contentType})` : ''}`);
    return;
  }
  if (stdout.isTTY && !isTextContentType(artifact.contentType)) {
    throw new Error(`Artifact ${artifactId} is ${artifact.contentType ?? 'of unknown type'}; pass --out <file> or pipe stdout`);
  }
  // The CLI exits as soon as the command returns: wait for the bytes to be
  // handed off, or a pipe applying backpressure gets a truncated artifact.
  await new Promise<void>((resolve, reject) => {
    stdout.write(bytes, (error) => (error ? reject(error) : resolve()));
  });
}

