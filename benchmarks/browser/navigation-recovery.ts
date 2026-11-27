import { setTimeout as sleep } from 'node:timers/promises';

interface NavigationRequest {
  isNavigationRequest(): boolean;
  frame(): unknown;
  method(): string;
}

interface NavigationResponse {
  url(): string;
  status(): number;
  allHeaders(): Promise<Record<string, string>>;
  request(): NavigationRequest;
}

/** Structural types also accept the separately versioned Playwright client. */
interface NavigationPage {
  on(event: 'response', listener: (response: NavigationResponse) => void): unknown;
  off(event: 'response', listener: (response: NavigationResponse) => void): unknown;
  mainFrame(): unknown;
  url(): string;
  goto(url: string, options: { waitUntil: 'load'; timeout: number }): Promise<NavigationResponse | null>;
  reload(options: { waitUntil: 'load'; timeout: number }): Promise<NavigationResponse | null>;
  waitForSelector(selector: string, options: { timeout: number }): Promise<unknown>;
}

export type NavigationRecoveryEvent = {
  type: 'http429';
  url: string;
  status: 429;
  method: string;
  at: string;
  retryAfter?: string;
} | {
  type: 'retry';
  url: string;
  attempt: number;
  retryAfter: string;
  minimumWaitMs: number;
  scheduledWaitMs: number;
  at: string;
  actualWaitMs?: number;
  reloadMs?: number;
  responseStatus?: number;
};

export interface NavigationRecoveryOptions {
  maxRetries?: number;
  maxRecoveryMs?: number;
  timeoutMs?: number;
  jitterMs?: number;
}

export class Navigation429Error extends Error {
  readonly status = 429;
  constructor(
    readonly url: string,
    readonly retryAfter: string | undefined,
    readonly retries: number,
    reason: string,
  ) {
    super(`HTTP 429 at ${url}; Retry-After=${retryAfter ?? 'missing'}; retries=${retries}: ${reason}`);
    this.name = 'Navigation429Error';
  }
}

function retryAfterMs(value: string | undefined): number {
  if (value === undefined) return NaN;
  const text = value.trim();
  if (/^\d+$/.test(text)) return Number(text) * 1000;
  // Date.parse alone accepts non-HTTP values such as "0.5" as past dates.
  const imf = /^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/i;
  const rfc850 = /^[A-Za-z]+, \d{2}-[A-Za-z]{3}-\d{2} \d{2}:\d{2}:\d{2} GMT$/i;
  const asctime = /^[A-Za-z]{3} [A-Za-z]{3} [ \d]\d \d{2}:\d{2}:\d{2} \d{4}$/;
  const date = imf.test(text) || rfc850.test(text) ? Date.parse(text)
    : asctime.test(text) ? Date.parse(text + ' GMT') : NaN;
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : NaN;
}

function documentUrl(url: string): string {
  const parsed = new URL(url);
  parsed.hash = '';
  return parsed.href;
}

/**
 * Attach before goto/click. Call navigate/waitForSelector inside the existing
 * timed actions: backoff and reloads are never subtracted from measurements.
 * One navigation's retry budget survives subsequent readiness calls, so an
 * exhausted goto cannot silently gain two more retries in the next action.
 */
