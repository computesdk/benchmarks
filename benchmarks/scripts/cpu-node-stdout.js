/**
 * Workloads are uploaded to a fresh sandbox and executed with `node <file>.js`.
 * Every workload must `console.log` a single WorkloadResult JSON line as
 * its LAST line of stdout — the runner parses only the last line.
 *
 * This helper guarantees the line stays last even if intermediate logging
 * happens (e.g. status updates).
 *
 * Pure CommonJS — no transpile step runs inside ComputeSDK sandboxes, so we
 * intentionally avoid `import`/`export` and TypeScript syntax here. The TS
 * counterpart of this file is `stdout.ts` in the same directory, which the
 * build pipeline does NOT upload; only this `.js` is shipped with each suite.
 */

function emitWorkloadResult(result) {
  process.stdout.write(JSON.stringify(result) + '\n');
}

// Global crash handler: if a workload throws during module loading (e.g.
// require() of a native module fails, or an unhandled rejection fires
// before the workload's own catch handler is installed), emit a failure
// result so the orchestrator gets a parseable JSON line instead of empty
// stdout. Without this, providers like beam that crash before emit show
// up as "no parseable WorkloadResult" with no diagnostic info.
let _crashed = false;
process.on('uncaughtException', (err) => {
  if (_crashed) return;
  _crashed = true;
  emitWorkloadResult({
    ok: false,
    suite: process.env.BENCH_SUITE || 'unknown',
    reason: 'error',
    error: err && err.message ? err.message : String(err),
    meta: { stack: err && err.stack ? err.stack.split('\n').slice(0, 3).join(' | ') : undefined },
  });
  process.exit(0);
});
process.on('unhandledRejection', (reason) => {
  if (_crashed) return;
  _crashed = true;
  emitWorkloadResult({
    ok: false,
    suite: process.env.BENCH_SUITE || 'unknown',
    reason: 'error',
    error: reason instanceof Error ? reason.message : String(reason),
    meta: {},
  });
  process.exit(0);
});

module.exports = { emitWorkloadResult };
