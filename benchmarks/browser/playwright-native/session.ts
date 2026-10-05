import { chromium, type Page, type Browser, type BrowserContext } from 'playwright-native-core';
import { randomUUID } from 'node:crypto';
import { TaskError, type TaskContext } from '@benchsdk/runner';
import type { JsonObject } from '@benchsdk/api';
import { withTimeout } from '../../src/util/timeout.js';
import { CLEANUP_TIMEOUT_MS, CONNECT_TIMEOUT_MS, nativeParticipants, safeError, type NativeParticipant } from './providers.js';

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
  // Prepare reusable credentials and validate the environment before timing.
  const session = ctx.participant.session(randomUUID());
  const data: JsonObject = { ...session.metadata, attemptStarted: true, workloadSuccess: false, cleanupSuccess: false };
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let secrets: string[] = [];
  let failure: string | undefined;
  const cleanupErrors: string[] = [];
  const guarded = async <T>(fn: () => Promise<T>): Promise<T> => {
    try { return await fn(); } catch (error) { throw new Error(safeError(error, secrets)); }
  };
  const startedAt = performance.now();
  try {
    const connection = await ctx.step('provision', () => guarded(() => session.provision()));
    Object.assign(data, session.metadata);
    secrets = Object.values(connection.headers);
    browser = await ctx.step('connect', () => guarded(() => chromium.connect(connection.endpoint, { headers: connection.headers, timeout: CONNECT_TIMEOUT_MS })));
    data.chromiumVersion = browser.version();
    data.runnerOs = process.platform;
    data.nodeVersion = process.version;
    const connected = browser;
    const page = await ctx.step('page', () => guarded(async () => {
      context = await withTimeout(connected.newContext({ viewport: { width: 1920, height: 1080 } }), CONNECT_TIMEOUT_MS, 'Context creation timed out');
      context.setDefaultTimeout(30_000);
      context.setDefaultNavigationTimeout(30_000);
      return withTimeout(context.newPage(), CONNECT_TIMEOUT_MS, 'Page creation timed out');
    }));
    await workload(page, startedAt, data);
    data.workloadSuccess = true;
  } catch (error) {
    failure = safeError(error, secrets);
    data.failedAfterMs = performance.now() - startedAt;
  } finally {
    const cleanupStart = performance.now();
    const cleanup = async (name: string, fn: () => Promise<unknown>) => {
      try {
        await ctx.step(name, () => guarded(() => withTimeout(fn(), CLEANUP_TIMEOUT_MS, `${name} timed out`)), { reportConcurrency: false });
      } catch (error) { cleanupErrors.push(safeError(error, secrets)); }
    };
    if (context) {
      const activeContext = context;
      await cleanup('close-context', () => activeContext.close());
    }
    if (browser) {
      const activeBrowser = browser;
      await cleanup('close-browser', () => activeBrowser.close());
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
