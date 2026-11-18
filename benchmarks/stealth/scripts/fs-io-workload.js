'use strict';

/**
 * In-sandbox workload for the fs-io benchmark — a node:sqlite port of
 * tensorlakeai/sandbox-sqlite-bench's benchmark.py. Same three modes
 * (default WAL, fsync stress, large dataset) and the same operation
 * suite so results stay comparable with the published numbers.
 *
 * Pure stdlib — runs on any Node >= 22.5 sandbox (node:sqlite ships
 * behind --experimental-sqlite on Node 22.5–22.12 and unflagged on
 * Node >= 22.13 / 23+). Older Nodes emit a 'no_tool' result.
 *
 * Emits a single WorkloadResult JSON line as the LAST line of stdout —
 * the runner parses only that line.
 */

const fs = require('node:fs');
const os = require('node:os');
const { execSync } = require('node:child_process');
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');

const SUITE = 'fs-io';
const DB_PATH = '/tmp/bench.db';

// ---------------------------------------------------------------------------
// Deterministic RNG — matches the reference benchmark's random.seed(42) intent
// (same LCG constants used by the cpu-burst workload).
// ---------------------------------------------------------------------------

function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const LETTERS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

function makeRandomString(rng) {
  return (length) => {
    let out = '';
    for (let i = 0; i < length; i++) out += LETTERS[Math.floor(rng() * LETTERS.length)];
    return out;
  };
}

// ---------------------------------------------------------------------------
// Mode configs — identical scale factors to the reference benchmark.py
// ---------------------------------------------------------------------------

const MODES = {
  default: {
    label: 'Default (WAL, small dataset)',
    journalMode: 'WAL',
    synchronous: 'NORMAL',
    cacheSizeKb: 64000,
    seqInserts: 10000,
    batchInserts: 50000,
    rangeQueries: 1000,
    likeQueries: 500,
    updates: 5000,
    deletes: 2000,
    txInserts: 5000,
  },
  fsync: {
    label: 'Fsync stress (synchronous=FULL, no WAL)',
    journalMode: 'DELETE',
    synchronous: 'FULL',
    cacheSizeKb: 64000,
    seqInserts: 5000,
    batchInserts: 20000,
    rangeQueries: 500,
    likeQueries: 200,
    updates: 2000,
    deletes: 1000,
    txInserts: 5000,
  },
  large: {
    label: 'Large dataset (WAL, exceeds cache)',
    journalMode: 'WAL',
    synchronous: 'NORMAL',
    cacheSizeKb: 8000, // 8MB cache to force spills
    seqInserts: 50000,
    batchInserts: 200000,
    rangeQueries: 2000,
    likeQueries: 1000,
    updates: 10000,
    deletes: 5000,
    txInserts: 10000,
  },
};

// ---------------------------------------------------------------------------
// Worker thread: one reader connection running range queries. Mirrors the
// reference's per-thread sqlite3.connect() + WAL pragma.
// ---------------------------------------------------------------------------

function reader() {
  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(workerData.dbPath);
    try {
      // The reference relies on sqlite3's default 5s busy timeout; node:sqlite
      // applies none, so set it explicitly — all readers race to convert the
      // journal to WAL on fsync-mode databases.
      db.exec('PRAGMA busy_timeout=5000');
      db.exec('PRAGMA journal_mode=WAL');
    } catch {
      // Journal pragma failure must not kill the reader — the benchmark
      // still counts its queries.
    }
    const stmt = db.prepare('SELECT * FROM bench WHERE value BETWEEN ? AND ? LIMIT 100');
    const rng = makeRng(workerData.threadId + 1);
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < workerData.queriesPerThread; i++) {
      const low = rng() * 500;
      stmt.all(low, low + 100);
    }
    const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;
    db.close();
    parentPort.postMessage({ elapsedMs });
  } catch (err) {
    parentPort.postMessage({ error: err && err.message ? err.message : String(err) });
  }
}

// ---------------------------------------------------------------------------
// Operation helpers — each returns elapsed ms
// ---------------------------------------------------------------------------

