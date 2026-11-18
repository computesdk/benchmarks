/**
 * Browser idle resume benchmark: how long can a browser-agent session sit
 * disconnected before the provider can no longer resume it?
 *
 * This is the checkpointing story for real agent workloads: a session that
 * finishes a turn may sit disconnected for minutes before the next one. The
 * benchmark reuses the session-persistence lifecycle — create (keepAlive),
 * connect over CDP, seed state (cookie + localStorage marker + second tab),
 * drop the client WITHOUT releasing the session — but then waits an idle gap
 * before attempting the reconnect and verifying preserved state.
 *
 * One phase per idle gap (idle-10s, idle-30s, idle-60s, idle-300s), ten tasks
 * each by default: each phase task runs the full
 * create→seed→disconnect→idle→reconnect→verify→release cycle for its gap, so
 * a single run sweeps the survival curve ten times and `data.phase` names
 * the gap a record belongs to. Tasks launch concurrently
 * (`concurrency: 10`) so a phase's sessions idle in parallel and a leg lands
 * ~10-13 min, not ~90 serial. `--iterations N` repeats the whole sweep N
 * times — the runner scales every phase uniformly, so a count CAN express
 * the sweep.
 *
 * Reconnect tries two strategies in order (same as session-persistence):
 *   a) `same-cdp-url`  — the original connectUrl from session.create()
 *   b) `provider-api`  — a fresh connect URL from provider.getConnectUrl(id),
 *      falling back to provider.session.getById(id).connectUrl
 * A gap the session does not survive is a capability result, NOT a task
 * failure: the record lands with `resumeSupported: 0` and that phase's pass
 * metric (`resume<gap>`) scores 0. `reconnectMs` is only recorded when the
 * reconnect actually succeeded — a failed attempt's elapsed time is a
 * timeout artifact, so it goes to `reconnectAttemptMs`/`reconnectError` and
 * stays out of the scored latency.
 *
 * Declarative — exports `config` + `task`; `bench run` owns the entrypoint.
 *
 *   pnpm bench benchmarks/stealth/browser/idle-resume.bench.ts
 *   pnpm bench benchmarks/stealth/browser/idle-resume.bench.ts --provider kernel --no-ingest
 */
import path from 'node:path';
import { continuousScoring } from '../sandbox/performance-runtime-scoring.js';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser } from 'playwright-core';
import type { JsonObject } from '@benchsdk/client';
import { defineBenchmarkConfig, defineTask, TaskError } from '@benchsdk/runner';
import { idleResumeProviders, type IdleResumeProviderConfig } from './idle-resume-providers.js';
import { writeIdleResumeLegacyResults } from './idle-resume-legacy-results.js';
import { formatError } from '../src/util/error.js';
import { withTimeout } from '../src/util/timeout.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CREATE_TIMEOUT_MS = 120_000;
const CDP_TIMEOUT_MS = 30_000;
const RECONNECT_TIMEOUT_MS = 30_000;
const SEED_TIMEOUT_MS = 60_000;
const VERIFY_TIMEOUT_MS = 30_000;
const DISCONNECT_TIMEOUT_MS = 15_000;
const RELEASE_TIMEOUT_MS = 15_000;

// Scoring ceiling is deliberately tighter than the step timeout (same
// rationale as session-persistence): a resume slower than ~2s is effectively
// a fresh session for an agent.
const RECONNECT_SCORE_CEILING_MS = 2_000;

/** Single shared origin so the cookie and localStorage markers have a home. */
const ORIGIN = 'https://example.com';
const COOKIE_NAME = 'bench_persist_cookie';
const STORAGE_KEY = 'bench_persist_marker';
/** Steps the platform's per-phase dropdowns show, in order. */
const STEP_ORDER = ['create', 'connect', 'seed', 'disconnect', 'idle', 'reconnect', 'verify', 'release'] as const;

/**
 * The idle gaps under test, one phase each. `metricKey` is the scored
 * pass/fail flag this phase emits, and `weight` its share of the composite —
 * later gaps weigh more because surviving five idle minutes is the signal
 * that separates providers (the fractions are also used verbatim by
 * scoreIdleResumeRecords in idle-resume-legacy-results.ts — keep them in
 * sync).
 */
