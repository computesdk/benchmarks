import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SandboxResult, ProgressStats, FinalStats } from '../types.js';

const BATCH_SIZE = 1000;
const BATCH_TIMEOUT_MS = 2000;

export class SqliteSink {
  private db: Database.Database;
  private runId: string;
  private buffer: SandboxResult[] = [];
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(filename: string, runId: string) {
    fs.mkdirSync(path.dirname(path.resolve(filename)), { recursive: true });
    this.db = new Database(filename);
    this.runId = runId;
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.bootstrapSchema();
  }

  async connect(): Promise<void> {
    return;
  }

  async bootstrap(
    provider: string,
    commit_sha: string,
    instance_id: string,
    artifact_prefix: string,
    shard?: { group_id: string; shard_index: number; shard_count: number },
  ): Promise<void> {
    this.db.prepare(`
      INSERT OR IGNORE INTO runs
        (id, provider, commit_sha, instance_id, started_at, status, tigris_prefix,
         group_id, shard_index, shard_count)
      VALUES
        (@id, @provider, @commit_sha, @instance_id, @started_at, 'running', @artifact_prefix,
         @group_id, @shard_index, @shard_count)
    `).run({
      id: this.runId,
      provider,
      commit_sha,
      instance_id,
      started_at: new Date().toISOString(),
      artifact_prefix,
      group_id: shard?.group_id ?? null,
      shard_index: shard?.shard_index ?? null,
      shard_count: shard?.shard_count ?? null,
    });
    if (shard) {
      this.db.prepare(`
        UPDATE runs
           SET group_id = @group_id, shard_index = @shard_index, shard_count = @shard_count
         WHERE id = @id
           AND (group_id IS NULL OR shard_index IS NULL OR shard_count IS NULL)
      `).run({ id: this.runId, ...shard });
    }
  }

  async write(result: SandboxResult): Promise<void> {
    this.buffer.push(result);
    if (this.buffer.length >= BATCH_SIZE) {
      await this.flush();
    } else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flush().catch(err => console.error('[sqlite] timed flush failed:', err.message));
      }, BATCH_TIMEOUT_MS);
    }
  }

  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.buffer.length === 0) return;
    const batch = this.buffer.splice(0);
    this.insertBatch(batch);
  }

  async heartbeat(_stats: ProgressStats): Promise<void> {
    this.db.prepare(`UPDATE runs SET last_heartbeat = @now WHERE id = @id`)
      .run({ id: this.runId, now: new Date().toISOString() });
  }

  async complete(stats: FinalStats): Promise<void> {
    this.db.prepare(`
      UPDATE runs
         SET status = 'done',
             ended_at = @now,
             last_heartbeat = @now,
             sandboxes_attempted = @sandboxes_attempted,
             sandboxes_succeeded = @sandboxes_succeeded,
             partials = @partials,
             readiness_failures = @readiness_failures,
             timeouts = @timeouts,
             http_errors = @http_errors,
             network_errors = @network_errors,
             p50_latency_ms = @p50_latency_ms,
             p99_latency_ms = @p99_latency_ms
       WHERE id = @id
    `).run({ id: this.runId, now: new Date().toISOString(), ...stats });
  }

  async fail(message: string): Promise<void> {
    this.db.prepare(`
      UPDATE runs
         SET status = 'failed', ended_at = @now, error_message = @message
       WHERE id = @id
    `).run({ id: this.runId, now: new Date().toISOString(), message: message.slice(0, 4000) });
  }

  async close(): Promise<void> {
    await this.flush();
    this.db.close();
  }

  private insertBatch(batch: SandboxResult[]): void {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO sandbox_results
        (run_id, sandbox_idx, started_at, completed_at, latency_ms, first_command_ms,
         status, failure_class, http_status, error_code, provider_metadata)
      VALUES
        (@run_id, @sandbox_idx, @started_at, @completed_at, @latency_ms, @first_command_ms,
         @status, @failure_class, @http_status, @error_code, @provider_metadata)
    `);
    const tx = this.db.transaction((rows: SandboxResult[]) => {
      for (const r of rows) {
        stmt.run({
          run_id: this.runId,
          sandbox_idx: r.sandbox_idx,
          started_at: r.started_at,
          completed_at: r.completed_at,
          latency_ms: r.latency_ms,
          first_command_ms: r.first_command_ms,
          status: r.status,
          failure_class: r.failure_class,
          http_status: r.http_status,
          error_code: r.error_code,
          provider_metadata: r.provider_metadata == null ? null : JSON.stringify(r.provider_metadata),
        });
      }
    });
    tx(batch);
  }

  private bootstrapSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id                    TEXT PRIMARY KEY,
        provider              TEXT NOT NULL,
        commit_sha            TEXT NOT NULL,
        instance_id           TEXT NOT NULL,
        started_at            TEXT NOT NULL,
        ended_at              TEXT,
        last_heartbeat        TEXT,
        status                TEXT NOT NULL CHECK (status IN ('running', 'done', 'failed')),
        sandboxes_attempted   INTEGER,
        sandboxes_succeeded   INTEGER,
        partials              INTEGER,
        readiness_failures    INTEGER,
        timeouts              INTEGER,
        http_errors           INTEGER,
        network_errors        INTEGER,
        p50_latency_ms        INTEGER,
        p99_latency_ms        INTEGER,
        error_message         TEXT,
        tigris_prefix         TEXT NOT NULL,
        group_id              TEXT,
        shard_index           INTEGER,
        shard_count           INTEGER
      );

      CREATE INDEX IF NOT EXISTS runs_provider_started
        ON runs (provider, started_at DESC);
      CREATE INDEX IF NOT EXISTS runs_group_id
        ON runs (group_id);
      CREATE INDEX IF NOT EXISTS runs_stuck
        ON runs (last_heartbeat);

      CREATE TABLE IF NOT EXISTS sandbox_results (
        run_id            TEXT NOT NULL REFERENCES runs(id),
        sandbox_idx       INTEGER NOT NULL,
        started_at        TEXT NOT NULL,
        completed_at      TEXT,
        latency_ms        INTEGER,
        first_command_ms  INTEGER,
        status            TEXT NOT NULL CHECK (status IN ('success', 'partial', 'readiness_failed', 'failed')),
        failure_class     TEXT CHECK (failure_class IS NULL OR failure_class IN ('timeout', 'http_error', 'network_error')),
        http_status       INTEGER,
        error_code        TEXT,
        provider_metadata TEXT,
        PRIMARY KEY (run_id, sandbox_idx)
      );

      CREATE INDEX IF NOT EXISTS sandbox_results_run_status
        ON sandbox_results (run_id, status);
    `);
  }
}
