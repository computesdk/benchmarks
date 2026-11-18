/**
 * Browser session persistence benchmark: can a browser-agent session survive a
 * client disconnect? One iteration is the checkpointing story of a long agent
 * run — create a session, connect over CDP, seed state (cookie + localStorage
 * marker + second tab), drop the client connection WITHOUT releasing the
 * session, reconnect, and verify the state survived.
 *
 * Disconnect is a playwright `browser.close()` on a `connectOverCDP` browser,
 * which only closes the CDP transport and does not ask the provider to kill
 * the browser (verified in playwright-core: for a non-collocated CDP browser
 * `browserProcess.close` is the transport's `closeAndWait`, not `Browser.close`).
 * The session is never destroyed between disconnect and reconnect, so whether
 * it is still alive afterwards is the provider's own capability. Sessions are
 * created with `keepAlive: true` — the flag providers expose for "outlive the
 * client" — and a provider that rejects it is retried without and recorded via
 * `keepAliveAccepted`.
 *
 * Reconnect tries two strategies in order:
 *   a) `same-cdp-url`  — the original connectUrl from session.create()
 *   b) `provider-api`  — a fresh connect URL from provider.getConnectUrl(id),
 *      falling back to provider.session.getById(id).connectUrl
 * A provider that simply cannot reconnect is recorded as
 * `resumeSupported: 0, resumeMechanism: 'none'` — a capability result, not a
 * task failure: the record still lands and the composite gate
 * (success.requireData resumeSupported=1) scores it near zero.
 *
 * Declarative — exports `config` + `task`; `bench run` owns the entrypoint.
 *
 *   pnpm bench benchmarks/stealth/browser/session-persistence.bench.ts
 *   pnpm bench benchmarks/stealth/browser/session-persistence.bench.ts --provider kernel --iterations 1 --no-ingest
 */
import path from 'node:path';
import { continuousScoring } from '../sandbox/performance-runtime-scoring.js';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser } from 'playwright-core';
import type { JsonObject } from '@benchsdk/client';
import { defineBenchmarkConfig, defineTask, TaskError } from '@benchsdk/runner';
import { sessionPersistenceProviders, type SessionPersistenceProviderConfig } from './session-persistence-providers.js';
import { writeSessionPersistenceLegacyResults } from './session-persistence-legacy-results.js';
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

// Scoring ceilings are deliberately tighter than the step timeouts above:
// they map observed field values onto a discriminating 0-100 range rather
// than marking what's merely survivable. A resume slower than ~2s is
// effectively a fresh session for an agent, and a full create→release cycle
// slower than ~5s dominates any plausible agent think-time.
const RECONNECT_SCORE_CEILING_MS = 2_000;
const TOTAL_SCORE_CEILING_MS = 5_000;

/** Single shared origin so the cookie and localStorage markers have a home. */
const ORIGIN = 'https://example.com';
const COOKIE_NAME = 'bench_persist_cookie';
const STORAGE_KEY = 'bench_persist_marker';
/** Steps the platform's per-phase dropdowns show, in order. */
const STEP_ORDER = ['create', 'connect', 'seed', 'disconnect', 'reconnect', 'verify', 'release'] as const;

