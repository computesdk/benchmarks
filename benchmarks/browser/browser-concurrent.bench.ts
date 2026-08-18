/**
 * Browser concurrent sessions benchmark: each round creates N browser sessions
 * in parallel, waits for all to be alive + connected (barrier), runs a fixed
 * 10-action loop on every session simultaneously, then releases all.
 *
 * One phase per concurrency level, one task each: the c1 task runs every round
 * at 1 session, the c50 task every round at 50, so a single platform run carries
 * the whole sweep and the task index becomes the concurrency axis — the
 * platform's per-iteration view is then the degradation curve.
 *
 * `--levels` picks which levels run; the rounds at each level are fixed by
 * ROUNDS_PER_LEVEL. There is deliberately no way to ask for "more iterations":
 * repeating a level means more rounds, which is a property of the level, and
 * the runner rejects `--iterations` outright because this benchmark declares
 * phases.
 *
 * This shape exists because a participant carries one task count for the whole
 * run, so the levels cannot be separate participants without also splitting
 * the providers apart. Keeping one participant per provider and spending its
 * five tasks on the five levels keeps provider rankings intact and still
 * reports each level separately, via a task index and per-level step names.
 *
 *   bench run benchmarks/browser/browser-concurrent.bench.ts
 *   bench run benchmarks/browser/browser-concurrent.bench.ts --levels 1,5
 *   bench run benchmarks/browser/browser-concurrent.bench.ts --provider browserbase --levels 50
 *
 * Results are still organized by concurrency level, mirroring the storage
 * benchmark's per-file-size directories:
 *   results/browser-concurrent/c1/, c5/, c10/, c25/, c50/
 *
 * Levels run one at a time within a task, and a cooldown separates them:
 * overlapping them would put two levels' sessions on the same provider account
 * at once, which destroys the comparison the benchmark is making.
 */
import '../src/env.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright-core';
import { defineBenchmarkConfig, defineTask, TaskError, type TaskContext } from '@benchsdk/runner';
import type { JsonValue } from '@benchsdk/client';
import { withTimeout } from '../src/util/timeout.js';
import { throughputProviders } from './throughput-providers.js';
import { ConcurrencyTracker, sessionHitActionTimeout, shouldStartLoop } from './concurrent-benchmark.js';
import { writeConcurrentSweepResults } from './concurrent-legacy-results.js';
import {
  ACTION_TIMEOUT_MS,
  ACTIONS_PER_LOOP,
  CONCURRENCY_LEVELS,
  LEVEL_ACTION_BUDGET_MS,
  LOOPS_PER_LEVEL,
  ROUNDS_PER_LEVEL,
  actionsPerSession,
  type ConcurrencyLevel,
  levelFromPhaseName,
  parseLevels,
  phaseNameForLevel,
  type ActionResult,
  type RoundResult,
  type SessionResult,
  type ConcurrentProviderConfig,
} from './concurrent-types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const concurrentTimeoutMs =
  throughputProviders.reduce((max, p) => Math.max(max, p.timeout ?? 120_000), 0) || 120_000;

// ── Custom CLI flag: --levels (the runner ignores flags it does not know) ─────
// Which levels to sweep, not how many times anything repeats: the rounds at each
// level are fixed by ROUNDS_PER_LEVEL. `--iterations` cannot express this, and
// the runner rejects it outright for benchmarks that declare phases.
const levelsArg = (() => {
  const argv = process.argv.slice(2);
  const idx = argv.indexOf('--levels');
  return idx !== -1 && idx + 1 < argv.length ? argv[idx + 1] : undefined;
})();
const { levels: SELECTED_LEVELS, error: levelsError } = parseLevels(levelsArg);
if (levelsError) {
  console.error(levelsError);
  process.exit(1);
}

/**
 * Rounds that fit in one task record: the client caps a record at 100 steps and
 * every round reports create/connect/actions/release.
 */
const MAX_ROUNDS_PER_TASK = 25;

/**
 * Overrides the per-level round count, for the push smoke test. Set to 1 there
 * so a workflow change can be exercised in a couple of minutes instead of
 * running the full 31 rounds.
 */
