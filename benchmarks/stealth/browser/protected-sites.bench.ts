/**
 * Browser protected-sites benchmark: with stealth enabled, can each provider's
 * browser load real content on anti-bot-protected pages, how long does it
 * take, and can it solve CAPTCHAs where the provider advertises solving.
 *
 * One phase per target site (data.phase = site slug), iterations 2 per site,
 * concurrency 1. Each task creates a fresh stealth browser session, connects
 * over CDP, navigates to the site, and polls the DOM until a terminal state:
 * real content (pass), a solved CAPTCHA gate (solved), a live challenge at
 * the deadline (challenge), a hard block page (blocked), or nothing at all
 * (timeout). The session is released at the end of every task.
 *
 * A provider failing to reach content is a measurement (passed: 0), not a
 * harness error — only create/connect failures throw TaskError.
 *
 * Grouping: site is the breakout axis via `scoring.groupBy: 'phase'` — the
 * same mechanism sandbox benchmarks use for their sweep axes — rather than
 * browser-concurrency's per-level step names, because phases also give each
 * site its own record and composite row.
 *
 *   pnpm bench benchmarks/stealth/browser/protected-sites.bench.ts
 *   pnpm bench benchmarks/stealth/browser/protected-sites.bench.ts --provider kernel --iterations 1
 *   pnpm bench benchmarks/stealth/browser/protected-sites.bench.ts --sites nowsecure,turnstile-demo
 *
 * `--sites` (or the SITES env var) restricts the target list for smoke runs.
 * Results land under results/browser_protected_sites/.
 */
import '../src/env.js';
import path from 'node:path';
import { continuousScoring } from '../sandbox/performance-runtime-scoring.js';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright-core';
import { defineBenchmarkConfig, defineTask, TaskError } from '@benchsdk/runner';
import type { JsonObject } from '@benchsdk/client';
import { withTimeout } from '../src/util/timeout.js';
import { formatError } from '../src/util/error.js';
import { protectedSitesProviders } from './protected-sites-providers.js';
import type { ConcurrentProviderConfig } from './concurrent-types.js';
import { PROTECTED_SITES, type ProtectedSite } from './protected-sites.js';
import { writeProtectedSitesLegacyResults } from './protected-sites-legacy-results.js';
import { uploadProtectedSitesMatrix } from './protected-sites-matrix.js';

// `type: 'index'` + `index` declare the platform's matrix-layout index
// benchmark (rows = sites, columns = providers). The fields land in
// @benchsdk/runner after 0.6.3, so they're spread in rather than written
// literally — older runners ignore unknown top-level config keys and tsc
// rejects unknown literal keys.
const INDEX_DECLARATION = {
  type: 'index',
  index: {
    layout: 'matrix',
    spec: { cell: { unit: 'score', decimals: 1, direction: 'higher-better' } },
  },
} as const;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CREATE_TIMEOUT_MS = 120_000;
const CONNECT_TIMEOUT_MS = 30_000;
const NAV_TIMEOUT_MS = 60_000;
const RELEASE_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 1_500;
const DEFAULT_VISIT_TIMEOUT_MS = 120_000;

