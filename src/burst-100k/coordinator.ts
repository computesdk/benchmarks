import { config as loadDotenv } from 'dotenv';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { getProvider } from './providers.js';
import { log } from './logger.js';
import { PostgresSink } from './sinks/postgres.js';
import { TigrisSink } from './sinks/tigris.js';
import { LocalSink } from './sinks/local.js';
import { runBurst } from './runner.js';
import type { ProgressStats, MetricsSample, SandboxResult, FinalStats } from './types.js';

// dotenv only matters for local invocation. In production the env is set by
// launch.sh via `nsc ssh ... export VAR=...`.
loadDotenv();

const HEARTBEAT_INTERVAL_MS = 30_000;

type RunSink = {
  connect(): Promise<void>;
  bootstrap(
    provider: string,
    commit_sha: string,
    instance_id: string,
    artifact_prefix: string,
    shard?: { group_id: string; shard_index: number; shard_count: number },
  ): Promise<void>;
  write(result: SandboxResult): Promise<void>;
  heartbeat(stats: ProgressStats): Promise<void>;
  flush(): Promise<void>;
  complete(stats: FinalStats): Promise<void>;
  fail(message: string): Promise<void>;
  close(): Promise<void>;
};

type ArtifactSink = {
  writeResult(result: SandboxResult): void;
  writeHeartbeat(stats: ProgressStats & { ts: string }): Promise<void>;
  writeMetrics(samples: ReadonlyArray<unknown>): Promise<void>;
  writeMeta(meta: FinalStats & Record<string, unknown>): Promise<void>;
  writeLog(content: string): Promise<void>;
  close(): Promise<void>;
};