const ROUNDS_OVERRIDE = (() => {
  const raw = process.env.CONCURRENT_ROUNDS_PER_LEVEL;
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) return undefined;
  // Each round reports 4 steps and the client rejects a task record carrying
  // more than 100, which would throw away the whole level rather than trim it.
  if (parsed > MAX_ROUNDS_PER_TASK) {
    console.warn(
      `CONCURRENT_ROUNDS_PER_LEVEL=${parsed} exceeds the ${MAX_ROUNDS_PER_TASK} rounds that fit ` +
        `in one task record (4 steps each); using ${MAX_ROUNDS_PER_TASK}.`,
    );
    return MAX_ROUNDS_PER_TASK;
  }
  return parsed;
})();

/**
 * Pause between levels, so sessions a provider is still tearing down do not
 * count against the next level's quota. Providers cap concurrent sessions
 * (kernel at 10, steel at 5 on its hobby plan), and a release is acknowledged
 * before the slot is actually free, so without this the next level starts
 * against a partly occupied account and measures our own cleanup lag.
 */
const LEVEL_COOLDOWN_MS = (() => {
  const raw = process.env.CONCURRENT_LEVEL_COOLDOWN_MS;
  if (!raw) return 60_000;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 60_000;
})();

/**
 * Every round, in full detail, keyed by provider then level.
 *
 * The local result files are written from this rather than from the records
 * sent to the platform: a c50 task covers 1,500 actions, which does not belong
 * in a task payload, so the platform gets per-round aggregates while the
 * committed artifact keeps everything.
 */
const collectedRounds = new Map<string, Map<number, RoundResult[]>>();

function collectRound(provider: string, level: number, round: RoundResult): void {
  const byLevel = collectedRounds.get(provider) ?? new Map<number, RoundResult[]>();
  collectedRounds.set(provider, byLevel);
  const rounds = byLevel.get(level) ?? [];
  rounds.push(round);
  byLevel.set(level, rounds);
}

export const config = defineBenchmarkConfig({
  benchmarkSlug: 'browser-concurrency',
  benchmarkName: 'Browser Concurrency',
  // One phase per level, one task each: the phase names the level a record
  // belongs to, so nothing depends on task position, and declaring phases makes
  // the runner refuse `--iterations` instead of silently reinterpreting it as a
  // number of levels.
  phases: SELECTED_LEVELS.map((level) => ({ name: phaseNameForLevel(level), iterations: 1 })),
  concurrency: 1,
  participants: throughputProviders,
  onComplete: () =>
    writeConcurrentSweepResults(collectedRounds, {
      resultsRoot: path.resolve(__dirname, '../../results/browser-concurrent'),
      timeoutMs: concurrentTimeoutMs,
    }),
});

// ── Wikipedia action loop (same as throughput benchmark, 1 loop = 10 actions) ─
const RANDOM_URL = 'https://en.wikipedia.org/wiki/Special:Random';
const FIRST_HEADING = '#firstHeading';
const ARTICLE_LINK_SELECTOR = '#mw-content-text a[href*="/wiki/"]';

const NAV_URLS: string[] = parseNavUrls();

function parseNavUrls(): string[] {
  const raw = process.env.THROUGHPUT_URLS?.trim();
  if (!raw) return [];
  if (raw.startsWith('[')) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.filter((u): u is string => typeof u === 'string' && u.length > 0);
    } catch {
      // fall through
    }
  }
  return raw.split(/\s+/).filter(u => u.length > 0);
}

/**
 * Pick the article for one session.
 *
 * Indexing by session rather than by round keeps the page mix comparable
 * across concurrency levels. Sharing a single URL per round would let a c50
 * round hit one CDN-warmed article with 50 sessions while a c1 round pays
 * cold-fetch cost on a different article every time, so page weight and cache
 * state would vary with the dimension under test.
 */
function navUrlForSession(concurrencyLevel: number, roundIndex: number, sessionIndex: number): string {
  if (NAV_URLS.length === 0) return RANDOM_URL;
  return NAV_URLS[(roundIndex * concurrencyLevel + sessionIndex) % NAV_URLS.length];
}

