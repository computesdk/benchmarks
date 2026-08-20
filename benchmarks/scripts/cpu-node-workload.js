'use strict';

/**
 * In-sandbox workload for the cpu-node benchmark.
 *
 * Runs four deterministic compute phases (JSON round-trip, SHA-256
 * hashing, regex text walk, sum-of-primes) and emits the total wall-clock
 * as the suite metric via a WorkloadResult JSON line.
 *
 * Pure stdlib — no node_modules, no native bindings, runs identically on
 * any Node 18+ sandbox regardless of provider.
 */

const crypto = require('node:crypto');
const { emitWorkloadResult } = require('./stdout.js');

const ITERATIONS = 64;

// ---- Phase 1: JSON round-trip cost ---------------------------
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

function phase1(iters, astDepth) {
  let total = 0;
  for (let i = 0; i < iters; i++) {
    const ast = makeAst(astDepth);
    const ser = JSON.stringify(ast);
    const parsed = JSON.parse(ser);
    total += parsed.children.length;
  }
  return total;
}

// ---- Phase 2: crypto throughput -----------------------------
function phase2(iters, bytesPerBlock, blocks) {
  let totalBytes = 0;
  const buf = crypto.randomFillSync(Buffer.alloc(bytesPerBlock));
  for (let i = 0; i < iters; i++) {
    for (let b = 0; b < blocks; b++) {
      const h = crypto.createHash('sha256');
      h.update(buf);
      h.digest();
      totalBytes += bytesPerBlock;
    }
  }
  return totalBytes;
}

// ---- Phase 3: regex + text walk -----------------------------
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

function phase3(iters, bytes) {
  const corpus = makeCorpus(Math.max(64 * 1024, bytes));
  const patterns = [
    /function\s+\w+/g,
    /class\s+\w+\s+extends\s+\w+/g,
    /\bawait\s+\w+/g,
    /\bimport\s+.*?from\s+/g,
  ];
  let totalMatches = 0;
  for (let i = 0; i < iters; i++) {
    for (const pat of patterns) {
      pat.lastIndex = 0;
      const m = corpus.match(pat);
      if (m) totalMatches += m.length;
    }
  }
  return totalMatches;
}

// ---- Phase 4: numeric loop ----------------------------------
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

function phase4(iters) {
  let checksum = 0;
  for (let i = 0; i < iters; i++) checksum += sumOfPrimes(5_000_000);
  return checksum;
}

// ---- Driver --------------------------------------------------

const t0 = process.hrtime.bigint();

const phase1_iters = Math.max(1, Math.floor(ITERATIONS / 4));
const phase2_iters = Math.max(1, Math.floor(ITERATIONS / 8));
const phase3_iters = Math.max(1, Math.floor(ITERATIONS / 4));
const phase4_iters = Math.max(1, Math.floor(ITERATIONS / 4));

phase1(phase1_iters, 7);
phase2(phase2_iters, 1024 * 1024, 64);
phase3(phase3_iters, 256 * 1024);
phase4(phase4_iters);

const totalMs = Number((process.hrtime.bigint() - t0) / 1_000_000n);

emitWorkloadResult({
  ok: true,
  suite: 'cpu-node',
  metric: { value: totalMs, unit: 'ms', higherIsBetter: false },
  meta: {
    iterationsReported: ITERATIONS,
    workloadMs: totalMs,
  },
});
process.exit(0);