const IDLE_GAPS = [
  { name: 'idle-10s', gapMs: 10_000, metricKey: 'resume10s', weight: 0.1 },
  { name: 'idle-30s', gapMs: 30_000, metricKey: 'resume30s', weight: 0.15 },
  { name: 'idle-60s', gapMs: 60_000, metricKey: 'resume60s', weight: 0.25 },
  { name: 'idle-300s', gapMs: 300_000, metricKey: 'resume300s', weight: 0.3 },
] as const;

/**
 * Default repeats of the idle-gap sweep per provider run. Every phase
 * declares the same count so `--iterations N` stays meaningful — the runner
 * applies it uniformly to all four gaps (10 → 40 tasks per provider leg).
 */
const DEFAULT_SWEEP_ITERATIONS = 10;

export const config = defineBenchmarkConfig({
  // CI mints cadence variants by exporting BENCHMARK_SLUG/BENCHMARK_NAME
  // (e.g. browser-idle-resume-stealth); the literals keep local runs working.
  benchmarkSlug: process.env.BENCHMARK_SLUG ?? 'browser-idle-resume',
  benchmarkName: process.env.BENCHMARK_NAME ?? 'Browser Idle Resume',
  // One phase per idle gap, DEFAULT_SWEEP_ITERATIONS tasks each. Declaring
  // phases is also what tags every record with `data.phase`, which
  // `scoring.groupBy` breaks out into a per-gap summary row.
  phases: IDLE_GAPS.map((gap) => ({ name: gap.name, iterations: DEFAULT_SWEEP_ITERATIONS })),
  // Launch each phase's iterations concurrently: the idle gaps overlap, so
  // ten sweeps of a 300s gap still finish in ~gap+overhead, not ten times
  // it. Capped at the iteration count so a provider never holds more than
  // ~10 live sessions at once. The pool pulls the schedule in order, so
  // phases still run as waves — leg ≈ Σ(gap + overhead) ≈ 10-13 min.
  concurrency: DEFAULT_SWEEP_ITERATIONS,
  // 'participant' so the concurrency pool actually fans out: 'round' iterates
  // the schedule serially (one task per participant per round), and with the
  // single-provider legs of the matrix workflow every round is one task —
  // concurrency never engaged and 40 tasks ran strictly serial.
  groupBy: 'participant',
  participants: idleResumeProviders,
  scoring: continuousScoring({
    groupBy: 'phase',
    metrics: [
      // weights.median + p95 + p99 across ALL metrics must sum to 1.0
      //
      // The pass fractions carry the headline signal — how long a session
      // survives idle — weighted by gap: surviving 300s is worth three times
      // the 10s gap. Each flag is emitted by exactly one phase's record, so
      // its median IS that phase's 0/1 outcome. A pass requires the session
      // to come back AND keep all seeded state; a resume into a wiped
      // browser is a dead session for an agent either way.
      ...IDLE_GAPS.map((gap) => ({
        key: gap.metricKey,
        unit: '0-1',
        ceiling: 1,
        higherIsBetter: true,
        weights: { median: gap.weight, p95: 0, p99: 0 },
      })),
      // Reconnect speed scores only the phases the provider actually
      // resumed: a dead phase emits no reconnectMs sample, so a provider
      // isn't scored on a latency it never achieved.
      {
        key: 'reconnectMs',
        unit: 'ms',
        ceiling: RECONNECT_SCORE_CEILING_MS,
        weights: { median: 0.15, p95: 0.05, p99: 0 },
      },
    ],
    // No success.requireData gate: the per-gap pass weights already make a
    // provider that never resumes score ~0, and multiplying the composite by
    // a resume rate would double-count the same survival signal (a provider
    // dead at 60s would land ~20 instead of the intended ~40-60). Genuine
    // task failures still scale the composite via the run's success rate.
  }, { reconnectMs: 2000 }),
  display: {
    metrics: [
      ...IDLE_GAPS.map((gap, order) => ({
        key: gap.metricKey,
        label: `Resume ${gap.gapMs / 1000}s`,
        unit: '0-1',
        direction: 'higher-better' as const,
        decimals: 0,
        order,
      })),
      { key: 'reconnectMs', label: 'Reconnect', unit: 'ms', direction: 'lower-better', decimals: 0, order: 10 },
      { key: 'cookiesPreserved', label: 'Cookies', unit: '0-1', direction: 'higher-better', decimals: 0, order: 11 },
      { key: 'storagePreserved', label: 'Storage', unit: '0-1', direction: 'higher-better', decimals: 0, order: 12 },
      { key: 'tabsPreserved', label: 'Tabs', unit: '0-1', direction: 'higher-better', decimals: 0, order: 13 },
      { key: 'createMs', label: 'Create', unit: 'ms', direction: 'lower-better', decimals: 0, order: 14 },
      { key: 'idleMs', label: 'Idle', unit: 'ms', direction: 'lower-better', decimals: 0, order: 15 },
      { key: 'totalMs', label: 'Total', unit: 'ms', direction: 'lower-better', decimals: 0, order: 16 },
    ],
    steps: STEP_ORDER.map((key, order) => ({ key, label: key, order })),
    overview: { defaultMetric: 'compositeScore', defaultLayout: 'ranking' },
  },
  onComplete: (outcome) =>
    writeIdleResumeLegacyResults(outcome.participants, {
      resultsDir: path.resolve(__dirname, '../../../results/browser_idle_resume'),
      metricKeys: ['createMs', 'connectMs', 'seedMs', 'disconnectMs', 'idleMs', 'reconnectMs', 'verifyMs', 'releaseMs', 'totalMs'],
    }),
});

