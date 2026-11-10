/** Shared numerical contract; keep the runner and platform copies byte-identical. */
export interface ScoringMethodology {
  version?: 2;
  methodology?: string;
}
export interface ScoringTransform {
  kind: 'reciprocal';
  reference: number;
}
export interface ScoringMetricContract {
  ceiling: number;
  floor?: number;
  higherIsBetter?: boolean;
  transform?: ScoringTransform;
  weights: { median: number; p95: number; p99: number };
  trim?: number;
}
export function validateMethodology(spec: ScoringMethodology): void {
  if (spec.version !== undefined && spec.version !== 2) throw new Error('Unknown scoring version');
  if (spec.version === 2) {
    if (typeof spec.methodology !== 'string' || !spec.methodology.trim()) throw new Error('v2 requires a methodology identifier');
  } else if (spec.methodology !== undefined) {
    throw new Error('methodology requires scoring version 2');
  }
}
export function validateMetricContract(metric: ScoringMetricContract, spec: ScoringMethodology): void {
  const transform = metric.transform;
  if (transform !== undefined && (spec.version !== 2 || transform === null ||
    transform.kind !== 'reciprocal' || !Number.isFinite(transform.reference) || transform.reference <= 0)) {
    throw new Error('Unknown or invalid scoring transform; reciprocal requires v2 and a positive reference');
  }
  if (spec.version !== 2) return;
  if (!Number.isFinite(metric.ceiling) || metric.ceiling <= 0 ||
    (metric.floor !== undefined && (!Number.isFinite(metric.floor) || metric.floor < 0 || metric.floor >= metric.ceiling)) ||
    (metric.trim !== undefined && (!Number.isFinite(metric.trim) || metric.trim < 0 || metric.trim >= 0.5)) ||
    Object.values(metric.weights).some(w => !Number.isFinite(w) || w < 0)) {
    throw new Error('Invalid v2 metric bounds, trim or weights');
  }
}
export function transformStatistic(stat: number, metric: ScoringMetricContract): number {
  if (metric.transform) {
    const reference = metric.transform.reference;
    return metric.higherIsBetter
      ? (stat === 0 ? 0 : 100 / (1 + reference / stat))
      : 100 / (1 + stat / reference);
  }
  if (metric.higherIsBetter) {
    const floor = metric.floor ?? 0;
    if (stat <= floor) return 0;
    if (stat >= metric.ceiling) return 100;
    return ((stat - floor) / (metric.ceiling - floor)) * 100;
  }
  return Math.max(0, 100 * (1 - stat / metric.ceiling));
}
