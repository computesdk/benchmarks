/** Row/document used by the CRUD workload. */
export interface DatabaseDocument {
  /** Stable identifier for the row/document. */
  id: string;
  /** Human-readable value under test. */
  name: string;
  /** Fixed-size random payload used for comparable measurements. */
  payload: string;
  /** Application-managed version, incremented by the update phase. */
  version: number;
}

/**
 * Local abstraction for a database SDK that does not exist yet.
 * `setup()` creates provider resources once per participant and is untimed.
 */
export interface DatabaseClient {
  /** Create the benchmark table/collection; called once per participant. */
  setup(): Promise<void>;
  /** Insert a row/document. */
  create(doc: DatabaseDocument): Promise<void>;
  /** Read a row/document by identifier. */
  read(id: string): Promise<DatabaseDocument | null>;
  /** Update the mutable fields of a row/document. */
  update(
    id: string,
    patch: Pick<DatabaseDocument, 'name' | 'payload' | 'version'>,
  ): Promise<void>;
  /** Delete by identifier and return the number of removed rows/documents. */
  delete(id: string): Promise<number>;
  /** Close provider resources. */
  close(): Promise<void>;
}

/** Configuration for one database benchmark participant. */
export interface DatabaseProviderConfig {
  /** Provider name shown in benchmark output. */
  name: string;
  /** Environment variables required before this participant can run. */
  requiredEnvVars: string[];
  /** Table/collection name used by this participant. */
  table: string;
  /** Create the participant's database client. */
  createClient: () => DatabaseClient;
  /** Timeout per database operation in milliseconds. */
  timeout?: number;
}

/** Timings and payload size recorded for one CRUD cycle. */
export interface DatabaseTimingResult {
  createMs: number;
  readMs: number;
  updateMs: number;
  readAfterUpdateMs: number;
  deleteMs: number;
  totalMs: number;
  payloadBytes: number;
  error?: string;
}

/** Median and tail latency statistics for each CRUD phase. */
export interface DatabaseStats {
  createMs: { median: number; p95: number; p99: number };
  readMs: { median: number; p95: number; p99: number };
  updateMs: { median: number; p95: number; p99: number };
  readAfterUpdateMs: { median: number; p95: number; p99: number };
  deleteMs: { median: number; p95: number; p99: number };
  totalMs: { median: number; p95: number; p99: number };
}

/** Aggregate benchmark results for one database provider. */
export interface DatabaseBenchmarkResult {
  provider: string;
  mode: 'database';
  table: string;
  payloadBytes: number;
  iterations: DatabaseTimingResult[];
  summary: DatabaseStats;
  compositeScore?: number;
  successRate?: number;
  skipped?: boolean;
  skipReason?: string;
}
