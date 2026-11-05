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
  let timedOut = false;
  if (onLate) {
    promise.then(
      (value) => {
        if (timedOut) Promise.resolve().then(() => onLate(value)).catch(() => {});
      },
      () => {},
    );
  }
  return Promise.race([
    promise.finally(() => { if (timer) clearTimeout(timer); }),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        reject(new Error(message));
      }, ms);
    }),
  ]);
}