function isArticleLink(href: string | null): boolean {
  if (!href) return false;
  const match = href.match(/\/wiki\/([^#]*)/);
  if (!match) return false;
  return !match[1].includes(':');
}

async function timeAction<T>(
  fn: () => Promise<T>,
): Promise<{ durationMs: number; success: boolean; error?: string; value?: T }> {
  const start = performance.now();
  try {
    const value = await withTimeout(fn(), ACTION_TIMEOUT_MS, 'Action timed out');
    return { durationMs: performance.now() - start, success: true, value };
  } catch (err) {
    return { durationMs: performance.now() - start, success: false, error: errorMessage(err) };
  }
}

/**
 * Run the 10-action loop on a single page. Identical to the throughput
 * benchmark's loop but with LOOPS_PER_SESSION=1 (one loop = 10 actions).
 */
/** A session the provider actually handed back, with its own create latency. */
interface CreatedSession {
  sessionId: string;
  connectUrl: string;
  createMs: number;
}

/**
 * Not every provider SDK rejects with an Error: notte throws a plain object,
 * which `String()` flattens to "[object Object]" and discards the reason a
 * session was refused — the one thing a capacity failure needs to report.
 */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (err !== null && typeof err === 'object') {
    const record = err as Record<string, unknown>;
    for (const key of ['message', 'error', 'detail']) {
      const value = record[key];
      if (typeof value === 'string' && value.length > 0) return value;
    }
    try {
      const json = JSON.stringify(err);
      if (json && json !== '{}') return json;
    } catch {
      // Circular or non-serializable; fall through to String().
    }
  }
  return String(err);
}

/**
 * Distinct failure reasons with their counts. A capacity collapse is often
 * mixed — kernel refused sessions for both a concurrency cap and a rate limit
 * in the same round — so reporting only the first reason mis-attributes it.
 */
function reasonCounts(errors: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const error of errors) {
    const key = error.slice(0, 200);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

/**
 * Sessions live on the provider across the whole process, so this is module
 * scoped: a level that overlapped the previous one shows up as a peak above its
 * own session count, which is what a per-round counter would miss.
 */
const liveSessionTracker = new ConcurrencyTracker();

interface ActionLoopOptions {
  loops: number;
  /** performance.now() value after which no further loop starts. */
  deadline: number;
  /** Called around the session's active window so the round can measure concurrency. */
  track: ConcurrencyTracker;
}

async function runActionLoop(
  page: Page,
  results: ActionResult[],
  navigateUrl: string,
  options: ActionLoopOptions,
): Promise<void> {
  const { loops, deadline, track } = options;
  const release = track.enter();
  try {
  for (let loop = 0; loop < loops; loop++) {
    // Checked between loops so every session stops on a loop boundary and the
    // level holds its concurrency for as long as it runs.
    if (!shouldStartLoop(loop, performance.now(), deadline)) break;
    const baseIdx = loop * ACTIONS_PER_LOOP;

    // 1. Navigate
    {
      const r = await timeAction(() =>
        page.goto(navigateUrl, { waitUntil: 'load' }) as Promise<unknown>,
      );
      results.push({ index: baseIdx + 1, type: 'navigate', durationMs: r.durationMs, success: r.success, error: r.error });
    }

    // 2. Wait for #firstHeading
    {
      const r = await timeAction(() => page.waitForSelector(FIRST_HEADING));
      results.push({ index: baseIdx + 2, type: 'waitForSelector', durationMs: r.durationMs, success: r.success, error: r.error });
    }

    // 3. Screenshot
    {
      const r = await timeAction(() => page.screenshot());
      results.push({ index: baseIdx + 3, type: 'screenshot', durationMs: r.durationMs, success: r.success, error: r.error });
    }

    // 4. Read text content of #firstHeading
    {
      const r = await timeAction(() => page.textContent(FIRST_HEADING));
      results.push({ index: baseIdx + 4, type: 'textContent', durationMs: r.durationMs, success: r.success, error: r.error });
    }

    // 5. Click first article link
    let clickSucceeded = false;
    {
      const r = await timeAction(async () => {
        await page.waitForSelector(ARTICLE_LINK_SELECTOR, { timeout: 10_000 });
        const links = await page.$$(ARTICLE_LINK_SELECTOR);
        for (const link of links) {
          const href = await link.getAttribute('href');
          if (isArticleLink(href)) {
            await link.click();
            return;
          }
        }
        throw new Error('No article body link found on page');
      });
      clickSucceeded = r.success;
      results.push({ index: baseIdx + 5, type: 'click', durationMs: r.durationMs, success: r.success, error: r.error });
    }

    if (!clickSucceeded) {
      for (const idx of [6, 7, 8, 9, 10]) {
        results.push({
          index: baseIdx + idx,
          type: idx <= 8 ? (idx === 6 || idx === 10 ? 'waitForSelector' : idx === 7 ? 'screenshot' : 'textContent') : 'goBack',
          durationMs: 0,
          success: false,
          error: 'skipped: click failed',
        });
      }
      continue;
    }

    // 6. Wait for #firstHeading on the new page
    {
      const r = await timeAction(() => page.waitForSelector(FIRST_HEADING));
      results.push({ index: baseIdx + 6, type: 'waitForSelector', durationMs: r.durationMs, success: r.success, error: r.error });
    }

    // 7. Screenshot the new page
    {
      const r = await timeAction(() => page.screenshot());
      results.push({ index: baseIdx + 7, type: 'screenshot', durationMs: r.durationMs, success: r.success, error: r.error });
    }

    // 8. Read text content of #firstHeading on the new page
    {
      const r = await timeAction(() => page.textContent(FIRST_HEADING));
      results.push({ index: baseIdx + 8, type: 'textContent', durationMs: r.durationMs, success: r.success, error: r.error });
    }

    // 9. Go back (waitUntil: 'commit' for bfcache compatibility)
    {
      const r = await timeAction(() => page.goBack({ waitUntil: 'commit' }) as Promise<unknown>);
      results.push({ index: baseIdx + 9, type: 'goBack', durationMs: r.durationMs, success: r.success, error: r.error });
    }

    // 10. Wait for #firstHeading on the previous page
    {
      const r = await timeAction(() => page.waitForSelector(FIRST_HEADING));
      results.push({ index: baseIdx + 10, type: 'waitForSelector', durationMs: r.durationMs, success: r.success, error: r.error });
    }
  }
  } finally {
    release();
  }
}

// ── Provider cache (thread-safe lazy init) ───────────────────────────────────
const providerCache = new Map<string, any>();
const providerInitPromises = new Map<string, Promise<any>>();

async function getProvider(participant: ConcurrentProviderConfig): Promise<any> {
  const cached = providerCache.get(participant.name);
  if (cached) return cached;

  let initPromise = providerInitPromises.get(participant.name);
  if (!initPromise) {
    initPromise = Promise.resolve(participant.createBrowserProvider());
    providerInitPromises.set(participant.name, initPromise);
  }
  const provider = await initPromise;
  providerCache.set(participant.name, provider);
  return provider;
}

// ── One barrier round ────────────────────────────────────────────────────────
type RoundContext = Pick<TaskContext<ConcurrentProviderConfig>, 'participant' | 'step' | 'log'> & {
  concurrencyLevel: number;
  roundIndex: number;
};

/**
 * Runs one barrier round and always returns its result, including when the
 * provider refuses every session. `harnessFailure` is reserved for our own
 * bugs: a provider refusing load is a measurement, not an error.
 */
async function runRound(ctx: RoundContext): Promise<{ round: RoundResult; harnessFailure: boolean }> {
  const { participant, step, log, concurrencyLevel, roundIndex } = ctx;
  const timeout = participant.timeout ?? 120_000;
  const sessionCreateOptions = participant.sessionCreateOptions ?? {};

  const provider = await getProvider(participant);

  const totalStart = performance.now();
  let createMs = 0;
  let connectMs = 0;
  let taskMs = 0;
  let releaseMs = 0;
  let sessionsAlive = 0;
  let aggregateActionsPerSecond = 0;
  let createTimedOut = false;
  const sessionResults: SessionResult[] = [];
  let roundError: string | undefined;
  let harnessFailure = false;

  // Declared outside try so the finally block can close them.
  let browsers: Browser[] = [];
  let aliveSessions: CreatedSession[] = [];

  // Every session id the provider hands back, whether or not the round goes on
  // to use it. The finally block destroys all of them: releasing only the
  // sessions that reached the action phase leaks the rest, and leaked sessions
  // hold provider quota until their idle timeout, which corrupts later rounds.
  const createdSessionIds = new Set<string>();
  let cleanupComplete = false;

  const liveWatch = liveSessionTracker.watch();
  const actionTracker = new ConcurrencyTracker();
  const actionWatch = actionTracker.watch();
  const loops = LOOPS_PER_LEVEL[concurrencyLevel as ConcurrencyLevel];

  // One release per session id, so double destroys cannot double count.
  const liveReleases = new Map<string, () => void>();
  const destroySession = (sessionId: string) =>
    withTimeout(
      Promise.resolve(provider.session.destroy(sessionId)),
      15_000,
      'Session destroy timed out',
    )
      .catch(() => {})
      .finally(() => liveReleases.get(sessionId)?.());

  /**
   * Start one session, recording its id as soon as the provider reports it.
   * A create that resolves after its timeout still produces a live session, so
   * it is destroyed on arrival once cleanup has already run.
   */
  const createTrackedSession = (): Promise<CreatedSession> => {
    const started = performance.now();
    const underlying = Promise.resolve(
      provider.session.create(sessionCreateOptions),
    ) as Promise<{ sessionId: string; connectUrl: string }>;

    void underlying.then(
      (session) => {
        if (!session?.sessionId) return;
        if (!createdSessionIds.has(session.sessionId)) {
          liveReleases.set(session.sessionId, liveSessionTracker.enter());
        }
        createdSessionIds.add(session.sessionId);
        if (cleanupComplete) void destroySession(session.sessionId);
      },
      () => {},
    );

    return withTimeout(underlying, timeout, 'Session creation timed out').then(session => ({
      ...session,
      createMs: performance.now() - started,
    }));
  };

  try {
    // ── Phase 1: Create all N sessions in parallel ──────────────────────────
    const createStart = performance.now();
    // Step names carry the level because the platform groups step
    // distributions by name alone: a shared `create-all` would merge a
    // 1-session create with a 50-session create into one distribution.
    const createResults = await step(`create-all-c${concurrencyLevel}`, () =>
      Promise.allSettled(Array.from({ length: concurrencyLevel }, () => createTrackedSession())),
    );
    createMs = performance.now() - createStart;

    aliveSessions = [];
    const createErrors: string[] = [];
    for (const result of createResults) {
      if (result.status === 'fulfilled') {
        aliveSessions.push(result.value);
        continue;
      }
      // Keep the provider's own message: it is the only way to tell a quota
      // rejection from a rate limit, an auth failure, or a timeout.
      const reason = errorMessage(result.reason);
      createErrors.push(reason);
      if (/timed out/i.test(reason)) createTimedOut = true;
      sessionResults.push({
        sessionId: '',
        createMs: 0,
        connectMs: 0,
        taskMs: 0,
        actionsCompleted: 0,
        actionsPerSecond: 0,
        actions: [],
        error: reason,
      });
    }

    log(
      `c${concurrencyLevel} round ${roundIndex} create-all: ${aliveSessions.length}/${concurrencyLevel} created in ${Math.round(createMs)}ms`,
      {
        concurrencyLevel,
        created: aliveSessions.length,
        refused: createErrors.length,
        createMs: Math.round(createMs),
        ...(createErrors.length > 0 ? { reasons: reasonCounts(createErrors) } : {}),
      },
    );

    if (aliveSessions.length === 0) {
      // A provider refusing every session is a result, not a harness fault.
      // Throwing would lose this round's per-session errors, because the
      // client records only an error message and drops the task's data.
      roundError = 'All session creations failed';
    }

    // ── Phase 2: CDP-connect all sessions in parallel ───────────────────────
    const pages: Page[] = [];
    const connectedSessions: CreatedSession[] = [];
    const connectedConnectMs: number[] = [];
    const connectErrors: string[] = [];

    if (aliveSessions.length > 0) {
      const connectStart = performance.now();
      const connectResults = await step(`connect-all-c${concurrencyLevel}`, () =>
        Promise.allSettled(
          aliveSessions.map(async (s) => {
            const started = performance.now();
            const browser = await withTimeout(
              chromium.connectOverCDP(s.connectUrl),
              30_000,
              'CDP connection timed out',
            );
            return { browser, connectMs: performance.now() - started };
          }),
        ),
      );
      connectMs = performance.now() - connectStart;

      for (let i = 0; i < connectResults.length; i++) {
        const result = connectResults[i];
        const session = aliveSessions[i];

        if (result.status === 'rejected') {
          connectErrors.push(errorMessage(result.reason));
          sessionResults.push({
            sessionId: session.sessionId,
            createMs: session.createMs,
            connectMs: 0,
            taskMs: 0,
            actionsCompleted: 0,
            actionsPerSecond: 0,
            actions: [],
            error: errorMessage(result.reason),
          });
          continue;
        }

        const { browser, connectMs: sessionConnectMs } = result.value;
        browsers.push(browser);
        const [context] = browser.contexts();
        const page = context ? context.pages()[0] ?? (await context.newPage()) : undefined;

        if (!page) {
          connectErrors.push('No default browser context found');
          sessionResults.push({
            sessionId: session.sessionId,
            createMs: session.createMs,
            connectMs: sessionConnectMs,
            taskMs: 0,
            actionsCompleted: 0,
            actionsPerSecond: 0,
            actions: [],
            error: 'No default browser context found',
          });
          continue;
        }

        pages.push(page);
        connectedSessions.push(session);
        connectedConnectMs.push(sessionConnectMs);
      }

      sessionsAlive = pages.length;
      log(
        `c${concurrencyLevel} round ${roundIndex} connect-all: ${pages.length}/${aliveSessions.length} connected in ${Math.round(connectMs)}ms`,
        {
          concurrencyLevel,
          connected: pages.length,
          failed: connectErrors.length,
          connectMs: Math.round(connectMs),
          ...(connectErrors.length > 0 ? { reasons: reasonCounts(connectErrors) } : {}),
        },
      );
      if (pages.length === 0) roundError ??= 'All CDP connections failed';
    }

    // ─── BARRIER: all surviving sessions are alive + connected ──────────────

    // ── Phase 3: Run 10-action loop on all sessions simultaneously ──────────
    if (pages.length > 0) {
      // runActionLoop pushes to a passed array, so we create one per page.
      const actionArrays: ActionResult[][] = pages.map(() => []);
      const actionStart = performance.now();
      const deadline = actionStart + LEVEL_ACTION_BUDGET_MS;
      const loopResults = await step(`actions-all-c${concurrencyLevel}`, () =>
        Promise.allSettled(
          pages.map((page, i) =>
            runActionLoop(page, actionArrays[i], navUrlForSession(concurrencyLevel, roundIndex, i), {
              loops,
              deadline,
              track: actionTracker,
            }),
          ),
        ),
      );
      taskMs = performance.now() - actionStart;

      let totalActionsCompleted = 0;
      for (let i = 0; i < loopResults.length; i++) {
        const result = loopResults[i];
        const session = connectedSessions[i];
        // Actions completed before a mid-loop throw are still measurements.
        const actions = actionArrays[i];
        const actionsCompleted = actions.filter(a => a.success).length;
        const sessionTaskMs = actions.reduce((sum, a) => sum + a.durationMs, 0);
        totalActionsCompleted += actionsCompleted;
        sessionResults.push({
          sessionId: session?.sessionId ?? '',
          createMs: session?.createMs ?? 0,
          connectMs: connectedConnectMs[i] ?? 0,
          taskMs: sessionTaskMs,
          actionsCompleted,
          actionsPerSecond: sessionTaskMs > 0 ? actionsCompleted / (sessionTaskMs / 1000) : 0,
          actions,
          ...(result.status === 'rejected' ? { error: errorMessage(result.reason) } : {}),
        });
      }

      aggregateActionsPerSecond = taskMs > 0 ? totalActionsCompleted / (taskMs / 1000) : 0;
    }

  } catch (err) {
    roundError = errorMessage(err);
    harnessFailure = true;
  } finally {
    // Close all CDP browser connections
    await Promise.allSettled(browsers.map(b => b.close().catch(() => {})));

    // ── Phase 4: Release every session the provider created ─────────────────
    // Runs in `finally` so a round that fails after creating sessions still
    // releases them instead of holding provider quota until idle timeout.
    const releaseStart = performance.now();
    const releaseAll = () => Promise.allSettled([...createdSessionIds].map(destroySession));
    if (harnessFailure) {
      await releaseAll();
    } else {
      await step(`release-all-c${concurrencyLevel}`, releaseAll, { reportConcurrency: false });
    }
    releaseMs = performance.now() - releaseStart;
    cleanupComplete = true;
  }

  const maxConcurrentActions = actionWatch.stop();
  const maxLiveSessions = liveWatch.stop();

  const totalMs = performance.now() - totalStart;

  const round: RoundResult = {
    concurrencyLevel,
    roundIndex,
    sessionsAttempted: concurrencyLevel,
    sessionsAlive,
    createMs,
    connectMs,
    taskMs,
    releaseMs,
    totalMs,
    aggregateActionsPerSecond,
    maxLiveSessions,
    maxConcurrentActions,
    loopsPerSession: loops,
    sessions: sessionResults,
    ...(sessionResults.some(sessionHitActionTimeout) ? { actionTimedOut: true } : {}),
    ...(createTimedOut ? { createTimedOut } : {}),
    ...(sessionsAlive === 0 ? { roundFailed: true } : {}),
    ...(roundError ? { error: roundError } : {}),
  };

  // Logged before the throw below so a harness failure still reports what the
  // round achieved, not just that it died.
  const actionsCompleted = sessionResults.reduce((sum, s) => sum + s.actionsCompleted, 0);
  const actionsAttempted = sessionResults.reduce((sum, s) => sum + s.actions.length, 0);
  log(
    `c${concurrencyLevel} round ${roundIndex} complete: ${sessionsAlive}/${concurrencyLevel} sessions, ` +
      `${actionsCompleted}/${actionsAttempted} actions in ${Math.round(totalMs)}ms, ` +
      `peak ${maxConcurrentActions}/${concurrencyLevel} concurrent`,
    {
      concurrencyLevel,
      sessionsAlive,
      actionsCompleted,
      actionsAttempted,
      loopsPerSession: loops,
      maxConcurrentActions,
      maxLiveSessions,
      aggregateActionsPerSecond: Math.round(aggregateActionsPerSecond * 100) / 100,
      createMs: Math.round(createMs),
      connectMs: Math.round(connectMs),
      taskMs: Math.round(taskMs),
      releaseMs: Math.round(releaseMs),
      totalMs: Math.round(totalMs),
      ...(roundError ? { roundError } : {}),
    },
  );

  // A level that never reached its own session count did not measure the
  // concurrency it is filed under, and one that exceeded it was overlapping
  // something else. Both make the level's numbers mean something other than
  // their label, so neither is left to be noticed in the artifacts later.
  if (sessionsAlive > 0 && maxConcurrentActions < sessionsAlive) {
    log(
      `c${concurrencyLevel} round ${roundIndex} never ran more than ${maxConcurrentActions} sessions at once ` +
        `despite ${sessionsAlive} being connected`,
      { concurrencyLevel, maxConcurrentActions, sessionsAlive },
    );
  }
  if (maxLiveSessions > concurrencyLevel) {
    log(
      `c${concurrencyLevel} round ${roundIndex} saw ${maxLiveSessions} live sessions, more than the level's ${concurrencyLevel}: ` +
        `another level's sessions were still alive`,
      { concurrencyLevel, maxLiveSessions },
    );
  }

  return { round, harnessFailure };
}

// ── One task per concurrency level ───────────────────────────────────────────
export const task = defineTask<ConcurrentProviderConfig>(async (ctx) => {
  const { participant, taskIndex, phase, step, measure, log } = ctx;

  const concurrencyLevel = levelFromPhaseName(phase);
  if (concurrencyLevel === undefined) {
    throw new TaskError(
      `Task ${taskIndex} has phase ${phase ?? '(none)'}, which names no concurrency level. ` +
        `Levels are selected with --levels (${CONCURRENCY_LEVELS.join(', ')}), not --iterations.`,
      { code: 'CONCURRENT_BAD_PHASE' },
    );
  }

  const roundCount = ROUNDS_OVERRIDE ?? ROUNDS_PER_LEVEL[concurrencyLevel];
  const rounds: RoundResult[] = [];
  let harnessFailure = false;
  let harnessError: string | undefined;

  for (let roundIndex = 0; roundIndex < roundCount; roundIndex++) {
    const outcome = await runRound({ participant, step, log, concurrencyLevel, roundIndex });
    rounds.push(outcome.round);
    // Collected as each round finishes, so a later harness failure still
    // leaves the earlier rounds in the local result file.
    collectRound(participant.name, concurrencyLevel, outcome.round);
    if (outcome.harnessFailure) {
      harnessFailure = true;
      harnessError = outcome.round.error;
      break;
    }
  }

  const sessionsAttempted = rounds.reduce((sum, r) => sum + r.sessionsAttempted, 0);
  const sessionsAlive = rounds.reduce((sum, r) => sum + r.sessionsAlive, 0);
  const actionsCompleted = rounds.reduce(
    (sum, r) => sum + r.sessions.reduce((n, s) => n + s.actionsCompleted, 0),
    0,
  );

  measure({ concurrencyLevel, sessionsAttempted, sessionsAlive, actionsCompleted });

  const data = {
    concurrencyLevel,
    roundsRun: rounds.length,
    roundsPlanned: roundCount,
    sessionsAttempted,
    sessionsAlive,
    actionsCompleted,
    // Per-round aggregates only. The per-session and per-action detail stays in
    // the local artifact: a c50 task covers 1,500 actions, which is far more
    // than belongs in one task payload.
    rounds: rounds.map(summarizeRoundForPlatform) as unknown as JsonValue,
    ...(harnessError ? { errorMessage: harnessError } : {}),
  };

  log(
    `c${concurrencyLevel} level complete: ${rounds.length}/${roundCount} rounds, ` +
      `${sessionsAlive}/${sessionsAttempted} sessions, ${actionsCompleted} actions`,
    {
      concurrencyLevel,
      roundsRun: rounds.length,
      sessionsAlive,
      sessionsAttempted,
      actionsCompleted,
      ...(harnessError ? { harnessError } : {}),
    },
  );

  // Levels run back to back inside one process, so the drain that used to sit
  // between workflow invocations happens here. It runs before the throw below,
  // because a level that failed part way through is the case most likely to
  // have left sessions behind for the next level to trip over. Skipped after
  // the last level, where it would only delay the run's completion.
  if (taskIndex < SELECTED_LEVELS.length - 1 && LEVEL_COOLDOWN_MS > 0) {
    await new Promise((resolve) => setTimeout(resolve, LEVEL_COOLDOWN_MS));
  }

  // Only our own bugs throw. A provider refusing sessions is data the benchmark
  // exists to collect, and throwing would discard it: the client records an
  // error message and drops the task's data payload entirely.
  if (harnessFailure) {
    throw new TaskError(harnessError ?? 'Level failed', { code: 'CONCURRENT_ERROR', data });
  }

  return {
    data,
    // The median round, not the level's wall clock. A level's duration is
    // dominated by its round count (c1 runs 10 rounds, c50 only 3), so wall
    // clock would rank c1 as the slowest level and inverts the very curve the
    // task index exists to show.
    latencyMs: median(rounds.filter((r) => !r.createTimedOut).map((r) => r.totalMs)),
  };
});

/** Per-round aggregate for the platform payload: no per-session detail. */
function summarizeRoundForPlatform(round: RoundResult): Record<string, JsonValue> {
  const failures = round.sessions.map((s) => s.error).filter((e): e is string => Boolean(e));
  return {
    roundIndex: round.roundIndex,
    sessionsAttempted: round.sessionsAttempted,
    sessionsAlive: round.sessionsAlive,
    createMs: Math.round(round.createMs),
    connectMs: Math.round(round.connectMs),
    taskMs: Math.round(round.taskMs),
    releaseMs: Math.round(round.releaseMs),
    totalMs: Math.round(round.totalMs),
    aggregateActionsPerSecond: Math.round(round.aggregateActionsPerSecond * 100) / 100,
    // The measured peak, so a level that never reached its own session count is
    // visible on the platform record rather than only in the artifacts.
    ...(round.maxConcurrentActions !== undefined ? { maxConcurrentActions: round.maxConcurrentActions } : {}),
    ...(round.maxLiveSessions !== undefined ? { maxLiveSessions: round.maxLiveSessions } : {}),
    ...(round.loopsPerSession !== undefined ? { loopsPerSession: round.loopsPerSession } : {}),
    ...(round.actionTimedOut ? { actionTimedOut: true } : {}),
    ...(round.createTimedOut ? { createTimedOut: true } : {}),
    ...(round.roundFailed ? { roundFailed: true } : {}),
    ...(round.error ? { errorMessage: round.error } : {}),
    // Counts rather than a sample, because a level can hit two distinct limits
    // in one round: a concurrency cap on some sessions and a rate limit on the
    // rest.
    ...(failures.length > 0 ? { reasons: reasonCounts(failures) } : {}),
  };
}

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}