export const task = defineTask<IdleResumeProviderConfig>(async (ctx) => {
  const { participant, phase, taskIndex, log, step, measure } = ctx;
  const p = participant;

  const gap = IDLE_GAPS.find((g) => g.name === phase);
  if (!gap) {
    throw new TaskError(
      `Task ${taskIndex} has phase ${phase ?? '(none)'}, which names no idle gap. ` +
        `Gaps are fixed by the declared phases (${IDLE_GAPS.map((g) => g.name).join(', ')}); --iterations only repeats the whole sweep.`,
      { code: 'idle_resume_bad_phase' },
    );
  }

  const provider = p.createBrowserProvider();
  const createTimeout = p.timeout ?? CREATE_TIMEOUT_MS;

  const runId = `${p.name}-${gap.name}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const cookieValue = `persist-${runId}`;
  const markerValue = `marker-${runId}`;

  let sessionId = '';
  let connectUrl: string | undefined;
  let browser: Browser | undefined;
  let keepAliveAccepted = 0;
  let createMs = 0;
  let connectMs = 0;
  let seedMs = 0;
  let disconnectMs = 0;
  let idleMs = 0;
  let reconnectMs = 0;
  let verifyMs = 0;
  let releaseMs = 0;
  let resumeSupported = 0;
  let resumeMechanism = 'none';
  let cookiesPreserved = 0;
  let storagePreserved = 0;
  let tabsPreserved = 0;
  let pageCount = 0;
  let reconnectError: string | undefined;

  try {
    // ── create ────────────────────────────────────────────────────────────
    const createStart = performance.now();
    const session = await step('create', () =>
      withTimeout(
        (async () => {
          const baseOptions = p.sessionCreateOptions ?? {};
          try {
            keepAliveAccepted = 1;
            return await provider.session.create(baseOptions);
          } catch (err) {
            // Some adapters reject a create option they do not model; the
            // session can still be measured, it just cannot opt into
            // keep-alive semantics. Record the fallback rather than failing.
            keepAliveAccepted = 0;
            const { keepAlive: _keepAlive, ...rest } = baseOptions;
            log('create with keepAlive rejected; retrying without it', {
              level: 'warn',
              meta: { error: formatError(err) },
            });
            return await provider.session.create(rest);
          }
        })(),
        createTimeout,
        'Session creation timed out',
      ),
    );
    createMs = performance.now() - createStart;
    sessionId = session.sessionId;
    connectUrl = session.connectUrl;
    measure({ createMs, keepAliveAccepted });
    if (!sessionId) {
      throw new TaskError('provider returned no session id', { code: 'idle_resume_no_session_id' });
    }

    // ── connect ───────────────────────────────────────────────────────────
    const connectStart = performance.now();
    browser = await step('connect', () =>
      withTimeout(
        (async () => {
          const url = connectUrl ?? (await provider.getConnectUrl?.(sessionId));
          if (!url) {
            throw new TaskError('provider returned no CDP connect URL', {
              code: 'idle_resume_no_connect_url',
            });
          }
          return await chromium.connectOverCDP(url);
        })(),
        CDP_TIMEOUT_MS,
        'CDP connection timed out',
      ),
    );
    connectMs = performance.now() - connectStart;
    measure({ connectMs });
    if (!connectUrl) {
      // keep the URL that worked so strategy (a) on reconnect uses it too
      connectUrl = await provider.getConnectUrl?.(sessionId).catch(() => undefined) ?? connectUrl;
    }

    // ── seed ──────────────────────────────────────────────────────────────
    const seedStart = performance.now();
    await step('seed', () =>
      withTimeout(
        (async () => {
          const context = browser!.contexts()[0] ?? (await browser!.newContext());
          const page = context.pages()[0] ?? (await context.newPage());
          await page.goto(ORIGIN, { waitUntil: 'domcontentloaded' });
          await context.addCookies([{ name: COOKIE_NAME, value: cookieValue, url: ORIGIN }]);
          await page.evaluate(
            ([key, value]) => window.localStorage.setItem(key, value),
            [STORAGE_KEY, markerValue],
          );
          const tab2 = await context.newPage();
          await tab2.goto(`${ORIGIN}/?tab=2`, { waitUntil: 'domcontentloaded' }).catch(() => {});
          pageCount = context.pages().length;
        })(),
        SEED_TIMEOUT_MS,
        'Seed timed out',
      ),
    );
    seedMs = performance.now() - seedStart;
    measure({ seedMs, pageCount });

    // ── disconnect (client drop; the session itself is NOT released) ──────
    const disconnectStart = performance.now();
    await step('disconnect', () =>
      withTimeout(browser!.close(), DISCONNECT_TIMEOUT_MS, 'Disconnect timed out'),
    ).catch((err: unknown) =>
      // A failed close still counts as a dropped client for reconnect purposes.
      log('disconnect step failed; continuing to idle gap', {
        level: 'warn',
        meta: { error: formatError(err) },
      }),
    );
    disconnectMs = performance.now() - disconnectStart;
    browser = undefined;
    measure({ disconnectMs });

    // ── idle (the session sits disconnected for the phase's gap) ──────────
    const idleStart = performance.now();
    await step('idle', () => new Promise((resolve) => setTimeout(resolve, gap.gapMs)));
    idleMs = performance.now() - idleStart;
    measure({ idleMs, idleGapMs: gap.gapMs });

    // ── reconnect (same URL first, then the provider API) ─────────────────
    const reconnectStart = performance.now();
    await step('reconnect', () =>
      withTimeout(
        (async () => {
          // Strategy (a): the original connect/CDP URL.
          try {
            if (connectUrl) {
              browser = await chromium.connectOverCDP(connectUrl);
              resumeMechanism = 'same-cdp-url';
              resumeSupported = 1;
              return;
            }
          } catch (err) {
            reconnectError = `same-cdp-url: ${formatError(err)}`;
          }
          // Strategy (b): ask the provider for a fresh connect URL.
          let nextUrl: string | undefined;
          try {
            nextUrl = (await provider.getConnectUrl?.(sessionId)) ?? undefined;
          } catch (err) {
            reconnectError = `${reconnectError ?? ''} getConnectUrl: ${formatError(err)}`;
          }
          if (!nextUrl && typeof provider.session.getById === 'function') {
            try {
              const live = await provider.session.getById(sessionId);
              nextUrl = live?.connectUrl ?? undefined;
            } catch (err) {
              reconnectError = `${reconnectError ?? ''} getById: ${formatError(err)}`;
            }
          }
          if (nextUrl) {
            try {
              browser = await chromium.connectOverCDP(nextUrl);
              resumeMechanism = 'provider-api';
              resumeSupported = 1;
            } catch (err) {
              reconnectError = `${reconnectError ?? ''} provider-api connect: ${formatError(err)}`;
            }
          }
        })(),
        RECONNECT_TIMEOUT_MS,
        'Reconnect timed out',
      ),
    ).catch((err: unknown) => {
      reconnectError = `${reconnectError ?? ''} timeout: ${formatError(err)}`;
    });
    reconnectMs = performance.now() - reconnectStart;
    // reconnectMs is scored, so only emit it when the reconnect actually
    // succeeded — a dead session's elapsed time is just the timeout, and
    // including it would poison the latency stats. The attempt's duration
    // and error still land on the record under their own keys.
    measure(resumeSupported
      ? { reconnectMs, resumeSupported, resumeMechanism }
      : { reconnectAttemptMs: reconnectMs, resumeSupported, resumeMechanism });

    // ── verify ────────────────────────────────────────────────────────────
    if (browser) {
      const verifyStart = performance.now();
      await step('verify', () =>
        withTimeout(
          (async () => {
            const contexts = browser!.contexts();
            const context = contexts[0];
            const pages = context?.pages() ?? [];
            pageCount = pages.length;
            tabsPreserved = pages.length >= 2 ? 1 : 0;

            try {
              const cookies = context ? await context.cookies(ORIGIN) : [];
              cookiesPreserved = cookies.some(
                (c) => c.name === COOKIE_NAME && c.value === cookieValue,
              )
                ? 1
                : 0;
            } catch (err) {
              log('cookie check failed', { level: 'warn', meta: { error: formatError(err) } });
            }

            try {
              const page = pages[0];
              const value = page
                ? await page.evaluate((key) => window.localStorage.getItem(key), STORAGE_KEY)
                : null;
              storagePreserved = value === markerValue ? 1 : 0;
            } catch (err) {
              log('localStorage check failed', { level: 'warn', meta: { error: formatError(err) } });
            }
          })(),
          VERIFY_TIMEOUT_MS,
          'Verify timed out',
        ),
      ).catch((err: unknown) =>
        // A verification error records zeros, not a task failure: a provider
        // that reconnects to blank state is still a valid measurement.
        log('verify step failed', { level: 'warn', meta: { error: formatError(err) } }),
      );
      verifyMs = performance.now() - verifyStart;
      measure({ verifyMs, cookiesPreserved, storagePreserved, tabsPreserved });
    } else {
      log(`session did not survive ${gap.name}; skipping verify`, {
        level: 'info',
        meta: { resumeMechanism, ...(reconnectError ? { reconnectError } : {}) },
      });
    }
  } finally {
    // Close any browser we are still holding, then release the session. Runs
    // in `finally` so a failed iteration still frees provider quota.
    if (browser) {
      await browser.close().catch(() => {});
      browser = undefined;
    }
    if (sessionId) {
      const releaseStart = performance.now();
      await step(
        'release',
        () =>
          withTimeout(
            provider.session.destroy(sessionId),
            RELEASE_TIMEOUT_MS,
            'Release timed out',
          ),
        { reportConcurrency: false },
      ).catch((err: unknown) =>
        log('release failed', { level: 'warn', meta: { error: formatError(err) } }),
      );
      releaseMs = performance.now() - releaseStart;
      measure({ releaseMs });
    }
  }

  const totalMs = createMs + connectMs + seedMs + disconnectMs + idleMs + reconnectMs + verifyMs + releaseMs;
  measure({ totalMs });

  // The scored pass for this phase's gap: the session must both come back
  // and keep every piece of seeded state. A resume into a wiped browser is
  // a dead session for an agent — recorded via the flags above but scored 0.
  const passed = resumeSupported === 1 && cookiesPreserved === 1 && storagePreserved === 1 && tabsPreserved === 1 ? 1 : 0;
  measure({ [gap.metricKey]: passed });

  const data: JsonObject = {
    provider: p.name,
    sessionId,
    idleGapMs: gap.gapMs,
    keepAliveAccepted,
    // Keep performance.now() precision in raw data; display owns rounding.
    createMs,
    connectMs,
    seedMs,
    disconnectMs,
    idleMs,
    ...(resumeSupported ? { reconnectMs } : { reconnectAttemptMs: reconnectMs }),
    verifyMs,
    releaseMs,
    totalMs,
    resumeSupported,
    resumeMechanism,
    cookiesPreserved,
    storagePreserved,
    tabsPreserved,
    pageCount,
    [gap.metricKey]: passed,
    ...(reconnectError ? { reconnectError } : {}),
  } as unknown as JsonObject;

  return {
    data,
    latencyMs: resumeSupported ? reconnectMs : totalMs,
  };
});
