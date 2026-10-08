import { chromium, type Page, type Browser, type BrowserContext } from 'playwright-native-core';
import { randomUUID } from 'node:crypto';
import { TaskError, type TaskContext, type TaskStepOptions } from '@benchsdk/runner';
import type { JsonObject } from '@benchsdk/api';
import { withTimeout } from '../../src/util/timeout.js';
import { CLEANUP_TIMEOUT_MS, CONNECT_TIMEOUT_MS, VIEWPORT, nativeParticipants, safeError, type NativeParticipant } from './providers.js';

const unsafeParticipants = new WeakSet<NativeParticipant>();

export const nativeConfig = {
  iterations: 100,
  concurrency: 1,
  groupBy: 'round' as const,
  participants: nativeParticipants,
};

/** Timer spans the first provider request through workload completion only. */
export async function runSession(
  ctx: TaskContext<NativeParticipant>,
  workload: (page: Page, startedAt: number, data: JsonObject) => Promise<void>,
): Promise<{ data: JsonObject }> {
  if (unsafeParticipants.has(ctx.participant)) {
    throw new TaskError('Participant stopped after uncertain cleanup; verify resources before rerunning', {
      code: 'CLEANUP_UNCERTAIN', data: { attemptStarted: false },
    });
  }
  // Read credentials and validate settings before starting the timer.
  const session = ctx.participant.session(randomUUID());
  const data: JsonObject = { ...session.metadata, attemptStarted: true, workloadSuccess: false, cleanupSuccess: false };
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let secrets: string[] = [];
  let failure: string | undefined;
  const cleanupErrors: string[] = [];
  // Redact errors before the runner records step diagnostics.
  const step = <T>(name: string, fn: () => Promise<T>, options?: Pick<TaskStepOptions, 'reportConcurrency'>) =>
    ctx.step(name, async () => {
      try { return await fn(); }
      catch (error) { throw new Error(safeError(error, secrets)); }
    }, options);
  const startedAt = performance.now();
  try {
    const connection = await step('provision', () => session.provision());
    secrets = Object.values(connection.headers);
    browser = await step('connect', () => chromium.connect(connection.endpoint, { headers: connection.headers, timeout: CONNECT_TIMEOUT_MS }));
    data.chromiumVersion = browser.version();
    data.runnerOs = process.platform;
    data.nodeVersion = process.version;
    const connected = browser;
    const page = await step('page', async () => {
      context = await withTimeout(connected.newContext({ viewport: VIEWPORT }), CONNECT_TIMEOUT_MS, 'Context creation timed out');
      context.setDefaultTimeout(30_000);
      context.setDefaultNavigationTimeout(30_000);
      return withTimeout(context.newPage(), CONNECT_TIMEOUT_MS, 'Page creation timed out');
    });
    await workload(page, startedAt, data);
    data.workloadSuccess = true;
  } catch (error) {
    failure = safeError(error, secrets);
    data.failedAfterMs = performance.now() - startedAt;
  } finally {
    const cleanupStart = performance.now();
    const cleanup = async (name: string, fn: () => Promise<unknown>) => {
      try {
        await step(name, () => withTimeout(fn(), CLEANUP_TIMEOUT_MS, `${name} timed out`), { reportConcurrency: false });
      } catch (error) { cleanupErrors.push(safeError(error, secrets)); }
    };
    for (const [name, resource] of [['close-context', context], ['close-browser', browser]] as const) {
      if (resource) await cleanup(name, () => resource.close());
    }
    await cleanup('release', () => session.cleanup({ connected: browser !== undefined }));
    data.cleanupMs = performance.now() - cleanupStart;
    data.cleanupSuccess = cleanupErrors.length === 0;
    Object.assign(data, session.metadata);
    if (cleanupErrors.length) {
      data.cleanupErrors = cleanupErrors;
      unsafeParticipants.add(ctx.participant);
    }
  }
  data.sessionSuccess = data.workloadSuccess === true && data.cleanupSuccess === true;
  if (failure) data.errorMessage = failure;
  ctx.measure(data);
  if (failure || cleanupErrors.length) {
    throw new TaskError(failure ?? 'Session cleanup failed', { code: 'PLAYWRIGHT_NATIVE_ERROR', data });
  }
  return { data };
}
