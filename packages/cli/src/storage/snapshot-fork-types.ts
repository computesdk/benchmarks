import type { Stats } from './stats.js';

/**
 * A seeded-dataset shape for the snapshot/fork benchmark.
 *
 * The seeded dataset is the variable that matters: native zero-copy adapters
 * (Tigris) create snapshots/forks in ~constant time regardless of dataset size,
 * while copy-based emulation (S3, R2, GCS, Azure) scales with object count and
 * total bytes. Running an object-count-heavy spec alongside a byte-heavy spec
 * separates per-object overhead from bytes-copied cost.
 */
export interface DatasetSpec {
  /** Number of objects to seed into the bucket. */
  objectCount: number;
  /** Size of each seeded object in bytes. */
  objectSizeBytes: number;
}

export type DatasetPreset = 'small' | 'wide' | 'deep';

/** Named dataset presets selectable via `--dataset`. */
export const DATASET_PRESETS: Record<DatasetPreset, DatasetSpec> = {
  // 10MB across few objects — baseline, cheap to seed.
  small: { objectCount: 10, objectSizeBytes: 1 * 1024 * 1024 },
  // 100MB across many small objects — exposes per-object copy overhead.
  wide: { objectCount: 100, objectSizeBytes: 1 * 1024 * 1024 },
  // 160MB across few large objects — exposes bytes-copied cost.
  deep: { objectCount: 10, objectSizeBytes: 16 * 1024 * 1024 },
};

/** Timing for a single snapshot/fork iteration. */
export interface SnapshotForkTimingResult {
  /** Time to seed the dataset into the bucket in ms (informational). */
  seedMs: number;
  /** Time for snapshots.create() in ms. */
  snapshotCreateMs: number;
  /** Time for forks.create({ fromSnapshot }) in ms. */
  forkFromSnapshotMs: number;
  /** Time for forks.create() seeded from live parent state in ms. */
  forkFromLiveMs: number;
  /** Time to download one object from the fork (time-to-usable) in ms. */
  forkFirstReadMs: number;
  /** Whether the bytes read back from the fork matched the seeded object. */
  verified: boolean;
  /** Total bytes seeded for this iteration. */
  datasetBytes: number;
  /** Number of objects seeded for this iteration. */
  objectCount: number;
  /** Error message if this iteration failed. */
  error?: string;
}

export interface SnapshotForkStats {
  snapshotCreateMs: Stats;
  forkFromSnapshotMs: Stats;
  forkFromLiveMs: Stats;
  forkFirstReadMs: Stats;
}

export interface SnapshotForkBenchmarkResult {
  provider: string;
  mode: 'snapshot-fork';
  bucket: string;
  dataset: DatasetPreset;
  datasetBytes: number;
  objectCount: number;
  iterations: SnapshotForkTimingResult[];
  summary: SnapshotForkStats;
  /** Composite weighted score (0-100, higher = better). Computed post-benchmark. */
  compositeScore?: number;
  /** Success rate as a fraction (0 to 1). Computed post-benchmark. */
  successRate?: number;
  skipped?: boolean;
  skipReason?: string;
}
