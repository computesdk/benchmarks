/** Shared numeric helpers for storage benchmarks. */

export function round(n: number): number {
  return Math.round(n * 100) / 100;
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.min(idx, sorted.length - 1)];
}

export interface Stats {
  median: number;
  p95: number;
  p99: number;
}

/**
 * Compute median/p95/p99 over a set of samples, trimming the top and bottom 5%
 * to dampen outliers (matches the storage upload/download benchmark).
 */
export function computeStats(values: number[]): Stats {
  if (values.length === 0) return { median: 0, p95: 0, p99: 0 };

  const sorted = [...values].sort((a, b) => a - b);
  const trimCount = Math.floor(sorted.length * 0.05);
  const trimmed = trimCount > 0 && sorted.length - 2 * trimCount > 0
    ? sorted.slice(trimCount, sorted.length - trimCount)
    : sorted;

  const mid = Math.floor(trimmed.length / 2);
  const median = trimmed.length % 2 === 0
    ? (trimmed[mid - 1] + trimmed[mid]) / 2
    : trimmed[mid];

  return {
    median,
    p95: percentile(trimmed, 95),
    p99: percentile(trimmed, 99),
  };
}

export function roundStats(s: Stats): Stats {
  return { median: round(s.median), p95: round(s.p95), p99: round(s.p99) };
}
