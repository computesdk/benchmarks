'use strict';

/**
 * In-sandbox workload for the cpu-burst benchmark.
 *
 * One run deliberately over-tasks the CPU past the provisioned `nproc` value
 * and measures whether extra vCPUs are granted. A single-threaded baseline
 * unit establishes throughput, then `ceil(oversubscribe * nproc)` worker
 * threads hammer the same unit for a fixed duration. From total aggregate
 * throughput we derive effective core count and burst headroom.
 *
 * Pure stdlib — no node_modules, no native bindings, runs identically on
 * any Node 18+ sandbox regardless of provider.
 */

const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');
const crypto = require('node:crypto');
const os = require('node:os');
const { execSync } = require('node:child_process');

const BURST_OVERSUBSCRIBE = parseFloat(process.env.BURST_OVERSUBSCRIBE || '4');
const BURST_MARGIN = parseFloat(process.env.BURST_MARGIN || '0.25');
const BURST_MEM_FACTOR = parseFloat(process.env.BURST_MEM_FACTOR || '0');
const BURST_DURATION_MS = parseFloat(process.env.BURST_DURATION_MS || '3000');

// ---- CPU-bound unit: fixed multi-phase work -------------------------------

function makeAst(depth) {
  if (depth === 0) return { kind: 'leaf', value: 'x', pos: 0, parent: null };
  return {
    kind: 'branch',
    children: Array.from({ length: 5 }, (_, i) => {
      const c = makeAst(depth - 1);
      c.parent = { idx: i, depth };
      c.pos = i;
      return c;
    }),
    pos: depth,
  };
}

function phase1(astDepth) {
  const ast = makeAst(astDepth);
  const ser = JSON.stringify(ast);
  const parsed = JSON.parse(ser);
  return parsed.children.length;
}

function phase2(bytesPerBlock) {
  const buf = crypto.randomFillSync(Buffer.alloc(bytesPerBlock));
  const h = crypto.createHash('sha256');
  h.update(buf);
  h.digest();
  return bytesPerBlock;
}

function makeCorpus(bytes) {
  const rng = (() => {
    let s = 0x12345678;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 0x100000000;
    };
  })();
  const words = ['module', 'export', 'class', 'function', 'const', 'return', 'await',
    'async', 'throw', 'import', 'from', 'with', 'yield', 'new', 'extends'];
  const out = [];
  let acc = '';
  let totalLen = 0;
  while (totalLen < bytes) {
    const w = words[Math.floor(rng() * words.length)];
    acc += w + ' ';
    totalLen += w.length + 1;
    if (rng() < 0.05) {
      out.push(acc);
      acc = '';
    }
  }
  if (acc.length) out.push(acc);
  return out.join('\n');
}

function phase3(bytes) {
  const corpus = makeCorpus(Math.max(1024, bytes));
  const patterns = [
    /function\s+\w+/g,
    /class\s+\w+\s+extends\s+\w+/g,
    /\bawait\s+\w+/g,
    /\bimport\s+.*?from\s+/g,
  ];
  let totalMatches = 0;
  for (const pat of patterns) {
    pat.lastIndex = 0;
    const m = corpus.match(pat);
    if (m) totalMatches += m.length;
  }
  return totalMatches;
}

function sumOfPrimes(limit) {
  let total = 0;
  for (let n = 2; n <= limit; n++) {
    let prime = true;
    for (let d = 2; d * d <= n; d++) {
      if (n % d === 0) { prime = false; break; }
    }
    if (prime) total += n;
  }
  return total;
}

function phase4(limit) {
  return sumOfPrimes(limit);
}

function runUnit() {
  // Fixed unit tuned to take ~20-50ms on a typical sandbox vCPU.
  phase1(6);
  phase2(65536);
  phase3(32768);
  phase4(500_000);
}

function getResourceMeta() {
  const envCpu = parseFloat(process.env.CPU_BURST_PROVISIONED_CPU || '');
  const envMemory = parseFloat(process.env.CPU_BURST_PROVISIONED_MEMORY_MB || '');

  let cpuCount;
  if (Number.isFinite(envCpu) && envCpu > 0) {
    cpuCount = envCpu;
  } else {
    try {
      cpuCount = parseInt(execSync('nproc', { encoding: 'utf8' }).trim(), 10);
    } catch {
      cpuCount = os.cpus().length;
    }
  }

  let memoryMb;
  if (Number.isFinite(envMemory) && envMemory > 0) {
    memoryMb = envMemory;
  } else {
    try {
      const freeOut = execSync('free -m', { encoding: 'utf8' });
      const match = freeOut.match(/Mem:\s+(\d+)/);
      if (match) memoryMb = parseInt(match[1], 10);
    } catch {
      // fall through to os.totalmem()
    }
    if (memoryMb === undefined || Number.isNaN(memoryMb)) {
      memoryMb = Math.floor(os.totalmem() / 1024 / 1024);
    }
  }

  const meta = {};
  if (Number.isFinite(cpuCount) && cpuCount > 0) meta.cpuCount = cpuCount;
  if (Number.isFinite(memoryMb) && memoryMb > 0) meta.memoryMb = memoryMb;
  return meta;
}

function round2(n) {
  if (n === null || n === undefined) return n;
  return Math.round(n * 100) / 100;
}

// ---- Worker thread --------------------------------------------------------

