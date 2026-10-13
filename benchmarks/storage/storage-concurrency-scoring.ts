import type {
  StorageConcurrencyCellResult,
  StorageConcurrencyProviderResult,
} from './storage-concurrency-results.js';

export interface StorageConcurrencyScore {
  compositeScore: number;
  successRate: number;
  validCellRate: number;
}

/**
 * Absolute scoring ceilings. Scores are stable when providers are added or
 * removed, matching the repository's other benchmark score implementations.
 */
const THROUGHPUT_CEILING_OPS = 2_000;
const P50_CEILING_MS = 500;
const P95_CEILING_MS = 1_000;
const P99_CEILING_MS = 2_000;

const WEIGHTS = {
  throughput: 0.45,
  p50: 0.20,
  p95: 0.20,
  p99: 0.15,
} as const;

function scoreHigher(value: number, ceiling: number): number {
  return Math.max(0, Math.min(100, (value / ceiling) * 100));
}

function scoreLower(value: number, ceiling: number): number {
  return Math.max(0, Math.min(100, (1 - value / ceiling) * 100));
}

function scoreCell(cell: StorageConcurrencyCellResult): number {
  const metrics: { weight: number; score: number | null }[] = [
    {
      weight: WEIGHTS.throughput,
      score: scoreHigher(cell.throughputOpsPerSecond, THROUGHPUT_CEILING_OPS),
    },
    {
      weight: WEIGHTS.p50,
      score: cell.p50Ms === null ? null : scoreLower(cell.p50Ms, P50_CEILING_MS),
    },
    {
      weight: WEIGHTS.p95,
      score: cell.p95Ms === null ? null : scoreLower(cell.p95Ms, P95_CEILING_MS),
    },
    {
      weight: WEIGHTS.p99,
      score: cell.p99Ms === null ? null : scoreLower(cell.p99Ms, P99_CEILING_MS),
    },
  ];
  const available = metrics.filter((metric) => metric.score !== null);
  const weight = available.reduce((sum, metric) => sum + metric.weight, 0);
  if (!cell.valid || weight === 0) return 0;
  const score = available.reduce((sum, metric) => sum + metric.weight * metric.score!, 0) / weight;
  return score;
}

export function scoreStorageConcurrencyProvider(
  result: Pick<StorageConcurrencyProviderResult, 'provider' | 'cells'>,
): StorageConcurrencyScore {
  if (result.cells.length === 0) {
    return { compositeScore: 0, successRate: 0, validCellRate: 0 };
  }

  const cellScore = result.cells.reduce((sum, cell) => sum + scoreCell(cell), 0) / result.cells.length;
  const successRate = result.cells.reduce((sum, cell) => sum + cell.successRate, 0) / result.cells.length;
  const validCellRate = result.cells.filter((cell) => cell.valid).length / result.cells.length;

  return {
    compositeScore: Math.round(cellScore * successRate * 100) / 100,
    successRate: Math.round(successRate * 10000) / 10000,
    validCellRate: Math.round(validCellRate * 10000) / 10000,
  };
}
