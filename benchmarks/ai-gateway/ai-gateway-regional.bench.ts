/**
 * Regional AI Gateway benchmark — Anthropic family. This is the same cold/warm
 * latency benchmark run from a single runner region. The region is supplied once
 * per run (via `BENCH_REGION` or `--ai-gateway-region`) and every record is
 * tagged with `region` so the platform can compare runs by region.
 *
 * The benchmark intentionally hits each provider's normal endpoint; different
 * regions are achieved by running the same file from different CI runner
 * locations, not by routing to provider-specific regional endpoints.
 *
 * Run:
 *   BENCH_REGION=us-east-1 bench run benchmarks/ai-gateway/ai-gateway-regional.bench.ts
 *   bench run benchmarks/ai-gateway/ai-gateway-regional.bench.ts --ai-gateway-region us-east-1
 *
 * To group four regional runners into one platform run, pass the same
 * `--run-key <key>` to each. The benchmark then suffixes participant names with
 * the region so sibling runners register distinct participants.
 */
import '../src/env.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineBenchmarkConfig, defineTask } from '@benchsdk/runner';
import { providers } from './providers.js';
import { writeAIGatewayLegacyResults } from './legacy-results.js';
import { makeAIGatewayTask, resolveAIGatewayRegionalPhases } from './shared-task.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const MAX_TOKENS = 200;
const TIMEOUT_MS = 45_000;

function parseStringFlag(argv: string[], flag: string): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === flag) {
      if (i + 1 >= argv.length) throw new Error(`${flag} requires a value`);
      const value = argv[i + 1];
      if (!value || value.startsWith('-')) {
        throw new Error(`${flag} requires a non-empty value (got "${value}")`);
      }
      return value;
    }
    if (argv[i].startsWith(`${flag}=`)) {
      const value = argv[i].slice(flag.length + 1);
      if (!value) throw new Error(`${flag}= requires a non-empty value`);
      return value;
    }
  }
  return undefined;
}

function hasFlag(argv: string[], flag: string): boolean {
  return argv.includes(flag) || argv.some((a) => a.startsWith(`${flag}=`));
}

const argv = process.argv.slice(2);

const region = process.env.BENCH_REGION ?? parseStringFlag(argv, '--ai-gateway-region');
if (!region) {
  throw new Error('A region is required. Set BENCH_REGION or pass --ai-gateway-region <region>.');
}

const runKey = hasFlag(argv, '--run-key');
const providerFlag = parseStringFlag(argv, '--provider');
if (runKey && providerFlag) {
  throw new Error('Cannot use --provider with --run-key in the regional benchmark; a run-key groups one region across all providers.');
}

// When sibling runners share a --run-key, each region must register distinct
// participant identities. Suffix the participant slug with the region and keep
// the original provider name as displayName for legacy/SVG output.
const regionalProviders = providers.map((provider) =>
  runKey
    ? { ...provider, name: `${provider.name}-${region}`, displayName: provider.name }
    : { ...provider, displayName: provider.name },
);

const phases = resolveAIGatewayRegionalPhases([...argv, '--ai-gateway-regions', region]);
if (phases.length === 0) {
  throw new Error('No regional phases to run. Check --iterations / --ai-gateway-iterations-* values.');
}

export const config = defineBenchmarkConfig({
  benchmarkSlug: `ai-gateway-latency-regional-anthropic${process.env.DAILY_BENCH_SLUG ? `-${process.env.DAILY_BENCH_SLUG}` : ''}`,
  benchmarkName: `AI Gateway Latency - Regional - Anthropic${process.env.DAILY_BENCH_NAME ? ` - ${process.env.DAILY_BENCH_NAME}` : ''}`,
  phases,
  groupBy: 'round',
  participants: regionalProviders,
  customCliFlags: ['--ai-gateway-region', '--ai-gateway-iterations-cold', '--ai-gateway-iterations-warm'],
  scoring: {
    groupBy: 'region',
    metrics: [
      { key: 'coldE2eMs', unit: 'ms', ceiling: 20000, weights: { median: 0.30, p95: 0.15, p99: 0 } },
      { key: 'warmTtftMs', unit: 'ms', ceiling: 20000, weights: { median: 0.30, p95: 0.15, p99: 0 } },
      {
        key: 'outputTokensPerSec',
        unit: 'tokens/sec',
        floor: 5,
        ceiling: 200,
        higherIsBetter: true,
        weights: { median: 0.10, p95: 0, p99: 0 },
      },
    ],
  },
  onComplete: async (outcome) => {
    await writeAIGatewayLegacyResults(outcome.participants, {
      resultsDir: path.resolve(__dirname, `../../results/ai-gateway-latency/regional/anthropic/${region}`),
      providers: regionalProviders,
    });
  },
});

export const task = defineTask(makeAIGatewayTask(MAX_TOKENS, TIMEOUT_MS));
