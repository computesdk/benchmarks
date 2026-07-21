import { config as loadDotenv } from 'dotenv';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { BenchReporter } from './bench-reporter.js';
import { getProvider } from './providers.js';
import { log } from './logger.js';
import { BurstLifecycle } from './runner.js';
import type { ProgressStats, MetricsSample, GlobalConcurrency } from './types.js';

// dotenv only matters for local invocation. In production the env is set by
// scripts/start.ts via the uploaded /root/start.sh (`export VAR=...`).
loadDotenv();

async function main() {
  const RUN_ID = required('RUN_ID');
  const PROVIDER = required('PROVIDER');

  const commit_sha = process.env.GITHUB_SHA ?? 'local';
  const instance_id = process.env.INSTANCE_ID ?? 'local';

  // Sharded-burst metadata. Set by src/scale/scripts/start.ts when a
  // logical burst is spread across multiple VMs. Unset for single-VM runs.
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
  const benchApiKey = process.env.COMPUTESDK_API_KEY ?? process.env.COMPUTESDK_ADMIN_API_KEY;
  const LABEL = process.env.LABEL ?? `scale.${PROVIDER}`;

  // Platform orchestration target. start.ts creates the run + plans the workers,
  // then injects these so each VM claims one worker assignment. The per-shard
  // outputs (raw/meta/metrics/log) are uploaded as worker artifacts, so when
  // unset (a bare local run with no run created) those outputs are NOT persisted
  // anywhere — there is no claimed worker to attach artifacts to.
  const BENCHMARK_SLUG = process.env.BENCHMARK_SLUG ?? 'scale';
  const BENCHMARK_RUN_ID = process.env.BENCHMARK_RUN_ID;
  const PARTICIPANT_SLUG = process.env.PARTICIPANT_SLUG ?? PROVIDER;

  // Allow env override of concurrencyTarget for local smoke tests.
  const override = process.env.CONCURRENCY_TARGET;
  if (override) {
    provider.concurrencyTarget = parseInt(override, 10);
  }

  log.phase('scale coordinator starting');
  log.info(`run_id=${RUN_ID}`);
  log.info(`label=${LABEL}`);
  log.info(`provider=${PROVIDER} (requires: ${provider.requiredEnvVars.join(', ') || 'none'})`);
  log.info(`concurrency=${provider.concurrencyTarget} timeout=${provider.perRequestTimeoutMs ?? 120_000}ms`);
  log.info(`commit_sha=${commit_sha} instance_id=${instance_id}`);
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
    process.exit(1);
  }
  log.ok(`all ${provider.requiredEnvVars.length} provider env var(s) present`);

  // Per-sandbox raw result lines, buffered in memory and uploaded once as the
  // raw.jsonl worker artifact at the end (the platform artifact API is a single
  // create+PUT, not a stream). Bounded by concurrencyTarget, same magnitude as
  // okResults/intervals already held below.
  const rawLines: string[] = [];

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
  const statusCounts = { success: 0, partial: 0, readiness_failed: 0, failed: 0, worker_ready_failed: 0 };
  // Sub-classification of create-failures only (status === 'failed').
  const createFailureClass = { timeout: 0, http_error: 0, network_error: 0 };
  const emittedSegmentCounts = { first_25pct: 0, middle_50pct: 0, last_25pct: 0 };

  // Claim one platform worker for this VM. Reporting is best-effort: a missing
  // key/run, an unclaimable worker, or any telemetry error degrades gracefully
  // rather than failing the burst. Note: per-shard outputs are now worker
  // artifacts, so with no claimed worker they are not persisted anywhere.
  const bench = benchApiKey && BENCHMARK_RUN_ID
    ? await BenchReporter.claim({
        apiKey: benchApiKey,
        benchmarkSlug: BENCHMARK_SLUG,
        runId: BENCHMARK_RUN_ID,
        participantSlug: PARTICIPANT_SLUG,
        processKind: 'container',
        processKey: instance_id,
      })
    : null;

  // The platform plans each worker's task range; honour its count when present
  // so progressTotal and global task indexes line up across the fleet. Falls
  // back to the env-provided concurrencyTarget for unreported runs.
  const burstSize = bench?.taskCount ?? provider.concurrencyTarget;
  if (bench && bench.taskCount !== provider.concurrencyTarget) {
    log.warn(
      `bench: planned task count ${bench.taskCount} != CONCURRENCY_TARGET ` +
      `${provider.concurrencyTarget}; using planned count for the burst`,
    );
    provider.concurrencyTarget = burstSize;
  }

  // System-metrics sampling. Event-loop delay needs an enabled histogram;
  // /proc/self/fd and /proc/net/sockstat are Linux-only (silent null elsewhere).
  // Bursts often complete in 1-3s, so sample frequently enough to capture a
  // real timeline rather than a single end-of-run snapshot.
  const METRICS_SAMPLE_MS = 200;
  // Platform heartbeat cadence — a network call, so kept coarser than metrics sampling.
  const HEARTBEAT_MS = 5_000;
  const eloopHist = monitorEventLoopDelay({ resolution: 20 });
  eloopHist.enable();
  const cpuBaseline = process.cpuUsage();
  const metricsStartedAt = Date.now();
  const metricsSamples: MetricsSample[] = [];
  let liveSandboxCount: number | undefined;

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
  const sampleMetrics = (): MetricsSample => {
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
    return sample;
  };
  // The coordinator_metrics stream has no equivalent in the orchestrator API
  // (no generic metric ingestion), so the full system-health series is uploaded
  // as the metrics.jsonl artifact at the end.
  const metricsInterval = setInterval(() => {
    sampleMetrics();
  }, METRICS_SAMPLE_MS);
  // Platform heartbeat — progress + in-flight concurrency, surfaced via getRunTimeline.
  const heartbeatInterval = setInterval(() => {
    if (bench) void bench.heartbeat(lastStats.in_flight, liveSandboxCount);
  }, HEARTBEAT_MS);

  // Upload the per-shard outputs as worker artifacts (replaces the old Tigris
  // sink). Requires a claimed worker — with no platform run there is nowhere to
  // attach artifacts, so the outputs are not persisted (artifacts-only mode).
  // `meta` is omitted on the crash/shutdown paths where the summary isn't built.
  const uploadArtifacts = async (meta?: Record<string, unknown>): Promise<void> => {
    if (!bench) {
      log.warn('artifacts-only mode: no claimed worker — per-shard outputs NOT persisted');
      return;
    }
    const ndjson = (rows: ReadonlyArray<unknown>): string =>
      rows.length ? rows.map(r => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n' : '';
    await bench.uploadArtifact('raw-results', 'raw.jsonl', 'application/x-ndjson', ndjson(rawLines));
    if (meta) {
      await bench.uploadArtifact('summary', 'meta.json', 'application/json', JSON.stringify(meta, null, 2));
    }
    await bench.uploadArtifact('system-metrics', 'metrics.jsonl', 'application/x-ndjson', ndjson(metricsSamples));
    await bench.uploadArtifact('log', 'coordinator.log', 'text/plain; charset=utf-8', log.dump());
  };

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.phase(`${signal} received — flushing`);
    clearInterval(metricsInterval);
    clearInterval(heartbeatInterval);
    try {
      await uploadArtifacts();
      if (bench) await bench.finish(true);
      log.ok('flushed artifacts');
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
  if (benchApiKey) {
    log.info('bench ingest enabled');
  }

  const pauseMs = (() => {
    const raw = process.env.LIFECYCLE_PAUSE_MS;
    if (!raw) return 0;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  })();
  const barrierTimeoutMs = (() => {
    const raw = process.env.SCALE_BARRIER_TIMEOUT_MS;
    if (!raw) return 15 * 60_000;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 15 * 60_000;
  })();

  try {
    let flow!: BurstLifecycle;
    flow = new BurstLifecycle(provider, compute, {
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
        const segmentOf = (idx: number): 'first_25pct' | 'middle_50pct' | 'last_25pct' => {
          const n = provider.concurrencyTarget;
          const normalized = ((idx % n) + n) % n;
          const q1 = Math.floor(n * 0.25);
          const q3 = Math.floor(n * 0.75);
          if (normalized < q1) return 'first_25pct';
          if (normalized < q3) return 'middle_50pct';
          return 'last_25pct';
        };
        const submission_segment = segmentOf(result.sandbox_idx);
        emittedSegmentCounts[submission_segment]++;

        // Stream the per-sandbox result to the platform as a task record. The
        // four-state status, create-failure class and submission segment ride
        // along in status/errorCode/data so getRunResults / getRunTaskResults
        // can roll them up; the raw.jsonl artifact remains the lossless record.
        bench?.recordResult(result, {
          submission_segment,
          failure_class: result.status === 'failed' ? result.failure_class : null,
        });
        rawLines.push(JSON.stringify(result));
      },
      onProgress(stats) {
        lastStats = stats;
        if (liveSandboxCount !== undefined) liveSandboxCount = flow.countLiveSurvivors();
        bench?.setStats(stats);
      },
    });

    // Two-phase, barriered burst (see runner.ts). Every stage fires all
    // `burstSize` task indexes at t=0 (concurrency == iterations, no pool) and
    // we await the whole stage before the next — this is the global barrier the
    // success/partial distinction depends on. The per-sandbox methods catch
    // their own errors (recording status + emitting), so a stage never throws
    // from a sandbox failure; `destroy` therefore always runs (the old
    // `runOnFailed` behaviour) and survivors are torn down regardless of phase-1
    // outcome.
    const indices = Array.from({ length: burstSize }, (_, i) => i);
    const refreshLiveSandboxes = (): number | undefined => {
      if (liveSandboxCount === undefined) return undefined;
      liveSandboxCount = flow.countLiveSurvivors();
      return liveSandboxCount;
    };
    const runStage = async (
      fn: (idx: number) => Promise<void>,
      liveSample: (() => number | undefined) | undefined = refreshLiveSandboxes,
    ): Promise<void[]> => {
      const promises = indices.map(fn);
      if (bench) await bench.heartbeat(lastStats.in_flight, liveSample?.());
      const results = await Promise.all(promises);
      if (bench) await bench.heartbeat(lastStats.in_flight, liveSample?.());
      return results;
    };

    if (bench) {
      log.phase(`create barrier — waiting for all workers (timeout=${barrierTimeoutMs}ms)`);
      await bench.waitForStepReady('create.barrier', barrierTimeoutMs);
    } else {
      log.warn('create barrier skipped: no claimed bench worker');
    }

    log.phase(`create — firing ${burstSize} requests at t=0 (no stagger)`);
    liveSandboxCount = bench ? 0 : undefined;
    await runStage((i) => flow.createOne(i));
    await runStage((i) => flow.execInitialOne(i));

    // True fleet-wide peak concurrency, measured at the ready-barrier hold.
    // Null on bare local runs (no claimed worker, so no aggregate to read).
    let global_concurrency: GlobalConcurrency | null = null;
    if (bench) {
      const survivors = flow.countSurvivors();
      liveSandboxCount = survivors;
      // Arrival barrier: report the full intended count (the default `active`),
      // NOT the live survivor count. This is a *worker*-level barrier — every
      // worker reaches this line regardless of how many of its sandboxes failed,
      // so the aggregate hits target on arrival. Reporting `survivors` instead
      // would make the aggregate fall short of target on any failure and the
      // platform's `active >= target` gate would never fire (deadlock → timeout).
      log.phase(`ready barrier — ${survivors}/${burstSize} alive; waiting for all workers`);
      try {
        // At release every shard is holding simultaneously, so the platform's
        // aggregated in-flight count is the true fleet-wide live concurrency.
        const hold = await bench.waitForStepReady('ready.barrier', barrierTimeoutMs, 1_000, undefined, survivors);
        global_concurrency = {
          peak_concurrent: hold.globalInFlight ?? survivors,
          target: hold.globalTotal,
          source: hold.globalInFlight != null ? 'platform' : 'unavailable',
          measured_at: hold.measuredAt,
        };
        log.ok(`global concurrency at hold: ${global_concurrency.peak_concurrent}/${global_concurrency.target} ` +
          `alive across all shards (source=${global_concurrency.source})`);
        await bench.heartbeat(lastStats.in_flight, refreshLiveSandboxes());
      } catch (err) {
        log.error('ready barrier failed — destroying surviving sandboxes before exit');
        await Promise.all(indices.map(i => flow.destroyOne(i)));
        throw err;
      }
    }

    if (pauseMs > 0) {
      log.phase(`pause — waiting ${pauseMs}ms`);
      await flow.pause(pauseMs);
      if (bench) await bench.heartbeat(lastStats.in_flight, refreshLiveSandboxes());
    }
    await runStage((i) => flow.execAfterPauseOne(i));
    await runStage((i) => flow.destroyOne(i));
    liveSandboxCount = 0;
    if (bench) await bench.heartbeat(lastStats.in_flight, liveSandboxCount);

    log.phase(`create complete — ${flow.countSurvivors()}/${burstSize} sandboxes alive`);

    const latencies = okResults.map(r => r.ms).sort((a, b) => a - b);
    const pct = (q: number) =>
      latencies.length === 0 ? 0 : latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * q))];

    const final = {
      sandboxes_attempted: provider.concurrencyTarget,
      sandboxes_succeeded: statusCounts.success,
      partials: statusCounts.partial,
      readiness_failures: statusCounts.readiness_failed,
      worker_ready_failures: statusCounts.worker_ready_failed,
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
      worker_ready_failed: statusCounts.worker_ready_failed,
    };
    // Sub-classification of create-failures only (sums to status_histogram.failed).
    const create_failure_class = {
      timeout: createFailureClass.timeout,
      http_error: createFailureClass.http_error,
      network_error: createFailureClass.network_error,
    };

    // Full latency distribution, written to Tigris meta.json for retrospective
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
    clearInterval(heartbeatInterval);
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

    const meta = {
      ...final,
      latency_distribution,
      first_command_distribution,
      tti_distribution,
      status_histogram,
      create_failure_class,
      submission_segments,
      concurrency_summary,
      global_concurrency,
      concurrency_timeline,
      metrics_summary,
      run_id: RUN_ID,
      provider: PROVIDER,
      ended_at: new Date().toISOString(),
      ...(shard ? { group_id: shard.group_id, shard_index: shard.shard_index, shard_count: shard.shard_count } : {}),
    };

    log.phase('run complete');
    log.info(`submission_segment emitted counts: first=${emittedSegmentCounts.first_25pct} middle=${emittedSegmentCounts.middle_50pct} last=${emittedSegmentCounts.last_25pct}`);
    log.ok(`${final.sandboxes_succeeded}/${final.sandboxes_attempted} succeeded ` +
      `(${((final.sandboxes_succeeded / final.sandboxes_attempted) * 100).toFixed(1)}%) ` +
      `partial=${final.partials} readiness_failed=${final.readiness_failures} failed=${final.failures}`);
    log.info(`latency p50=${final.p50_latency_ms}ms p99=${final.p99_latency_ms}ms`);
    if (final.timeouts + final.http_errors + final.network_errors > 0) {
      log.warn(`create-failure class: timeouts=${final.timeouts} http_errors=${final.http_errors} network_errors=${final.network_errors}`);
    }
    log.phase('uploading artifacts');
    // Upload the four per-shard outputs as worker artifacts (raw/meta/metrics/log)
    // while the attempt is still open, then mark the worker complete. Per-sandbox
    // failures are expected data, not a worker failure, so the worker is
    // "completed" whenever the burst ran end-to-end (only an outright coordinator
    // crash, handled in the catch below, fails the worker).
    await uploadArtifacts(meta);
    if (bench) await bench.finish(false);
    // Exit explicitly so the Namespace instance reaps promptly. The coordinator
    // is the container's PID 1 and its work is done (burst accounted, survivors
    // destroyed, artifacts uploaded, worker finished) — but provider SDKs can
    // hold the event loop open past this point (e.g. @declaw/sdk keeps a
    // module-level keep-alive undici Agent and may have create requests still
    // in flight), so relying on natural drain can strand the VM until its
    // deadline. A clean exit(0) avoids that; the crash/SIGTERM paths exit(1).
    log.ok('coordinator complete — exiting');
    process.exit(0);
  } catch (err: any) {
    clearInterval(metricsInterval);
    clearInterval(heartbeatInterval);
    log.error(`run failed: ${err?.message ?? err}`);
    try {
      // Upload whatever we have (raw so far + metrics + log; no summary) as
      // artifacts before failing the worker.
      await uploadArtifacts();
      if (bench) await bench.finish(true);
    } catch (e: any) {
      log.error(`failed to record failure: ${e?.message ?? e}`);
    }
    // Exit non-zero: as PID 1 this stops the container, the Namespace instance
    // reaps, and the non-zero exit is visible in DescribeInstance shutdownReasons
    // (so start.ts can flag the shard).
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

main().catch(err => {
  log.error(`crashed: ${err?.stack ?? err}`);
  process.exit(1);
});
