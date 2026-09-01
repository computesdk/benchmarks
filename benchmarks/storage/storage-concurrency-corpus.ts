export const OBJECT_COUNT = 10_000;
export const PREFIX_COUNT = 64;
export const OBJECT_SIZE_BYTES = 1024;
export const KEY_STRIDE = 7919;
export const WORKER_PRIME = 104_729;
const SINGLE_PREFIX_OBJECT_COUNT = Math.ceil(OBJECT_COUNT / PREFIX_COUNT);

export type KeyDistribution = 'SINGLE_PREFIX' | 'SPREAD_64';

export function corpusKey(index: number): string {
  if (!Number.isInteger(index) || index < 0 || index >= OBJECT_COUNT) {
    throw new Error(`Corpus index must be between 0 and ${OBJECT_COUNT - 1}`);
  }
  const prefix = index % PREFIX_COUNT;
  return `bench/v1/p${prefix.toString().padStart(2, '0')}/obj${index.toString().padStart(6, '0')}`;
}

export function requestKey(
  workerId: number,
  opSeq: number,
  distribution: KeyDistribution,
): string {
  const rawIndex = distribution === 'SINGLE_PREFIX'
    ? (workerId * WORKER_PRIME + opSeq * KEY_STRIDE) % SINGLE_PREFIX_OBJECT_COUNT
    : (workerId * WORKER_PRIME + opSeq * KEY_STRIDE) % OBJECT_COUNT;
  const index = distribution === 'SINGLE_PREFIX' ? rawIndex * PREFIX_COUNT : rawIndex;
  return corpusKey(index);
}

/** Stable 1 KB body shared by every seeded object. */
export function corpusBody(): Uint8Array {
  return Uint8Array.from(
    { length: OBJECT_SIZE_BYTES },
    (_, index) => (index * 31 + 17) % 256,
  );
}
