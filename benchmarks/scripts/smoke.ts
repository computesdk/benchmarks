/**
 * Smoke harness for the cpu-node benchmark. Runs the workload locally
 * (no ComputeSDK, no cloud sandbox) and asserts it emits a parseable
 * WorkloadResult JSON line.
 *
 * Usage: tsx benchmarks/scripts/smoke.ts --suite=cpu-node
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { SUITE_CONFIG, scoreMetric, parseWorkloadResult } from '../sandbox/cpu-node.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

function getArg(flag: string): string | undefined {
  const args = process.argv.slice(2).filter(a => a !== '--');
  for (const arg of args) {
    if (arg.startsWith(flag + '=')) return arg.slice(flag.length + 1);
  }
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

async function main(): Promise<void> {
  const suite = SUITE_CONFIG;
  const scriptsDir = path.join(ROOT, 'benchmarks', 'scripts');
  const workloadPath = path.join(scriptsDir, suite.workloadPath);
  const stdoutPath = path.join(scriptsDir, 'cpu-node-stdout.js');

  console.log(`\n[smoke] ▶ cpu-node  (${suite.label})`);
  console.log(`    ceiling: ${suite.ceiling} ${suite.unit} (${suite.higherIsBetter ? '↑ better' : '↓ better'})`);

  // Write the workload + stdout helper to a temp dir and run with node
  const workdir = `/tmp/bench-smoke-${process.pid}-${Date.now()}`;
  fs.mkdirSync(path.join(workdir, 'bench'), { recursive: true });

  fs.copyFileSync(workloadPath, path.join(workdir, 'bench', suite.workloadPath));
  if (fs.existsSync(stdoutPath)) {
    fs.copyFileSync(stdoutPath, path.join(workdir, 'bench', 'stdout.js'));
  }

  const startedAt = Date.now();
  const result = spawnSync('node', [path.join(workdir, 'bench', suite.workloadPath)], {
    cwd: path.join(workdir, 'bench'),
    encoding: 'utf8',
    timeout: suite.timeoutMs,
    env: { ...process.env, BENCH_SUITE: 'cpu-node' },
  });
  spawnSync('rm', ['-rf', workdir]);
  const elapsedMs = Date.now() - startedAt;

  if (result.error) {
    console.error(`[smoke] ✗ spawn failed: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`[smoke] ✗ exit ${result.status}`);
    console.error(result.stderr || '(no stderr)');
    process.exit(1);
  }

  const parsed = parseWorkloadResult(result.stdout);
  if (!parsed.ok) {
    console.error(`[smoke] ✗ parse failed (reason: ${parsed.reason ?? 'unknown'})`);
    if ('error' in parsed && parsed.error) console.error(`    error: ${parsed.error}`);
    process.exit(1);
  }

  const score = scoreMetric(parsed.metric.value, suite);
  console.log(`    ✓ ${parsed.metric.value.toLocaleString()} ${parsed.metric.unit} in ${elapsedMs} ms (score ${score.toFixed(1)}/100)`);
  console.log(`\n[smoke] 1 passed · 0 failed · 1 total`);
  process.exit(0);
}

main();