const now = () => process.hrtime.bigint();
const elapsedMs = (t0) => Number(process.hrtime.bigint() - t0) / 1e6;

function createTable(db) {
  db.exec('DROP TABLE IF EXISTS bench');
  db.exec('DROP TABLE IF EXISTS bench2');
  db.exec(`CREATE TABLE bench (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    value REAL,
    data TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);
  db.exec('CREATE INDEX idx_name ON bench(name)');
  db.exec('CREATE INDEX idx_value ON bench(value)');
}

function benchSequentialInserts(db, n, rng, randStr) {
  const stmt = db.prepare('INSERT INTO bench (name, value, data) VALUES (?, ?, ?)');
  const t0 = now();
  db.exec('BEGIN');
  for (let i = 0; i < n; i++) {
    stmt.run(`item_${i}`, rng() * 1000, randStr(50));
  }
  db.exec('COMMIT');
  return elapsedMs(t0);
}

function benchBatchInserts(db, n, rng, randStr) {
  const stmt = db.prepare('INSERT INTO bench (name, value, data) VALUES (?, ?, ?)');
  const t0 = now();
  db.exec('BEGIN');
  for (let i = 0; i < n; i++) {
    stmt.run(`batch_${i}`, rng() * 1000, randStr(50));
  }
  db.exec('COMMIT');
  return elapsedMs(t0);
}

function benchSelectCount(db) {
  const t0 = now();
  const row = db.prepare('SELECT COUNT(*) AS c FROM bench').get();
  return { ms: elapsedMs(t0), count: row ? row.c : 0 };
}

function benchSelectRange(db, iterations, rng) {
  const stmt = db.prepare('SELECT * FROM bench WHERE value BETWEEN ? AND ? LIMIT 100');
  const t0 = now();
  for (let i = 0; i < iterations; i++) {
    const low = rng() * 500;
    stmt.all(low, low + 100);
  }
  return elapsedMs(t0);
}

function benchSelectLike(db, iterations) {
  const stmt = db.prepare('SELECT * FROM bench WHERE name LIKE ? LIMIT 50');
  const t0 = now();
  for (let i = 0; i < iterations; i++) {
    stmt.all(`item_${i}%`);
  }
  return elapsedMs(t0);
}

function benchUpdate(db, n, rng) {
  const stmt = db.prepare('UPDATE bench SET value = ? WHERE name = ?');
  const t0 = now();
  db.exec('BEGIN');
  for (let i = 0; i < n; i++) {
    stmt.run(rng() * 1000, `item_${i}`);
  }
  db.exec('COMMIT');
  return elapsedMs(t0);
}

function benchDelete(db, n) {
  const stmt = db.prepare('DELETE FROM bench WHERE name = ?');
  const t0 = now();
  db.exec('BEGIN');
  for (let i = 0; i < n; i++) {
    stmt.run(`batch_${i}`);
  }
  db.exec('COMMIT');
  return elapsedMs(t0);
}

function benchTransaction(db, n, rng, randStr) {
  const stmt = db.prepare('INSERT INTO bench (name, value, data) VALUES (?, ?, ?)');
  const t0 = now();
  db.exec('BEGIN');
  for (let i = 0; i < n; i++) {
    stmt.run(`tx_${i}`, rng() * 1000, randStr(30));
  }
  db.exec('COMMIT');
  return elapsedMs(t0);
}

function benchAggregate(db) {
  const t0 = now();
  db.prepare('SELECT AVG(value), MIN(value), MAX(value), SUM(value) FROM bench').get();
  db.prepare('SELECT name, COUNT(*) FROM bench GROUP BY substr(name, 1, 4)').all();
  return elapsedMs(t0);
}

function benchJoin(db, rng, randStr) {
  db.exec('DROP TABLE IF EXISTS bench2');
  db.exec('CREATE TABLE bench2 (id INTEGER PRIMARY KEY, bench_id INTEGER, extra TEXT)');
  const insert = db.prepare('INSERT INTO bench2 (bench_id, extra) VALUES (?, ?)');
  db.exec('BEGIN');
  for (let i = 0; i < 10000; i++) {
    insert.run(Math.floor(rng() * 60000) + 1, randStr(20));
  }
  db.exec('COMMIT');
  const t0 = now();
  db.prepare(
    `SELECT b.name, b.value, b2.extra
     FROM bench b
     JOIN bench2 b2 ON b.id = b2.bench_id
     WHERE b.value > 500
     LIMIT 1000`,
  ).all();
  return elapsedMs(t0);
}

/**
 * 4 reader threads x 500 range queries each against the same DB file —
 * the reference's multi-core read probe.
 */
async function benchConcurrentReads(dbPath, numThreads = 4, queriesPerThread = 500) {
  const t0 = now();
  const workers = await Promise.all(
    Array.from({ length: numThreads }, (_, tid) =>
      new Promise((resolve, reject) => {
        const w = new Worker(__filename, {
          workerData: { dbPath, threadId: tid, queriesPerThread },
        });
        let result;
        w.once('message', (msg) => {
          result = msg;
        });
        w.once('error', reject);
        w.once('exit', (code) => {
          if (code === 0) resolve(result || {});
          else reject(new Error(`reader ${tid} exited with code ${code}`));
        });
      }),
    ),
  );
  const wallMs = elapsedMs(t0);
  const failed = workers.filter((r) => r && r.error);
  return {
    wallMs,
    totalQueries: numThreads * queriesPerThread,
    failures: failed.length,
    error: failed.length ? failed[0].error : undefined,
  };
}

// ---------------------------------------------------------------------------
// Environment metadata (mirrors the reference README's environment table)
// ---------------------------------------------------------------------------

function getResourceMeta() {
  let cpuCount;
  try {
    cpuCount = parseInt(execSync('nproc', { encoding: 'utf8' }).trim(), 10);
  } catch {
    cpuCount = os.cpus().length;
  }

  let memoryMb;
  try {
    const freeOut = execSync('free -m', { encoding: 'utf8' });
    const match = freeOut.match(/Mem:\s+(\d+)/);
    if (match) memoryMb = parseInt(match[1], 10);
  } catch {
    memoryMb = Math.floor(os.totalmem() / 1024 / 1024);
  }

  const meta = { nodeVersion: process.version, arch: process.arch, platform: process.platform };
  if (Number.isFinite(cpuCount) && cpuCount > 0) meta.cpuCount = cpuCount;
  if (Number.isFinite(memoryMb) && memoryMb > 0) meta.memoryMb = memoryMb;
  try {
    meta.kernel = os.release();
  } catch {
    // best effort
  }
  return meta;
}

function getDbSizeMb() {
  let size = 0;
  for (const p of [DB_PATH, `${DB_PATH}-wal`]) {
    try {
      size += fs.statSync(p).size;
    } catch {
      // missing file is fine
    }
  }
  return size / (1024 * 1024);
}

function removeDbFiles() {
  for (const p of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`, `${DB_PATH}-journal`]) {
    try {
      fs.rmSync(p, { force: true });
    } catch {
      // best effort
    }
  }
}

