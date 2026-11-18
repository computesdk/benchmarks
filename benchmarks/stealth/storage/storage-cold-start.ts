/**
 * Pure helpers shared by storage-cold-start.bench.ts (parent) and
 * storage-cold-start-worker.ts (fresh child process per measurement).
 */
import { createHash } from 'node:crypto';

export const COLD_START_SLUG = 'storage-cold-start';
export const PROBE_SIZE_BYTES = 1024;
export const PROBE_KEY = `bench/${COLD_START_SLUG}/corpus/v1/probe.bin`;
/** Marker the worker prints in front of its single JSON result line. */
export const RESULT_MARKER = 'STORAGE_COLD_START_RESULT ';

export type WorkerOp = 'get' | 'put';

/** Deterministic 1 KiB body. `seed` 0 is the persistent probe object. */
export function probeBody(seed = 0): Uint8Array {
  const body = new Uint8Array(PROBE_SIZE_BYTES);
  for (let i = 0; i < body.length; i++) body[i] = (i * 31 + 7 + seed * 131) & 0xff;
  return body;
}

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export const PROBE_SHA256 = sha256(probeBody(0));

export function runPrefix(runKey: string, rand: string): string {
  return `bench/${COLD_START_SLUG}/run-${runKey.replace(/[^A-Za-z0-9_-]/g, '_')}-${rand}/`;
}

/** The two objects one PUT child writes: its cold (first) and warm (second) upload. */
export function putKeys(prefix: string, taskIndex: number): { cold: string; warm: string } {
  return {
    cold: `${prefix}iter-${taskIndex}-cold.bin`,
    warm: `${prefix}iter-${taskIndex}-warm.bin`,
  };
}

/** GET-first on even iterations, PUT-first on odd ones, so neither child always goes second. */
export function childOrder(taskIndex: number): WorkerOp[] {
  return taskIndex % 2 === 0 ? ['get', 'put'] : ['put', 'get'];
}

export interface WorkerResult {
  ok: boolean;
  op: WorkerOp;
  provider: string;
  /** performance.timeOrigin of the child (epoch ms). */
  timeOrigin: number;
  /** performance.now() when the worker's main body started (after module load). */
  readyAtMs: number;
  clientInitMs?: number;
  coldMs?: number;
  warmMs?: number;
  /** Failure stage: client-init | cold | warm | verify | args. */
  stage?: string;
  error?: string;
}

export function parseWorkerOutput(stdout: string): WorkerResult {
  const line = stdout
    .split('\n')
    .reverse()
    .find((l) => l.startsWith(RESULT_MARKER));
  if (!line) throw new Error(`worker printed no result line (stdout tail: ${stdout.slice(-300).trim() || '<empty>'})`);
  const parsed = JSON.parse(line.slice(RESULT_MARKER.length)) as WorkerResult;
  if (parsed.op !== 'get' && parsed.op !== 'put') throw new Error(`worker result has invalid op: ${String(parsed.op)}`);
  return parsed;
}

/**
 * Wall time from the parent calling spawn() to the child's main body starting:
 * Node boot + tsx loader + module imports. Both clocks are epoch-anchored on
 * the same host, so the difference is comparable.
 */
export function processSpawnMs(parentSpawnEpochMs: number, result: Pick<WorkerResult, 'timeOrigin' | 'readyAtMs'>): number {
  return round(result.timeOrigin + result.readyAtMs - parentSpawnEpochMs);
}

export function round(value: number, decimals = 3): number {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return round(s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2);
}

export function p95(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  return round(s[Math.min(s.length - 1, Math.max(0, Math.ceil(0.95 * s.length) - 1))]);
}
