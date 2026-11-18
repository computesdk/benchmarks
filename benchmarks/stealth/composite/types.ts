/**
 * Participant shape for meta-benchmarks that never provision compute.
 * `createCompute` is kept only for parity with the sandbox provider type;
 * composite benchmarks implement it as a stub that throws if invoked.
 */
export interface ProviderConfig {
  /** Provider identity — must equal the `provider` field reported in platform run summaries. */
  name: string;
  requiredEnvVars: string[];
  createCompute: () => unknown;
}
