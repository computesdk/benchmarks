/** Preserve future raw volume observations without changing v1 scored fields. */
const RAW_DURATION_KEYS = {
  volumeCreateMs: 'volumeCreateRawMs',
  mountedReadyMs: 'mountedReadyRawMs',
  reattachMs: 'reattachRawMs',
  verifyMs: 'verifyRawMs',
} as const;

const RAW_RATE_KEYS = {
  seqWriteMBps: 'seqWriteRawMBps',
  seqReadMBps: 'seqReadRawMBps',
  smallFileOpsPerSec: 'smallFileRawOpsPerSec',
} as const;

function finiteNonnegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

export function parseStateVolumeNs(stdout: string): number {
  const marker = stdout.match(/^NS=(\d+)\s*$/m);
  const elapsed = marker ? Number(marker[1]) : NaN;
  if (!Number.isSafeInteger(elapsed) || elapsed <= 0) throw new Error('missing or invalid positive NS timing marker');
  return elapsed;
}

export function stateVolumeDurationFields(key: keyof typeof RAW_DURATION_KEYS, elapsedMs: number): Record<string, number> {
  if (!finiteNonnegative(elapsedMs)) throw new Error(`invalid ${key} duration`);
  return { [key]: Math.round(elapsedMs), [RAW_DURATION_KEYS[key]]: elapsedMs };
}

export function stateVolumeRateFields(key: keyof typeof RAW_RATE_KEYS, units: number, elapsedNs: number): Record<string, number> {
  if (!Number.isSafeInteger(elapsedNs) || elapsedNs <= 0 || !finiteNonnegative(units) || units === 0) {
    throw new Error(`invalid ${key} rate inputs`);
  }
  const rate = units / (elapsedNs / 1e9);
  if (!Number.isFinite(rate) || rate <= 0) throw new Error(`invalid ${key} rate`);
  return { [key]: Math.round(rate * 10) / 10, [RAW_RATE_KEYS[key]]: rate };
}

/** Missing/invalid observations are errors; zero is never a missing-data default. */
export function stateVolumeMeasurements(data: Readonly<Record<string, unknown>>): Record<string, number> {
  const measurements: Record<string, number> = {};
  for (const key of [...Object.keys(RAW_DURATION_KEYS), ...Object.keys(RAW_RATE_KEYS)]) {
    const value = data[key];
    if (!finiteNonnegative(value)) throw new Error(`missing or invalid volume measurement ${key}`);
    measurements[key] = value;
  }
  return { latencyMs: measurements.mountedReadyMs, ...measurements };
}