function worker() {
  const durationNs = BigInt(workerData.durationNs);

  parentPort.once('message', (msg) => {
    if (msg !== 'start') return;

    // Optional RAM pressure (off by default).
    if (workerData.memFactor > 0 && workerData.memBytesPerWorker > 0) {
      try {
        const buf = Buffer.allocUnsafe(workerData.memBytesPerWorker);
        // Touch pages to ensure RSS.
        for (let i = 0; i < buf.length; i += 4096) buf[i] = 1;
        // Keep the reference alive through the run.
        globalThis.__burstMemBuf = buf;
      } catch {
        // Allocation may fail if the factor pushed past real RAM.
      }
    }

    const endHr = process.hrtime.bigint() + durationNs;

    let ops = 0;
    let peakRss = 0;
    while (process.hrtime.bigint() < endHr) {
      runUnit();
      ops++;
      const rss = process.memoryUsage().rss;
      if (rss > peakRss) peakRss = rss;
    }

    parentPort.postMessage({ ops, peakRss });
  });
}

// ---- Main thread ----------------------------------------------------------

function main() {
  const { emitWorkloadResult } = require('./stdout.js');

  const resourceMeta = getResourceMeta();
  const provisionedCpu = resourceMeta.cpuCount || 1;
  const provisionedMemoryMb = resourceMeta.memoryMb || 0;

  const numWorkers = Math.max(1, Math.ceil(BURST_OVERSUBSCRIBE * provisionedCpu));

  // BASELINE: one unit single-threaded.
  const baselineT0 = process.hrtime.bigint();
  runUnit();
  const baselineMs = Number((process.hrtime.bigint() - baselineT0) / 1_000_000n);
  const baselineOpsPerSec = baselineMs > 0 ? 1000 / baselineMs : 0;

  // Optional RAM pressure setup.
  let memBytesPerWorker = 0;
  if (BURST_MEM_FACTOR > 0 && provisionedMemoryMb > 0) {
    memBytesPerWorker = Math.floor((provisionedMemoryMb * 1024 * 1024 / numWorkers) * BURST_MEM_FACTOR);
  }

  // OVER-TASK: spawn workers and run them for the configured duration.
  const durationNs = BigInt(Math.floor(BURST_DURATION_MS)) * 1_000_000n;

  const workers = [];
  const workerResults = new Array(numWorkers).fill(null);
  let oomKilled = false;
  let workerError = false;

  for (let i = 0; i < numWorkers; i++) {
    const w = new Worker(__filename, {
      workerData: {
        durationNs: durationNs.toString(),
        memFactor: BURST_MEM_FACTOR,
        memBytesPerWorker,
      },
    });
    workers.push(w);
    w.on('message', (msg) => { workerResults[i] = msg; });
    w.on('error', (err) => {
      workerError = true;
      if (/out of memory|heap|Worker/i.test(err.message)) oomKilled = true;
      workerResults[i] = { ops: 0, peakRss: 0, error: err.message };
    });
    w.on('exit', (code) => {
      if (code !== 0 && !workerResults[i]) {
        workerError = true;
        workerResults[i] = { ops: 0, peakRss: 0 };
      }
    });
  }

  let burstStart;

  Promise.all(
    workers.map((w) => new Promise((resolve) => w.once('online', resolve))),
  ).then(() => {
    burstStart = process.hrtime.bigint();
    for (const w of workers) w.postMessage('start');

    return Promise.all(
      workers.map((w) => new Promise((resolve) => w.once('exit', resolve))),
    );
  }).then(() => {
    const burstEnd = process.hrtime.bigint();
    const burstMs = Number((burstEnd - burstStart) / 1_000_000n);

    const totalOps = workerResults.reduce((s, r) => s + (r?.ops || 0), 0);
    const peakRssBytes = workerResults.reduce((m, r) => Math.max(m, r?.peakRss || 0), 0);
    const peakRssMb = peakRssBytes > 0 ? peakRssBytes / 1024 / 1024 : 0;

    const burstOpsPerSec = burstMs > 0 ? totalOps / (burstMs / 1000) : 0;
    const effectiveCores = baselineOpsPerSec > 0 ? burstOpsPerSec / baselineOpsPerSec : 0;
    const burstHeadroom = provisionedCpu > 0 ? effectiveCores / provisionedCpu : 0;
    const threshold = provisionedCpu > 0 ? provisionedCpu * (1 + BURST_MARGIN) : 0;
    const burstDetected = effectiveCores > threshold && totalOps > 0;

    const baseMeta = {
      provisionedCpu,
      provisionedMemoryMb,
      numWorkers,
      burstDetected,
      peakRssMb: BURST_MEM_FACTOR > 0 ? Math.round(peakRssMb) : 0,
      oomKilled: BURST_MEM_FACTOR > 0 ? oomKilled : false,
    };

    // The measured headroom is always emitted — scoring credits partial
    // headroom and delivered-vs-provisioned allocation, so the numbers must
    // survive even when no burst is detected.
    emitWorkloadResult({
      ok: true,
      suite: 'cpu-burst',
      metric: { value: burstHeadroom, unit: 'x', higherIsBetter: true },
      meta: {
        ...baseMeta,
        baselineMs: round2(baselineMs),
        burstMs: round2(burstMs),
        baselineOpsPerSec: round2(baselineOpsPerSec),
        burstOpsPerSec: round2(burstOpsPerSec),
        effectiveCores,
        burstHeadroom,
      },
    });
    process.exit(0);
  }).catch((err) => {
    emitWorkloadResult({
      ok: false,
      suite: 'cpu-burst',
      reason: 'error',
      error: err && err.message ? err.message : String(err),
      meta: {
        provisionedCpu,
        provisionedMemoryMb,
        numWorkers,
        burstDetected: false,
        baselineMs: round2(baselineMs),
        burstMs: null,
        baselineOpsPerSec: round2(baselineOpsPerSec),
        burstOpsPerSec: null,
        effectiveCores: null,
        burstHeadroom: null,
        peakRssMb: 0,
        oomKilled: false,
      },
    });
    process.exit(0);
  });
}

if (isMainThread) {
  main();
} else {
  worker();
}