async function main() {
  const RUN_ID = required('RUN_ID');
  const PROVIDER = required('PROVIDER');
  const PG_URL = process.env.PG_URL;
  const SQLITE_PATH = process.env.SQLITE_PATH;
  if (!PG_URL && !SQLITE_PATH) {
    log.error('missing required env var: PG_URL or SQLITE_PATH');
    process.exit(1);
  }
  const TIGRIS_STORAGE_ENDPOINT = process.env.TIGRIS_STORAGE_ENDPOINT;
  const TIGRIS_STORAGE_BUCKET = process.env.TIGRIS_STORAGE_BUCKET;
  const TIGRIS_STORAGE_ACCESS_KEY_ID = process.env.TIGRIS_STORAGE_ACCESS_KEY_ID;
  const TIGRIS_STORAGE_SECRET_ACCESS_KEY = process.env.TIGRIS_STORAGE_SECRET_ACCESS_KEY;
  const useTigris = Boolean(
    TIGRIS_STORAGE_ENDPOINT &&
    TIGRIS_STORAGE_BUCKET &&
    TIGRIS_STORAGE_ACCESS_KEY_ID &&
    TIGRIS_STORAGE_SECRET_ACCESS_KEY,
  );

  const commit_sha = process.env.GITHUB_SHA ?? 'local';
  const instance_id = process.env.INSTANCE_ID ?? 'local';
  const localOutputDir = process.env.BURST_100K_OUTPUT_DIR ?? `burst-100k-runs/${RUN_ID}`;
  const artifact_prefix = useTigris
    ? `s3://${TIGRIS_STORAGE_BUCKET}/${RUN_ID}/`
    : `file://${localOutputDir}`;

  // Sharded-burst metadata. Set by scripts/burst-100k-launch-sharded.ts when
  // a logical burst is spread across multiple VMs. Unset for single-VM runs.
  const shard = (() => {
    const group_id = process.env.GROUP_ID;
    const shard_index_raw = process.env.SHARD_INDEX;
    const shard_count_raw = process.env.SHARD_COUNT;
    if (!group_id || shard_index_raw === undefined || shard_count_raw === undefined) {
      return undefined;
    }
    const shard_index = parseInt(shard_index_raw, 10);
    const shard_count = parseInt(shard_count_raw, 10);
    if (!Number.isFinite(shard_index) || !Number.isFinite(shard_count)) return undefined;
    return { group_id, shard_index, shard_count };
  })();

  const provider = getProvider(PROVIDER);

  // Allow env override of concurrencyTarget for local smoke tests.
  const override = process.env.CONCURRENCY_TARGET;
  if (override) {
    provider.concurrencyTarget = parseInt(override, 10);
  }

  log.phase('burst-100k coordinator starting');
  log.info(`run_id=${RUN_ID}`);
  log.info(`provider=${PROVIDER} (requires: ${provider.requiredEnvVars.join(', ') || 'none'})`);
  log.info(`concurrency=${provider.concurrencyTarget} timeout=${provider.perRequestTimeoutMs ?? 120_000}ms`);
  log.info(`commit_sha=${commit_sha} instance_id=${instance_id}`);
  log.info(`artifact_prefix=${artifact_prefix}`);
  if (override) log.info(`(CONCURRENCY_TARGET overridden via env)`);
  if (shard) {
    log.info(`shard ${shard.shard_index + 1}/${shard.shard_count} of group=${shard.group_id}`);
  }

  // Validate provider-specific requiredEnvVars
  log.phase('validating environment');
  const missing = provider.requiredEnvVars.filter(v => !process.env[v]);
  if (missing.length > 0) {
    const msg = `Missing required env vars for ${PROVIDER}: ${missing.join(', ')}`;
    log.error(msg);
    await tryRecordFailure(PG_URL, SQLITE_PATH, RUN_ID, msg);
    process.exit(1);
  }
  log.ok(`all ${provider.requiredEnvVars.length} provider env var(s) present`);

  log.phase('opening sinks');
  const runSink: RunSink = PG_URL
    ? new PostgresSink(PG_URL, RUN_ID)
    : await createSqliteSink(SQLITE_PATH!, RUN_ID);
  log.info(PG_URL ? 'Postgres: connecting...' : `SQLite: opening ${SQLITE_PATH}`);
  await runSink.connect();
  log.ok(PG_URL ? 'Postgres: connected' : 'SQLite: connected');
  log.info(`${PG_URL ? 'Postgres' : 'SQLite'}: bootstrapping runs row (idempotent)`);
  await runSink.bootstrap(PROVIDER, commit_sha, instance_id, artifact_prefix, shard);
  log.ok(`${PG_URL ? 'Postgres' : 'SQLite'}: runs row in place`);

  const artifacts: ArtifactSink = useTigris
    ? new TigrisSink(
      {
        endpoint: TIGRIS_STORAGE_ENDPOINT!,
        bucket: TIGRIS_STORAGE_BUCKET!,
        accessKeyId: TIGRIS_STORAGE_ACCESS_KEY_ID!,
        secretAccessKey: TIGRIS_STORAGE_SECRET_ACCESS_KEY!,
      },
      RUN_ID,
    )
    : new LocalSink(localOutputDir);
  log.ok(useTigris ? 'Tigris: sink ready' : `Local artifacts: writing to ${localOutputDir}`);

  let lastStats: ProgressStats = { done: 0, in_flight: 0, errors: 0 };
  // Track per-success-sandbox phase timings for the analytical outputs.
  //   ms                = allocate phase (sandbox.create() time, == latency_ms)
  //   first_command_ms  = readiness phase (`node -v` after create); null when cmd failed
  // Only fully-successful sandboxes contribute to the latency distributions —
  // a `partial` sandbox's create may have been fast but the sandbox died
  // mid-test, so its timings would skew the headline number.
  const okResults: Array<{ idx: number; ms: number; first_command_ms: number | null }> = [];
  // Track every sandbox's start/end (epoch ms) — including errors — so we
  // can reconstruct concurrency-over-time after the burst.
  const intervals: Array<{ start: number; end: number }> = [];
  // Counts per final status. `failure_class` (timeout/http_error/network_error)
  // is tracked separately so it works across all non-success statuses.
  const statusCounts = { success: 0, partial: 0, readiness_failed: 0, failed: 0 };
  // Sub-classification of create-failures only (status === 'failed').
  const createFailureClass = { timeout: 0, http_error: 0, network_error: 0 };

  // Periodically upload the coordinator's own stdout/stderr (redirected to a
  // file by launch.sh) to Tigris. Skipped silently when the env var is
  // unset (e.g. local `npm run bench:burst-100k:local` runs).
  const COORDINATOR_LOG_PATH = process.env.COORDINATOR_LOG_PATH;
  const uploadLog = async (): Promise<void> => {
    if (!COORDINATOR_LOG_PATH) return;
    try {
      const content = await fs.promises.readFile(COORDINATOR_LOG_PATH, 'utf-8');
      await artifacts.writeLog(content);
    } catch (err: any) {
      log.warn(`log-upload failed: ${err?.message ?? err}`);
    }
  };

  // System-metrics sampling. Event-loop delay needs an enabled histogram;
  // /proc/self/fd and /proc/net/sockstat are Linux-only (silent null elsewhere).
  const METRICS_SAMPLE_MS = 5_000;
  const eloopHist = monitorEventLoopDelay({ resolution: 20 });
  eloopHist.enable();
  const cpuBaseline = process.cpuUsage();
  const metricsStartedAt = Date.now();
  const metricsSamples: MetricsSample[] = [];

  const readSockstat = (): Record<string, number> | null => {
    try {
      const data = fs.readFileSync('/proc/net/sockstat', 'utf-8');
      const out: Record<string, number> = {};
      for (const line of data.split('\n')) {
        const idx = line.indexOf(':');
        if (idx < 0) continue;
        const section = line.slice(0, idx).trim().toLowerCase();
        const parts = line.slice(idx + 1).trim().split(/\s+/);
        for (let i = 0; i + 1 < parts.length; i += 2) {
          const n = parseInt(parts[i + 1], 10);
          if (!Number.isNaN(n)) out[`${section}_${parts[i]}`] = n;
        }
      }
      return out;
    } catch {
      return null;
    }
  };
  const countOpenFds = (): number | null => {
    try { return fs.readdirSync('/proc/self/fd').length; } catch { return null; }
  };
  const sampleMetrics = (): void => {
    const cpu = process.cpuUsage(cpuBaseline);
    const mem = process.memoryUsage();
    const load = os.loadavg();
    const sample: MetricsSample = {
      ts: new Date().toISOString(),
      uptime_ms: Date.now() - metricsStartedAt,
      cpu_user_us: cpu.user,
      cpu_system_us: cpu.system,
      mem_rss_mb: Math.round(mem.rss / 1024 / 1024),
      mem_heap_used_mb: Math.round(mem.heapUsed / 1024 / 1024),
      mem_heap_total_mb: Math.round(mem.heapTotal / 1024 / 1024),
      mem_external_mb: Math.round(mem.external / 1024 / 1024),
      event_loop_p50_ms: eloopHist.percentile(50) / 1e6,
      event_loop_p99_ms: eloopHist.percentile(99) / 1e6,
      event_loop_max_ms: eloopHist.max / 1e6,
      loadavg_1m: load[0],
      loadavg_5m: load[1],
      loadavg_15m: load[2],
      open_fds: countOpenFds(),
      sockstat: readSockstat(),
    };
    eloopHist.reset();
    metricsSamples.push(sample);
  };
  const metricsInterval = setInterval(sampleMetrics, METRICS_SAMPLE_MS);

  const heartbeat = setInterval(() => {
    const ts = new Date().toISOString();
    runSink.heartbeat(lastStats).catch(err => log.warn(`heartbeat:run-sink ${err.message}`));
    artifacts.writeHeartbeat({ ...lastStats, ts }).catch(err => log.warn(`heartbeat:artifacts ${err.message}`));
    uploadLog();
    if (metricsSamples.length > 0) {
      artifacts.writeMetrics(metricsSamples).catch(err => log.warn(`heartbeat:metrics ${err.message}`));
    }
    log.stat(`heartbeat done=${lastStats.done}/${provider.concurrencyTarget} in_flight=${lastStats.in_flight} errors=${lastStats.errors}`);
  }, HEARTBEAT_INTERVAL_MS);

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.phase(`${signal} received — flushing`);
    clearInterval(heartbeat);
    clearInterval(metricsInterval);
    try {
      await runSink.flush();
      await artifacts.close();
      await runSink.fail(`Process received ${signal} at done=${lastStats.done}/${provider.concurrencyTarget}`);
      await runSink.close();
      await uploadLog();
      if (metricsSamples.length > 0) await artifacts.writeMetrics(metricsSamples);
      log.ok('flushed all sinks');
    } catch (e: any) {
      log.error(`shutdown flush failed: ${e?.message ?? e}`);
    }
    process.exit(1);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  log.phase('initializing compute client');
  const compute = provider.createCompute();
  log.ok(`compute client ready for ${PROVIDER}`);

  try {
    log.phase(`burst — firing ${provider.concurrencyTarget} requests at t=0 (no stagger)`);
    await runBurst(provider, compute, {
      async onResult(result) {
        statusCounts[result.status]++;
        if (result.status === 'success') {
          okResults.push({
            idx: result.sandbox_idx,
            ms: result.latency_ms,
            first_command_ms: result.first_command_ms,
          });
        } else if (result.status === 'failed' && result.failure_class) {
          createFailureClass[result.failure_class]++;
        }
        intervals.push({
          start: Date.parse(result.started_at),
          end: Date.parse(result.completed_at),
        });
        artifacts.writeResult(result);
        await runSink.write(result);
      },
      onProgress(stats) {
        lastStats = stats;
      },
    });

    clearInterval(heartbeat);

    const latencies = okResults.map(r => r.ms).sort((a, b) => a - b);
    const pct = (q: number) =>
      latencies.length === 0 ? 0 : latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * q))];

    const final = {
      sandboxes_attempted: provider.concurrencyTarget,
      sandboxes_succeeded: statusCounts.success,
      partials: statusCounts.partial,
      readiness_failures: statusCounts.readiness_failed,
      failures: statusCounts.failed,
      timeouts: createFailureClass.timeout,
      http_errors: createFailureClass.http_error,
      network_errors: createFailureClass.network_error,
      p50_latency_ms: pct(0.5),
      p99_latency_ms: pct(0.99),
    };

    // Per-status counts for Tigris meta.json. Uses the wire status names so
    // the four-state taxonomy is visible at-a-glance in raw output.
    const status_histogram = {
      success: statusCounts.success,
      partial: statusCounts.partial,
      readiness_failed: statusCounts.readiness_failed,
      failed: statusCounts.failed,
    };
    // Sub-classification of create-failures only (sums to status_histogram.failed).
    const create_failure_class = {
      timeout: createFailureClass.timeout,
      http_error: createFailureClass.http_error,
      network_error: createFailureClass.network_error,
    };

    // Full latency distribution, written to Tigris meta.json only. Postgres
    // keeps just p50/p99 for cheap filtering; this is for retrospective
    // analysis of tail behaviour. `latency_distribution` covers the
    // allocate phase only — the "first_command" and combined "tti"
    // distributions are computed below.
    const distributionOf = (values: number[]) => {
      if (values.length === 0) return null;
      const sorted = [...values].sort((a, b) => a - b);
      const p = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
      return {
        count: sorted.length,
        min_ms:  sorted[0],
        p10_ms:  p(0.10),
        p25_ms:  p(0.25),
        p50_ms:  p(0.50),
        p75_ms:  p(0.75),
        p90_ms:  p(0.90),
        p95_ms:  p(0.95),
        p99_ms:  p(0.99),
        p999_ms: p(0.999),
        max_ms:  sorted[sorted.length - 1],
        mean_ms: Math.round(sorted.reduce((s, v) => s + v, 0) / sorted.length),
      };
    };
    const latency_distribution = distributionOf(latencies);
    const first_command_values = okResults
      .map(r => r.first_command_ms)
      .filter((v): v is number => v != null);
    const first_command_distribution = distributionOf(first_command_values);
    const tti_values = okResults
      .filter(r => r.first_command_ms != null)
      .map(r => r.ms + (r.first_command_ms as number));
    const tti_distribution = distributionOf(tti_values);

    // Submission-order segments: bucket OK results by sandbox_idx (the order
    // tasks were pushed onto the event loop at t=0). With no ramp, all
    // submissions happen within milliseconds, so this isolates whether the
    // provider's queueing favours earlier-submitted requests.
    const totalN = provider.concurrencyTarget;
    const segmentDefs = [
      { name: 'first_25pct',  lo: 0,                        hi: Math.floor(totalN * 0.25) },
      { name: 'middle_50pct', lo: Math.floor(totalN * 0.25), hi: Math.floor(totalN * 0.75) },
      { name: 'last_25pct',   lo: Math.floor(totalN * 0.75), hi: totalN },
    ];
    const submission_segments: Record<string, unknown> = {};
    for (const seg of segmentDefs) {
      const segLatencies = okResults
        .filter(r => r.idx >= seg.lo && r.idx < seg.hi)
        .map(r => r.ms)
        .sort((a, b) => a - b);
      const segPct = (q: number) =>
        segLatencies.length === 0 ? 0
          : segLatencies[Math.min(segLatencies.length - 1, Math.floor(segLatencies.length * q))];
      submission_segments[seg.name] = {
        idx_range: [seg.lo, seg.hi - 1],
        count_ok: segLatencies.length,
        p50_ms: segPct(0.50),
        p95_ms: segPct(0.95),
        p99_ms: segPct(0.99),
        max_ms: segLatencies.length ? segLatencies[segLatencies.length - 1] : 0,
        mean_ms: segLatencies.length
          ? Math.round(segLatencies.reduce((s, v) => s + v, 0) / segLatencies.length)
          : 0,
      };
    }

    // Concurrency-over-time. Build an interval-overlap timeline so we can
    // tell where the burst peaked and how long the provider stayed saturated.
    // All intervals are relative to the earliest start.
    let concurrency_summary: unknown = null;
    let concurrency_timeline: Array<{ t_ms: number; active: number }> = [];
    if (intervals.length > 0) {
      const minStart = intervals.reduce((m, i) => Math.min(m, i.start), Infinity);
      const maxEnd   = intervals.reduce((m, i) => Math.max(m, i.end),   -Infinity);
      const durationMs = maxEnd - minStart;

      // Event stream: +1 at start, -1 at end (rel to minStart)
      const events: Array<{ t: number; delta: number }> = [];
      for (const i of intervals) {
        events.push({ t: i.start - minStart, delta: 1 });
        events.push({ t: i.end   - minStart, delta: -1 });
      }
      events.sort((a, b) => a.t - b.t || b.delta - a.delta);

      // Exact peak detection at events; timeline sampled at 1 Hz.
      let active = 0, peakActive = 0, peakT = 0;
      const SAMPLE_MS = 1000;
      let ei = 0;
      for (let t = 0; t <= durationMs; t += SAMPLE_MS) {
        while (ei < events.length && events[ei].t <= t) {
          active += events[ei].delta;
          if (active > peakActive) { peakActive = active; peakT = events[ei].t; }
          ei++;
        }
        concurrency_timeline.push({ t_ms: t, active });
      }
      // Flush any remaining events past the last sample (still tracks peak)
      while (ei < events.length) {
        active += events[ei].delta;
        if (active > peakActive) { peakActive = active; peakT = events[ei].t; }
        ei++;
      }

      const meanActive = concurrency_timeline.reduce((s, p) => s + p.active, 0)
        / Math.max(1, concurrency_timeline.length);
      concurrency_summary = {
        peak_concurrent: peakActive,
        peak_t_ms: peakT,
        mean_concurrent: Math.round(meanActive),
        total_run_ms: durationMs,
        sample_interval_ms: SAMPLE_MS,
      };
    }

    // System-metrics summary for the meta.json. The full series is in
    // <run_id>/metrics.jsonl; this is the at-a-glance view.
    clearInterval(metricsInterval);
    sampleMetrics();
    const metrics_summary = metricsSamples.length === 0 ? null : {
      sample_count: metricsSamples.length,
      sample_interval_ms: METRICS_SAMPLE_MS,
      peak_mem_rss_mb: Math.max(...metricsSamples.map(s => s.mem_rss_mb)),
      peak_mem_heap_used_mb: Math.max(...metricsSamples.map(s => s.mem_heap_used_mb)),
      peak_event_loop_p99_ms: Math.max(...metricsSamples.map(s => s.event_loop_p99_ms)),
      peak_event_loop_max_ms: Math.max(...metricsSamples.map(s => s.event_loop_max_ms)),
      peak_open_fds: Math.max(...metricsSamples.map(s => s.open_fds ?? 0)),
      peak_tcp_inuse: Math.max(...metricsSamples.map(s => s.sockstat?.tcp_inuse ?? 0)),
      peak_tcp_tw: Math.max(...metricsSamples.map(s => s.sockstat?.tcp_tw ?? 0)),
      total_cpu_user_us: metricsSamples[metricsSamples.length - 1].cpu_user_us,
      total_cpu_system_us: metricsSamples[metricsSamples.length - 1].cpu_system_us,
    };

    log.phase('flushing sinks and writing summary');
    log.info('Run sink: flushing remaining sandbox_results batch');
    await runSink.flush();
    log.info('Artifacts: closing raw.jsonl');
    await artifacts.close();
    log.info('Artifacts: writing metrics.jsonl');
    await artifacts.writeMetrics(metricsSamples);
    log.info('Artifacts: writing meta.json');
    await artifacts.writeMeta({
      ...final,
      latency_distribution,
      first_command_distribution,
      tti_distribution,
      status_histogram,
      create_failure_class,
      submission_segments,
      concurrency_summary,
      concurrency_timeline,
      metrics_summary,
      run_id: RUN_ID,
      provider: PROVIDER,
      ended_at: new Date().toISOString(),
      ...(shard ? { group_id: shard.group_id, shard_index: shard.shard_index, shard_count: shard.shard_count } : {}),
    });
    log.info('Run sink: marking run done with final stats');
    await runSink.complete(final);
    await runSink.close();

    log.phase('run complete');
    log.ok(`${final.sandboxes_succeeded}/${final.sandboxes_attempted} succeeded ` +
      `(${((final.sandboxes_succeeded / final.sandboxes_attempted) * 100).toFixed(1)}%) ` +
      `partial=${final.partials} readiness_failed=${final.readiness_failures} failed=${final.failures}`);
    log.info(`latency p50=${final.p50_latency_ms}ms p99=${final.p99_latency_ms}ms`);
    if (final.timeouts + final.http_errors + final.network_errors > 0) {
      log.warn(`create-failure class: timeouts=${final.timeouts} http_errors=${final.http_errors} network_errors=${final.network_errors}`);
    }
    // Final log upload AFTER the completion message so it ends up in Tigris.
    await uploadLog();
  } catch (err: any) {
    clearInterval(heartbeat);
    clearInterval(metricsInterval);
    log.error(`run failed: ${err?.message ?? err}`);
    try {
      await runSink.flush();
      await artifacts.close();
      await runSink.fail(err?.message ?? String(err));
      await runSink.close();
      await uploadLog();
      if (metricsSamples.length > 0) await artifacts.writeMetrics(metricsSamples);
    } catch (e: any) {
      log.error(`failed to record failure: ${e?.message ?? e}`);
    }
    process.exit(1);
  }
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    log.error(`missing required env var: ${name}`);
    process.exit(1);
  }
  return v;
}

async function createSqliteSink(sqlitePath: string, runId: string): Promise<RunSink> {
  const { SqliteSink } = await import('./sinks/sqlite.js');
  return new SqliteSink(sqlitePath, runId);
}

async function tryRecordFailure(
  pgUrl: string | undefined,
  sqlitePath: string | undefined,
  runId: string,
  message: string,
): Promise<void> {
  try {
    const sink = pgUrl
      ? new PostgresSink(pgUrl, runId)
      : sqlitePath
        ? await createSqliteSink(sqlitePath, runId)
        : null;
    if (!sink) return;
    await sink.connect();
    await sink.fail(message);
    await sink.close();
  } catch (e: any) {
    log.error(`could not write failure row: ${e?.message ?? e}`);
  }
}

main().catch(err => {
  log.error(`crashed: ${err?.stack ?? err}`);
  process.exit(1);
});
