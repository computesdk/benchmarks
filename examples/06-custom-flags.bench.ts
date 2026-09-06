/**
 * Custom CLI flags: pass benchmark-specific values through the runner without
 * it treating them as unknown options.
 *
 * Run:
 *   pnpm exec bench run examples/06-custom-flags.bench.ts --payload-bytes 4096 --algorithm md5 --dry-run
 */
import crypto from 'node:crypto';
import { defineBenchmarkConfig, defineTask } from '@benchsdk/runner';
import type { TaskContext } from '@benchsdk/runner';

interface LocalParticipant {
  name: string;
  requiredEnvVars: string[];
}

const ALLOWED_ALGORITHMS = ['sha256', 'sha512', 'md5'] as const;
type Algorithm = (typeof ALLOWED_ALGORITHMS)[number];

function getFlag(name: string, fallback: string): string {
  const args = process.argv.slice(2);
  const idx = args.indexOf(name);
  if (idx !== -1 && args[idx + 1] && !args[idx + 1].startsWith('-')) {
    return args[idx + 1];
  }
  const eq = args.find((a) => a.startsWith(`${name}=`));
  if (eq) {
    return eq.slice(name.length + 1);
  }
  return fallback;
}

function parseAlgorithm(value: string): Algorithm {
  if ((ALLOWED_ALGORITHMS as readonly string[]).includes(value)) {
    return value as Algorithm;
  }
  throw new Error(`--algorithm must be one of ${ALLOWED_ALGORITHMS.join(', ')} (got "${value}")`);
}

const payloadBytes = Math.max(1, parseInt(getFlag('--payload-bytes', '1024'), 10));
const algorithm = parseAlgorithm(getFlag('--algorithm', 'sha256'));

export const config = defineBenchmarkConfig({
  benchmarkSlug: 'custom-flags-demo',
  benchmarkName: 'Custom Flags Demo',
  iterations: 5,
  concurrency: 1,
  participants: [{ name: 'local', requiredEnvVars: [] }],
  customCliFlags: ['--payload-bytes', '--algorithm'],
  dimensions: {
    algorithm,
    payloadBytes,
  },
  display: {
    description: 'Custom CLI flags for payload size and hash algorithm.',
    metrics: [
      { key: 'durationMs', label: 'Duration', unit: 'ms', direction: 'lower-better', decimals: 0 },
      { key: 'hashLength', label: 'Hash length', direction: 'higher-better', decimals: 0 },
    ],
    steps: [
      { key: 'hash', label: 'Hash payload' },
    ],
    overview: { defaultMetric: 'durationMs', defaultLayout: 'ranking' },
  },
  scoring: {
    metrics: [
      {
        key: 'durationMs',
        ceiling: 1000,
        weights: { median: 0.7, p95: 0.2, p99: 0.1 },
      },
    ],
  },
});

function hashPayload(bytes: number): { hash: string; durationMs: number } {
  const payload = crypto.randomBytes(bytes);
  const start = performance.now();
  const hash = crypto.createHash(algorithm).update(payload).digest('hex');
  return { hash, durationMs: performance.now() - start };
}

export const task = defineTask(async (ctx: TaskContext<LocalParticipant>) => {
  const { step, measure, log } = ctx;
  log('hashing payload', { level: 'info', meta: { payloadBytes, algorithm } });

  const { hash, durationMs } = await step('hash', () => hashPayload(payloadBytes));
  measure({ durationMs, hashLength: hash.length });
});