function resolveVisitTimeoutMs(): number {
  const parsed = Number(process.env.BENCH_VISIT_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_VISIT_TIMEOUT_MS;
}
const VISIT_TIMEOUT_MS = resolveVisitTimeoutMs();

function selectedSites(): ProtectedSite[] {
  const argIdx = process.argv.indexOf('--sites');
  const raw = argIdx !== -1 ? process.argv[argIdx + 1] : (process.env.SITES ?? process.env.PROTECTED_SITES);
  if (!raw) return PROTECTED_SITES;
  const wanted = new Set(raw.split(',').map((s) => s.trim()).filter(Boolean));
  const sites = PROTECTED_SITES.filter((s) => wanted.has(s.slug));
  if (sites.length === 0) {
    throw new Error(`--sites '${raw}' matched no known site slugs (${PROTECTED_SITES.map((s) => s.slug).join(', ')})`);
  }
  return sites;
}
const SITES = selectedSites();

type Outcome = 'pass' | 'solved' | 'challenge' | 'blocked' | 'timeout';

interface ProbeState {
  pass: boolean;
  challenge: boolean;
  block: boolean;
  captcha: boolean;
  solved: boolean;
  url: string;
}

/**
 * Evaluate every signal against the live DOM in one evaluate call. Failures
 * (mid-navigation execution-context teardown) are transient — treated as a
 * blank probe rather than a site state.
 *
 * The probe body is an IIFE string, not a closure: tsx/esbuild wraps function
 * expressions in `__name()` (keepNames), which does not exist inside the page
 * and makes every `page.evaluate(fn)` throw ReferenceError. Embedding the
 * site config via JSON.stringify avoids both that and string-evaluate's lack
 * of arg passing.
 */
async function probe(page: Page, site: ProtectedSite): Promise<ProbeState> {
  const source = `(() => {
    const s = ${JSON.stringify(site)};
    const html = document.documentElement ? document.documentElement.outerHTML : '';
    const text = document.body ? document.body.innerText : '';
    const title = document.title || '';
    const match = (sig) => {
      if (!sig) return false;
      if (sig.selector && document.querySelector(sig.selector)) return true;
      if (sig.text && text.includes(sig.text)) return true;
      if (sig.html && html.includes(sig.html)) return true;
      if (sig.title && title.includes(sig.title)) return true;
      return false;
    };
    const solvedEl = s.solvedSelector ? document.querySelector(s.solvedSelector) : null;
    return {
      pass: match(s.passSignal),
      challenge: match(s.challengeSignal),
      block: match(s.blockSignal),
      captcha: match(s.captchaSignal),
      solved: !!(solvedEl && typeof solvedEl.value === 'string' && solvedEl.value.length > 0),
      url: location.href,
    };
  })()`;
  try {
    return (await page.evaluate(source)) as ProbeState;
  } catch {
    return { pass: false, challenge: false, block: false, captcha: false, solved: false, url: '' };
  }
}

interface VisitResult extends JsonObject {
  site: string;
  vendor: string;
  passed: number;
  timeToPassMs: number;
  captchaEncountered: number;
  captchaSolved: number;
  captchaSolveMs: number;
  outcome: Outcome;
  finalUrl: string;
}

/**
 * Navigate to the site and poll until a terminal classification or the visit
 * deadline. CAPTCHA widgets on providers that auto-solve either fill the
 * solved token element or disappear as the challenge clears — both count as
 * solved.
 */
async function runVisit(page: Page, site: ProtectedSite): Promise<VisitResult> {
  const visitStart = performance.now();
  const deadline = visitStart + VISIT_TIMEOUT_MS;

  let navError: string | undefined;
  try {
    await withTimeout(
      page.goto(site.url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS }) as Promise<unknown>,
      NAV_TIMEOUT_MS + 5_000,
      `navigation to ${site.url} timed out`,
    );
  } catch (err) {
    navError = formatError(err);
  }

  let firstChallengeAt: number | undefined;
  let firstCaptchaAt: number | undefined;
  let captchaSolvedAt: number | undefined;
  let passAt: number | undefined;
  let blockSeen = false;
  let lastUrl = '';

  while (performance.now() < deadline) {
    const state = await probe(page, site);
    const now = performance.now();
    if (state.url) lastUrl = state.url;
    if (state.block) blockSeen = true;
    if (state.challenge && firstChallengeAt === undefined) firstChallengeAt = now;
    if (state.captcha && firstCaptchaAt === undefined) firstCaptchaAt = now;

    // Solved = token element filled, or a captcha that was present is gone
    // while content is now reachable (challenge-clear widgets vanish on solve).
    const captchaCleared = firstCaptchaAt !== undefined && !state.captcha && state.pass;
    if ((state.solved || captchaCleared) && captchaSolvedAt === undefined) captchaSolvedAt = now;

    const passed =
      state.pass &&
      !state.challenge &&
      !state.block &&
      (!site.captchaGate || captchaSolvedAt !== undefined);
    if (passed) {
      passAt = now;
      break;
    }

    // Nothing loaded and navigation already failed — no point waiting out
    // the full deadline on a dead page.
    if (navError && !state.pass && !state.challenge && !state.block && !state.captcha) break;

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  const passed = passAt !== undefined;
  const captchaSolved = captchaSolvedAt !== undefined;
  // A filled token proves the widget was there even when we never caught it
  // mid-solve (non-interactive Turnstile auto-passes before the iframe probes).
  const captchaEncountered = firstCaptchaAt !== undefined || captchaSolved;
  const outcome: Outcome = passed
    ? captchaSolved || captchaEncountered
      ? 'solved'
      : 'pass'
    : blockSeen
      ? 'blocked'
      : captchaEncountered || firstChallengeAt !== undefined
        ? 'challenge'
        : 'timeout';

  return {
    site: site.slug,
    vendor: site.expectedVendor,
    passed: passed ? 1 : 0,
    // Preserve the observed timing; the display controls decimal formatting.
    timeToPassMs: passed ? passAt! - visitStart : 0,
    captchaEncountered: captchaEncountered ? 1 : 0,
    captchaSolved: captchaSolved ? 1 : 0,
    captchaSolveMs:
      captchaSolved && firstCaptchaAt !== undefined
        ? captchaSolvedAt! - firstCaptchaAt
        : 0,
    outcome,
    finalUrl: lastUrl,
  };
}

export const config = defineBenchmarkConfig({
  ...INDEX_DECLARATION,
  benchmarkSlug: 'browser-protected-sites',
  benchmarkName: 'Browser Protected Sites',
  phases: SITES.map((site) => ({ name: site.slug, iterations: 2 })),
  concurrency: 1,
  groupBy: 'round',
  participants: protectedSitesProviders,
  scoring: continuousScoring({
    groupBy: 'phase',
    metrics: [
      {
        // Headline: fraction of sites passed. 70% of the composite.
        key: 'passed',
        label: 'Pass rate',
        unit: 'ratio',
        floor: 0,
        ceiling: 1,
        higherIsBetter: true,
        weights: { median: 0.7, p95: 0, p99: 0 },
      },
      {
        // Tiebreak: how quickly content loaded. 30% of the composite.
        key: 'timeToPassMs',
        label: 'Time to pass',
        unit: 'ms',
        floor: 0,
        ceiling: VISIT_TIMEOUT_MS,
        weights: { median: 0.2, p95: 0.05, p99: 0.05 },
      },
    ],
    success: { requireData: { passed: 1 } },
  }, { timeToPassMs: 120000 }),
  customCliFlags: ['--sites'],
  display: {
    metrics: [
      { key: 'passed', label: 'Passed', unit: 'ratio', direction: 'higher-better', decimals: 2 },
      { key: 'timeToPassMs', label: 'Time to pass', unit: 'ms', direction: 'lower-better', decimals: 0 },
      { key: 'captchaEncountered', label: 'CAPTCHA seen', unit: 'count', decimals: 0 },
      { key: 'captchaSolved', label: 'CAPTCHA solved', unit: 'count', direction: 'higher-better', decimals: 0 },
      { key: 'captchaSolveMs', label: 'Solve time', unit: 'ms', direction: 'lower-better', decimals: 0 },
    ],
    steps: [
      { key: 'create', label: 'Create session', order: 0 },
      { key: 'connect', label: 'CDP connect', order: 1 },
      { key: 'visit', label: 'Visit site', order: 2 },
      { key: 'release', label: 'Release session', order: 3 },
    ],
    overview: { defaultMetric: 'compositeScore', defaultLayout: 'ranking' },
  },
  onComplete: async (outcome) => {
    await writeProtectedSitesLegacyResults(outcome.participants, {
      resultsDir: path.resolve(__dirname, '../../../results/browser_protected_sites'),
    });
    await uploadProtectedSitesMatrix(
      SITES.map((site) => site.slug),
      outcome,
      config.benchmarkSlug,
    );
  },
});

export const task = defineTask<ConcurrentProviderConfig>(async (ctx) => {
  const { participant, log, step, measure } = ctx;
  const site = SITES.find((s) => s.slug === ctx.phase);
  if (!site) {
    throw new TaskError(`Unknown phase '${ctx.phase}'`, { code: 'UNKNOWN_SITE' });
  }

  const browserProvider = participant.createBrowserProvider();
  const createOptions = participant.sessionCreateOptions ?? {};

  let sessionId = '';
  let connectUrl = '';
  let browser: Browser | undefined;
  let result: VisitResult | undefined;

  try {
    await step('create', async () => {
      const session = (await withTimeout(
        browserProvider.session.create(createOptions),
        CREATE_TIMEOUT_MS,
        `session.create timed out after ${CREATE_TIMEOUT_MS}ms`,
      )) as { sessionId?: string; connectUrl?: string };
      if (!session?.sessionId) {
        throw new TaskError('session.create returned no sessionId', { code: 'NO_SESSION_ID' });
      }
      sessionId = session.sessionId;
      connectUrl = session.connectUrl ?? '';
    });

    let page: Page | undefined;
    await step('connect', async () => {
      if (!connectUrl) {
        throw new TaskError('session returned no connectUrl', { code: 'NO_CONNECT_URL' });
      }
      browser = await withTimeout(
        chromium.connectOverCDP(connectUrl),
        CONNECT_TIMEOUT_MS,
        `CDP connect timed out after ${CONNECT_TIMEOUT_MS}ms`,
      );
      const [context] = browser.contexts();
      page = context ? context.pages()[0] ?? (await context.newPage()) : undefined;
      if (!page) throw new TaskError('No default browser context found', { code: 'NO_PAGE' });
    });

    result = await step('visit', async () => runVisit(page!, site));
    measure(result);
    log(`${site.slug}: ${result.outcome}${result.passed ? ` in ${result.timeToPassMs}ms` : ''}`, {
      site: site.slug,
      vendor: site.expectedVendor,
      outcome: result.outcome,
      captchaEncountered: result.captchaEncountered,
      captchaSolved: result.captchaSolved,
    });
  } finally {
    if (sessionId) {
      const id = sessionId;
      await step(
        'release',
        async () => {
          try {
            await withTimeout(
              Promise.resolve(browserProvider.session.destroy(id)),
              RELEASE_TIMEOUT_MS,
              `session.destroy timed out after ${RELEASE_TIMEOUT_MS}ms`,
            );
          } catch (err) {
            // Release failures must not sink a successful visit.
            log(`session.destroy ${id} failed: ${formatError(err)}`, { level: 'warn' });
          }
        },
        { reportConcurrency: false },
      );
    }
    await browser?.close().catch(() => {});
  }

  return { data: result, latencyMs: result?.timeToPassMs ?? 0 };
});
