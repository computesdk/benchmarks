const pendingLateCleanups = new Set<Promise<unknown>>();

/** Runs `cleanup` in the background and keeps it pending until `drainLateCleanups`. */
export function trackLateCleanup(cleanup: () => unknown): void {
  const p: Promise<unknown> = Promise.resolve()
    .then(cleanup)
    .catch((err: unknown) => console.warn(`late cleanup failed: ${err instanceof Error ? err.message : String(err)}`))
    .finally(() => pendingLateCleanups.delete(p));
  pendingLateCleanups.add(p);
}

/**
 * Waits (at most `maxMs`) for tracked late cleanups, including timed-out
 * requests that have not resolved yet. Call before `process.exit`, which would
 * otherwise cut them off.
 */
export async function drainLateCleanups(maxMs = 30_000): Promise<void> {
  if (pendingLateCleanups.size === 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => { timer = setTimeout(resolve, maxMs); });
  await Promise.race([Promise.allSettled([...pendingLateCleanups]), deadline]);
  if (timer) clearTimeout(timer);
  if (pendingLateCleanups.size > 0) {
    console.warn(`${pendingLateCleanups.size} late cleanup(s) still pending after ${maxMs}ms`);
  }
}

/**
 * Races `promise` against a timer. The timer cannot cancel the underlying
 * request, so if `promise` resolves after the timeout, `onLate` receives the
 * value (e.g. a sandbox to destroy) instead of it being silently dropped.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
  onLate?: (value: T) => unknown,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise.finally(() => { if (timer) clearTimeout(timer); }),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => {
        if (onLate) trackLateCleanup(() => promise.then(onLate, () => {}));
        reject(new Error(message));
      }, ms);
    }),
  ]);
}