export const config = defineBenchmarkConfig({
  // CI mints cadence variants by exporting BENCHMARK_SLUG/BENCHMARK_NAME
  // (e.g. browser-session-persistence-stealth); the literals keep local runs working.
  benchmarkSlug: process.env.BENCHMARK_SLUG ?? 'browser-session-persistence',
  benchmarkName: process.env.BENCHMARK_NAME ?? 'Browser Session Persistence',
  iterations: 30,
  concurrency: 1,
  // Round interleaves providers like browser-throughput: every provider runs
  // its iteration before the next round starts, so provider slots rotate
  // through the same wall-clock window.
  groupBy: 'round',
  participants: sessionPersistenceProviders,
  scoring: continuousScoring({
    metrics: [
      // weights.median + p95 + p99 across ALL metrics must sum to 1.0
      //
      // Latency carries the spread between resumable providers: every
      // provider that resumes successfully preserved all three state aspects
      // in the first runs, so the binary flags cap at 0.30 combined — enough
      // to tank a provider that reconnects to wiped state without letting
      // pass/pass/pass flatten the ranking. reconnectMs gets p95/p99 weight
      // so a provider with occasionally slow reconnects loses to one that is
      // consistently fast; totalMs scores the whole create→release cycle an
      // agent pays for a resume.
      { key: 'reconnectMs', unit: 'ms', ceiling: RECONNECT_SCORE_CEILING_MS, weights: { median: 0.35, p95: 0.10, p99: 0.05 } },
      { key: 'totalMs', unit: 'ms', ceiling: TOTAL_SCORE_CEILING_MS, weights: { median: 0.2, p95: 0, p99: 0 } },
      { key: 'cookiesPreserved', unit: '0-1', ceiling: 1, higherIsBetter: true, weights: { median: 0.1, p95: 0, p99: 0 } },
      { key: 'storagePreserved', unit: '0-1', ceiling: 1, higherIsBetter: true, weights: { median: 0.1, p95: 0, p99: 0 } },
      { key: 'tabsPreserved', unit: '0-1', ceiling: 1, higherIsBetter: true, weights: { median: 0.1, p95: 0, p99: 0 } },
    ],
    // Resume capability is the headline gate: a provider that cannot reconnect
    // at all keeps its timings on the record but scores near zero.
    success: {
      requireData: { resumeSupported: 1 },
    },
  }, { reconnectMs: 2000, totalMs: 5000 }),
  display: {
    metrics: [
      { key: 'resumeSupported', label: 'Resume', unit: '0-1', direction: 'higher-better', decimals: 0, order: 0 },
      { key: 'reconnectMs', label: 'Reconnect', unit: 'ms', direction: 'lower-better', decimals: 0, order: 1 },
      { key: 'cookiesPreserved', label: 'Cookies', unit: '0-1', direction: 'higher-better', decimals: 0, order: 2 },
      { key: 'storagePreserved', label: 'Storage', unit: '0-1', direction: 'higher-better', decimals: 0, order: 3 },
      { key: 'tabsPreserved', label: 'Tabs', unit: '0-1', direction: 'higher-better', decimals: 0, order: 4 },
      { key: 'createMs', label: 'Create', unit: 'ms', direction: 'lower-better', decimals: 0, order: 5 },
      { key: 'connectMs', label: 'Connect', unit: 'ms', direction: 'lower-better', decimals: 0, order: 6 },
      { key: 'totalMs', label: 'Total', unit: 'ms', direction: 'lower-better', decimals: 0, order: 7 },
    ],
    steps: STEP_ORDER.map((key, order) => ({ key, label: key, order })),
    overview: { defaultMetric: 'compositeScore', defaultLayout: 'ranking' },
  },
  onComplete: (outcome) =>
    writeSessionPersistenceLegacyResults(outcome.participants, {
      resultsDir: path.resolve(__dirname, '../../../results/browser_session_persistence'),
      metricKeys: ['createMs', 'connectMs', 'seedMs', 'reconnectMs', 'verifyMs', 'releaseMs', 'totalMs'],
    }),
});

export const task = defineTask<SessionPersistenceProviderConfig>(async (ctx) => {
  const { participant, log, step, measure } = ctx;
  const p = participant;

  const provider = p.createBrowserProvider();
  const createTimeout = p.timeout ?? CREATE_TIMEOUT_MS;

  const runId = `${p.name}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
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
      throw new TaskError('provider returned no session id', { code: 'session_persistence_no_session_id' });
    }

    // ── connect ───────────────────────────────────────────────────────────
    const connectStart = performance.now();
    browser = await step('connect', () =>
      withTimeout(
        (async () => {
          const url = connectUrl ?? (await provider.getConnectUrl?.(sessionId));
          if (!url) {
            throw new TaskError('provider returned no CDP connect URL', {
              code: 'session_persistence_no_connect_url',
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
      log('disconnect step failed; continuing to reconnect', {
        level: 'warn',
        meta: { error: formatError(err) },
      }),
    );
    disconnectMs = performance.now() - disconnectStart;
    browser = undefined;
    measure({ disconnectMs });

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
    measure({ reconnectMs, resumeSupported, resumeMechanism });

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
      log('session did not survive disconnect; skipping verify', {
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

  const totalMs = createMs + connectMs + seedMs + disconnectMs + reconnectMs + verifyMs + releaseMs;
  measure({ totalMs });

  const data: JsonObject = {
    provider: p.name,
    sessionId,
    keepAliveAccepted,
    // Keep performance.now() precision in raw data; display owns rounding.
    createMs,
    connectMs,
    seedMs,
    disconnectMs,
    reconnectMs,
    verifyMs,
    releaseMs,
    totalMs,
    resumeSupported,
    resumeMechanism,
    cookiesPreserved,
    storagePreserved,
    tabsPreserved,
    pageCount,
    ...(reconnectError ? { reconnectError } : {}),
  } as unknown as JsonObject;

  return {
    data,
    latencyMs: resumeSupported ? reconnectMs : totalMs,
  };
});