export function installNavigationRecovery(page: NavigationPage, options: NavigationRecoveryOptions = {}) {
  const { maxRetries = 2, maxRecoveryMs = 10_000, timeoutMs = 30_000, jitterMs = 250 } = options;
  for (const [name, value] of Object.entries({ maxRetries, maxRecoveryMs, timeoutMs, jitterMs })) {
    if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid ${name}`);
  }
  if (!Number.isInteger(maxRetries)) throw new Error('maxRetries must be an integer');
  const abort = new AbortController();
  const events: NavigationRecoveryEvent[] = [];
  const observed = new WeakMap<NavigationResponse, Extract<NavigationRecoveryEvent, { type: 'http429' }>>();
  const waiters = new Set<(response: NavigationResponse) => void>();
  let latest: NavigationResponse | null = null;
  let reloading = false;
  let budget = { retries: 0, started: null as number | null };

  const onResponse = (response: NavigationResponse) => {
    let mainDocument = false;
    try {
      const request = response.request();
      mainDocument = request.isNavigationRequest() && request.frame() === page.mainFrame();
    } catch { /* detached/service-worker requests are not current main documents */ }
    if (!mainDocument) return;
    if (!reloading) budget = { retries: 0, started: null };
    latest = response;
    if (response.status() === 429) {
      const event = { type: 'http429' as const, url: response.url(), status: 429 as const,
        method: response.request().method(), at: new Date().toISOString() };
      events.push(event);
      observed.set(response, event);
      for (const waiter of waiters) waiter(response);
    }
  };
  page.on('response', onResponse);

  function remaining(deadline: number): number {
    if (abort.signal.aborted) throw new Error('Navigation recovery disposed');
    const left = deadline - performance.now();
    if (left <= 0) throw new Error('Navigation recovery timed out');
    return left;
  }

  async function within<T>(promise: Promise<T>, deadline: number): Promise<T> {
    const timer = new AbortController();
    const stop = () => timer.abort();
    abort.signal.addEventListener('abort', stop, { once: true });
    try {
      return await Promise.race([promise, sleep(remaining(deadline), undefined, { signal: timer.signal }).then(() => {
        throw new Error('Navigation recovery timed out');
      })]);
    } finally {
      timer.abort();
      abort.signal.removeEventListener('abort', stop);
    }
  }

  async function recover(response: NavigationResponse | null, deadline: number): Promise<NavigationResponse | null> {
    while (response?.status() === 429) {
      budget.started ??= performance.now();
      const recoveryDeadline = Math.min(deadline, budget.started + maxRecoveryMs);
      const header = (await within(response.allHeaders(), recoveryDeadline))['retry-after'];
      const first = observed.get(response);
      if (first) first.retryAfter = header;
      const fail = (reason: string): never => { throw new Navigation429Error(response!.url(), header, budget.retries, reason); };
      if (!['GET', 'HEAD'].includes(response.request().method().toUpperCase())) fail('unsafe request method');
      if (budget.retries >= maxRetries) fail('retry limit reached');
      const minimum = retryAfterMs(header);
      if (!Number.isFinite(minimum)) fail('missing or invalid Retry-After; no automatic retry');
      const delay = minimum + Math.floor(Math.random() * (jitterMs + 1));
      if (performance.now() - budget.started + delay > maxRecoveryMs || delay >= remaining(deadline)) {
        fail('Retry-After exceeds the recovery/action budget; no shortened wait');
      }
      if (documentUrl(page.url()) !== documentUrl(response.url())) fail('page moved away from the failed document');
      const event: Extract<NavigationRecoveryEvent, { type: 'retry' }> = {
        type: 'retry', url: response.url(), attempt: ++budget.retries, retryAfter: header!,
        minimumWaitMs: minimum, scheduledWaitMs: delay, at: new Date().toISOString(),
      };
      events.push(event);
      const start = performance.now();
      const due = start + delay;
      while (performance.now() < due) {
        remaining(deadline);
        await sleep(Math.max(1, Math.ceil(due - performance.now())), undefined, { signal: abort.signal });
      }
      event.actualWaitMs = performance.now() - start;
      if (documentUrl(page.url()) !== documentUrl(response.url())) fail('page moved away from the failed document');
      const reloadStart = performance.now();
      reloading = true;
      try {
        response = await page.reload({ waitUntil: 'load', timeout: remaining(recoveryDeadline) });
        latest = response;
        event.responseStatus = response?.status();
        event.reloadMs = performance.now() - reloadStart;
      } finally {
        reloading = false;
      }
    }
    return response;
  }

  return {
    async navigate(url: string): Promise<NavigationResponse | null> {
      const deadline = performance.now() + timeoutMs;
      latest = null;
      budget = { retries: 0, started: null };
      return recover(await page.goto(url, { waitUntil: 'load', timeout: remaining(deadline) }), deadline);
    },
    async waitForSelector(selector: string): Promise<unknown> {
      const deadline = performance.now() + timeoutMs;
      for (;;) {
        // A history/BFCache restore may not emit a fresh HTTP response.
        if (latest && documentUrl(latest.url()) !== documentUrl(page.url())) latest = null;
        if (latest?.status() === 429) await recover(latest, deadline);
        let notify: ((response: NavigationResponse) => void) | undefined;
        try {
          const blocked = new Promise<never>((_, reject) => {
            notify = response => reject({ blockedResponse: response });
            waiters.add(notify);
          });
          return await Promise.race([within(page.waitForSelector(selector, { timeout: remaining(deadline) }), deadline), blocked]);
        } catch (error) {
          const response = (error as { blockedResponse?: NavigationResponse })?.blockedResponse;
          if (!response) throw error;
          if (notify) waiters.delete(notify);
          await recover(response, deadline);
        } finally {
          if (notify) waiters.delete(notify);
        }
      }
    },
    drainEvents(): NavigationRecoveryEvent[] { return events.splice(0); },
    lastHttpStatus(): number | undefined { return latest?.status(); },
    dispose(): void {
      abort.abort();
      page.off('response', onResponse);
      waiters.clear();
    },
  };
}