// ---------------------------------------------------------------------------
// node:sqlite bootstrap — direct require on Node >= 22.13 / 23+, respawn with
// --experimental-sqlite on Node 22.5–22.12, no_tool below 22.5.
// ---------------------------------------------------------------------------

function loadSqliteOrRespawn(emit) {
  try {
    return require('node:sqlite');
  } catch {
    if (!isMainThread) throw new Error('node:sqlite unavailable in worker');
    const r = require('node:child_process').spawnSync(
      process.execPath,
      ['--experimental-sqlite', __filename],
      { stdio: 'inherit', env: process.env },
    );
    if (r.error || r.status !== 0) {
      emit({
        ok: false,
        suite: SUITE,
        reason: 'no_tool',
        error: `node:sqlite unavailable (needs Node >= 22.5; got ${process.version})`,
        meta: getResourceMeta(),
      });
      process.exit(0);
    }
    process.exit(r.status);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const { emitWorkloadResult } = require('./stdout.js');

  const mode = process.env.BENCH_MODE || 'default';
  const modeCfg = MODES[mode];
  if (!modeCfg) {
    emitWorkloadResult({
      ok: false,
      suite: SUITE,
      reason: 'error',
      error: `unknown mode "${mode}" (expected: ${Object.keys(MODES).join(', ')})`,
      meta: {},
    });
    return;
  }

  const sqlite = loadSqliteOrRespawn(emitWorkloadResult);
  const rng = makeRng(42);
  const randStr = makeRandomString(rng);

  try {
    removeDbFiles();
    const db = new sqlite.DatabaseSync(DB_PATH);
    db.exec('PRAGMA busy_timeout=5000');
    db.exec(`PRAGMA journal_mode=${modeCfg.journalMode}`);
    db.exec(`PRAGMA synchronous=${modeCfg.synchronous}`);
    db.exec(`PRAGMA cache_size=-${modeCfg.cacheSizeKb}`);

    const results = {};
    const meta = getResourceMeta();
    meta.mode = mode;
    meta.modeLabel = modeCfg.label;
    meta.sqliteVersion = db.prepare('SELECT sqlite_version() AS v').get().v;

    createTable(db);

    results.sequentialInsertsMs = benchSequentialInserts(db, modeCfg.seqInserts, rng, randStr);
    results.batchInsertsMs = benchBatchInserts(db, modeCfg.batchInserts, rng, randStr);

    const count = benchSelectCount(db);
    results.selectCountMs = count.ms;
    results.rowCount = count.count;

    results.rangeQueriesMs = benchSelectRange(db, modeCfg.rangeQueries, rng);
    results.likeQueriesMs = benchSelectLike(db, modeCfg.likeQueries);
    results.updatesMs = benchUpdate(db, modeCfg.updates, rng);
    results.deletesMs = benchDelete(db, modeCfg.deletes);
    results.transactionInsertsMs = benchTransaction(db, modeCfg.txInserts, rng, randStr);
    results.aggregatesMs = benchAggregate(db);
    results.joinQueryMs = benchJoin(db, rng, randStr);

    db.close();

    const reads = await benchConcurrentReads(DB_PATH);
    results.concurrentReadsMs = reads.wallMs;
    results.concurrentReadsTotalQueries = reads.totalQueries;
    results.concurrentReadsQps = reads.wallMs > 0
      ? Math.round((reads.totalQueries / (reads.wallMs / 1000)) * 10) / 10
      : 0;
    if (reads.error) meta.concurrentReadsError = reads.error;
    meta.concurrentReadsFailures = reads.failures;

    results.dbSizeMb = Math.round(getDbSizeMb() * 100) / 100;
    removeDbFiles();

    // Sum only the timed operation fields.
    results.totalMs = Object.keys(results)
      .filter((k) => k.endsWith('Ms'))
      .reduce((a, k) => a + results[k], 0);

    // Integrity check: every timed op ran and the mid-suite row count is
    // exact (COUNT(*) is measured after sequential + batch inserts, before
    // deletes and transaction inserts).
    const expectedRows = modeCfg.seqInserts + modeCfg.batchInserts;
    results.verified = results.rowCount === expectedRows && reads.failures === 0;
    results.expectedRowCount = expectedRows;

    for (const [k, v] of Object.entries(results)) meta[k] = v;

    emitWorkloadResult({
      ok: true,
      suite: SUITE,
      metric: { value: results.totalMs, unit: 'ms', higherIsBetter: false },
      meta,
    });
  } catch (err) {
    removeDbFiles();
    emitWorkloadResult({
      ok: false,
      suite: SUITE,
      reason: 'error',
      error: err && err.message ? err.message : String(err),
      meta: { ...getResourceMeta(), mode },
    });
  }
}

if (isMainThread) {
  main();
} else {
  reader();
}
