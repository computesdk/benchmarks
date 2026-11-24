/**
 * Browser file transfer benchmark: can each provider's remote browser
 * download a file through the page and upload a file into a form — and does
 * the runner actually get the bytes back?
 *
 * Support is uneven across providers: a remote browser can always *perform*
 * the transfer, but handing the downloaded bytes back to the runner depends
 * on the provider's plumbing (playwright artifacts, CDP download behavior +
 * remote fs access, or a provider-side downloads API). Unsupported is
 * therefore a capability result, NOT a task failure — the run completes and
 * reports downloadSupported/uploadSupported = 0.
 *
 * Steps: create -> connect -> download -> upload -> release.
 *
 * Download tries three mechanisms in order and records the winner in
 * `downloadMechanism`:
 *   1. playwright  — page.waitForEvent('download') + download.path()
 *   2. cdp         — Browser.setDownloadBehavior to a known remote dir, then
 *                    read the file back via the provider's remote-fs API
 *                    (providers with fetchRemoteFile: kernel)
 *   3. provider-api— poll the provider's own session-downloads API for the
 *                    file (browserbase, browseruse, hyperbrowser, steel)
 *
 * Upload is a single mechanism: page.setInputFiles + form submit, verified
 * against the fixture's echo page.
 *
 * Fixtures live in file-transfer-sites.ts: primary the-internet.herokuapp.com,
 * fallback httpbin.org; the task records which `fixture` served the run.
 *
 *   bench run benchmarks/stealth/browser/file-transfer.bench.ts --provider kernel
 */
import path from 'node:path';
import { continuousScoring } from '../sandbox/performance-runtime-scoring.js';
import { fileTransferPoints } from './browsers-runtime-scoring.js';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright-core';
import { defineBenchmarkConfig, defineTask, TaskError, type BenchmarkScoringConfig } from '@benchsdk/runner';
import type { BenchmarkLogOptions, JsonObject } from '@benchsdk/client';
import { withTimeout } from '../src/util/timeout.js';
import { formatError } from '../src/util/error.js';
import { fileTransferProviders, type FileTransferProviderConfig } from './file-transfer-providers.js';
import { TRANSFER_FIXTURES, type TransferFixture } from './file-transfer-sites.js';
import { writeFileTransferResults } from './file-transfer-legacy-results.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CONNECT_TIMEOUT_MS = 30_000;
const SESSION_CREATE_TIMEOUT_MS = 120_000;
const DOWNLOAD_STEP_TIMEOUT_MS = 90_000;
const UPLOAD_STEP_TIMEOUT_MS = 60_000;
const RELEASE_TIMEOUT_MS = 30_000;
const PROVIDER_POLL_INTERVAL_MS = 2_000;
/** Existing v1 linear ceiling: transfers at/above this earn no latency points. */
const TRANSFER_LATENCY_CEILING_MS = 30_000;

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface MechanismAttempt {
  mechanism: string;
  ok: boolean;
  error?: string;
}

interface DownloadOutcome {
  fixture: string;
  mechanism?: string;
  supported: 0 | 1;
  match: 0 | 1;
  ms: number;
  bytes: number;
  sha256?: string;
  error?: string;
  attempts: MechanismAttempt[];
}

/**
 * Try the download through one fixture, all mechanisms in order. Returns the
 * outcome when a mechanism produced bytes, or null when the fixture itself
 * was unreachable (caller tries the next fixture).
 */
async function runDownloadOnFixture(
  page: Page,
  browser: Browser,
  fixture: TransferFixture,
  provider: FileTransferProviderConfig,
  sessionId: string,
  log: (message: string, metaOrOptions?: JsonObject | BenchmarkLogOptions) => void,
): Promise<DownloadOutcome | null> {
  const attempts: MechanismAttempt[] = [];
  let selector: string;
  try {
    selector = await fixture.download.prepare(page);
  } catch (err) {
    log(`fixture ${fixture.name} unreachable: ${formatError(err)}`, { level: 'warn' });
    return null;
  }

  const startedAt = performance.now();

  // Mechanism 1: playwright download event -> local artifact path.
  try {
    const dlPromise = page.waitForEvent('download', { timeout: DOWNLOAD_STEP_TIMEOUT_MS });
    await page.click(selector);
    const download = await dlPromise;
    const localPath = await withTimeout(download.path(), 15_000, 'download.path() timed out');
    if (!localPath) {
      throw new Error('download.path() returned null — remote browser cannot expose the artifact locally');
    }
    const bytes = await readFile(localPath);
    return finish(bytes, 'playwright', fixture, attempts, startedAt);
  } catch (err) {
    attempts.push({ mechanism: 'playwright', ok: false, error: formatError(err) });
  }

  // Mechanism 2: CDP Browser.setDownloadBehavior + provider remote-fs read.
  if (provider.fetchRemoteFile) {
    const remoteDir = provider.remoteDownloadDir ?? '/tmp';
    try {
      const cdp = await browser.newBrowserCDPSession();
      await cdp.send('Browser.setDownloadBehavior', {
        behavior: 'allowAndName',
        downloadPath: remoteDir,
        eventsEnabled: true,
      });
      let guid = '';
      const done = new Promise<string>((resolve, reject) => {
        cdp.on('Browser.downloadWillBegin', (e: any) => { guid = e.guid; });
        cdp.on('Browser.downloadProgress', (e: any) => {
          if (e.guid !== guid) return;
          if (e.state === 'completed') resolve(guid);
          if (e.state === 'canceled') reject(new Error('CDP download canceled'));
        });
      });
      await page.click(selector);
      const finishedGuid = await withTimeout(done, DOWNLOAD_STEP_TIMEOUT_MS, 'CDP download timed out');
      const bytes = await provider.fetchRemoteFile(sessionId, `${remoteDir}/${finishedGuid}`);
      await cdp.send('Browser.setDownloadBehavior', { behavior: 'default' }).catch(() => {});
      return finish(bytes, 'cdp', fixture, attempts, startedAt);
    } catch (err) {
      attempts.push({ mechanism: 'cdp', ok: false, error: formatError(err) });
    }
  }

  // Mechanism 3: the provider's own session-downloads API.
  if (provider.fetchSessionDownloads) {
    try {
      // Playwright arms Browser.setDownloadBehavior at browserContext scope
      // (allowAndName + a runner-local downloadPath) at context init, so the
      // click's file lands where the provider API cannot see it. Re-point the
      // context's behavior at the dir the provider's downloads API scans
      // (provider.downloadBehavior — 'default' clears the override when no
      // dir is known). eventsEnabled stays on for diagnostics.
      let browserContextId: string | undefined;
      const cdp = await browser.newBrowserCDPSession();
      try {
        const { targetInfos } = (await cdp.send('Target.getTargets')) as {
          targetInfos: { url?: string; type?: string; browserContextId?: string }[];
        };
        browserContextId = targetInfos.find(
          (t) => t.type === 'page' && t.url === page.url(),
        )?.browserContextId;
      } catch {}
      let downloadEvent = 'none';
      cdp.on('Browser.downloadWillBegin', (e: { guid?: string }) => {
        downloadEvent = `began:${e.guid}`;
      });
      cdp.on('Browser.downloadProgress', (e: { state?: string; guid?: string }) => {
        downloadEvent = `${e.state}:${e.guid}`;
      });
      const dlBehavior = provider.downloadBehavior;
      await cdp
        .send('Browser.setDownloadBehavior', {
          behavior: dlBehavior?.behavior ?? 'default',
          ...(dlBehavior?.downloadPath ? { downloadPath: dlBehavior.downloadPath } : {}),
          ...(browserContextId ? { browserContextId } : {}),
          eventsEnabled: true,
        })
        .catch(() => {});
      await page.click(selector).catch(() => {});
      const deadline = Date.now() + DOWNLOAD_STEP_TIMEOUT_MS;
      let lastCount = -1;
      while (Date.now() < deadline) {
        const files = await provider.fetchSessionDownloads(sessionId).catch(() => [] as { name: string; bytes: Buffer }[]);
        if (files.length !== lastCount) {
          lastCount = files.length;
          log(`provider downloads API: ${files.length} file(s)`, { level: 'info' });
        }
        const hit = files.find(
          (f) => sha256Hex(f.bytes) === fixture.download.expectedSha256 || f.name.endsWith(fixture.download.fileName),
        );
        if (hit) return finish(hit.bytes, 'provider-api', fixture, attempts, startedAt);
        await sleep(PROVIDER_POLL_INTERVAL_MS);
      }
      throw new Error(
        `file never appeared in provider downloads (browserContextId: ${browserContextId ?? 'unresolved'}, download event: ${downloadEvent})`,
      );
    } catch (err) {
      attempts.push({ mechanism: 'provider-api', ok: false, error: formatError(err) });
    }
  }

  return {
    fixture: fixture.name,
    supported: 0,
    match: 0,
    ms: performance.now() - startedAt,
    bytes: 0,
    error: 'no download mechanism succeeded',
    attempts,
  };

  function finish(
    bytes: Buffer,
    mechanism: string,
    fx: TransferFixture,
    atts: MechanismAttempt[],
    t0: number,
  ): DownloadOutcome {
    atts.push({ mechanism, ok: true });
    const sha = sha256Hex(bytes);
    const match = bytes.length === fx.download.expectedBytes && sha === fx.download.expectedSha256 ? 1 : 0;
    return {
      fixture: fx.name,
      mechanism,
      supported: 1,
      match: match as 0 | 1,
      ms: performance.now() - t0,
      bytes: bytes.length,
      sha256: sha,
      attempts: atts,
    };
  }
}

interface UploadOutcome {
  fixture: string;
  supported: 0 | 1;
  match: 0 | 1;
  ms: number;
  error?: string;
}

async function runUploadOnFixture(
  page: Page,
  fixture: TransferFixture,
  log: (message: string, metaOrOptions?: JsonObject | BenchmarkLogOptions) => void,
): Promise<UploadOutcome | null> {
  try {
    await fixture.upload.prepare(page);
  } catch (err) {
    log(`fixture ${fixture.name} unreachable for upload: ${formatError(err)}`, { level: 'warn' });
    return null;
  }
  const startedAt = performance.now();
  const marker = `bft-marker-${Date.now().toString(36)}`;
  const fileName = `file-transfer-upload.txt`;
  const content = `browser-file-transfer upload probe\nmarker=${marker}\n`;
  try {
    await page.setInputFiles(fixture.upload.fileInputSelector, {
      name: fileName,
      mimeType: 'text/plain',
      buffer: Buffer.from(content, 'utf8'),
    });
    await page.click(fixture.upload.submitSelector);
  } catch (err) {
    return {
      fixture: fixture.name,
      supported: 0,
      match: 0,
      ms: performance.now() - startedAt,
      error: `setInputFiles/submit failed: ${formatError(err)}`,
    };
  }
  try {
    await fixture.upload.assertEcho(page, fileName, marker);
    return { fixture: fixture.name, supported: 1, match: 1, ms: performance.now() - startedAt };
  } catch (err) {
    // The file left the runner and the form submitted — the transfer itself
    // worked; the echo check is a content match, not a capability signal.
    return {
      fixture: fixture.name,
      supported: 1,
      match: 0,
      ms: performance.now() - startedAt,
      error: `echo verification failed: ${formatError(err)}`,
    };
  }
}

const scoringMetrics: BenchmarkScoringConfig['metrics'] = [
  { key: 'compositeScore', label: 'Composite', unit: 'score', ceiling: 100, higherIsBetter: true, weights: { median: 1, p95: 0, p99: 0 } },
  { key: 'downloadSupported', label: 'Download supported', unit: 'score', ceiling: 1, higherIsBetter: true, weights: { median: 0, p95: 0, p99: 0 } },
  { key: 'downloadMs', label: 'Download', unit: 'ms', ceiling: TRANSFER_LATENCY_CEILING_MS, weights: { median: 0, p95: 0, p99: 0 } },
  { key: 'downloadBytes', label: 'Download bytes', unit: 'bytes', ceiling: 4096, higherIsBetter: true, weights: { median: 0, p95: 0, p99: 0 } },
  { key: 'downloadMatch', label: 'Download match', unit: 'score', ceiling: 1, higherIsBetter: true, weights: { median: 0, p95: 0, p99: 0 } },
  { key: 'uploadSupported', label: 'Upload supported', unit: 'score', ceiling: 1, higherIsBetter: true, weights: { median: 0, p95: 0, p99: 0 } },
  { key: 'uploadMs', label: 'Upload', unit: 'ms', ceiling: TRANSFER_LATENCY_CEILING_MS, weights: { median: 0, p95: 0, p99: 0 } },
  { key: 'uploadMatch', label: 'Upload match', unit: 'score', ceiling: 1, higherIsBetter: true, weights: { median: 0, p95: 0, p99: 0 } },
  { key: 'totalMs', label: 'Total', unit: 'ms', ceiling: 300_000, weights: { median: 0, p95: 0, p99: 0 } },
];

export const config = defineBenchmarkConfig({
  benchmarkSlug: process.env.BENCHMARK_SLUG ?? 'browser-file-transfer',
  benchmarkName: process.env.BENCHMARK_NAME ?? 'Browser File Transfer',
  iterations: 30,
  concurrency: 1,
  groupBy: 'round',
  participants: fileTransferProviders,
  scoring: continuousScoring({
    success: { requireData: { benchCompleted: 1 } },
    metrics: scoringMetrics,
  }),
  display: {
    metrics: [
      { key: 'compositeScore', label: 'Composite', direction: 'higher-better', decimals: 0 },
      { key: 'downloadSupported', label: 'Download', direction: 'higher-better', decimals: 0 },
      { key: 'downloadMs', label: 'Download ms', direction: 'lower-better', decimals: 0 },
      { key: 'downloadBytes', label: 'Download bytes', direction: 'higher-better', decimals: 0 },
      { key: 'downloadMatch', label: 'Download match', direction: 'higher-better', decimals: 0 },
      { key: 'uploadSupported', label: 'Upload', direction: 'higher-better', decimals: 0 },
      { key: 'uploadMs', label: 'Upload ms', direction: 'lower-better', decimals: 0 },
      { key: 'uploadMatch', label: 'Upload match', direction: 'higher-better', decimals: 0 },
      { key: 'totalMs', label: 'Total ms', direction: 'lower-better', decimals: 0 },
    ],
    steps: [
      { key: 'create', label: 'Create session' },
      { key: 'connect', label: 'Connect CDP' },
      { key: 'download', label: 'Download' },
      { key: 'upload', label: 'Upload' },
      { key: 'release', label: 'Release' },
    ],
    byStep: { defaultLayout: 'matrix' },
    overview: { defaultMetric: 'compositeScore', defaultLayout: 'ranking' },
  },
  onComplete: (outcome) =>
    writeFileTransferResults(outcome.participants, {
      resultsDir: path.resolve(__dirname, '../../../results/browser_file_transfer'),
      runConfig: outcome.config,
    }),
});

export const task = defineTask<FileTransferProviderConfig>(async (ctx) => {
  const { participant, step, measure, log } = ctx;
  const provider = participant.name;
  const taskStart = performance.now();

  const out: Record<string, unknown> = { provider };
  const metrics: Record<string, number> = {};
  let browserProvider: any;
  let sessionId = '';
  let connectUrl = '';
  let browser: Browser | undefined;
  let page: Page | undefined;

  await step('create', async () => {
    browserProvider = participant.createBrowserProvider();
    const session = await withTimeout(
      browserProvider.session.create(participant.sessionCreateOptions ?? {}),
      participant.timeout ?? SESSION_CREATE_TIMEOUT_MS,
      'session create timed out',
    ) as { sessionId: string; connectUrl: string };
    sessionId = session.sessionId;
    connectUrl = session.connectUrl;
    out.sessionId = sessionId;
  });

  try {
    await step('connect', async () => {
      browser = await withTimeout(chromium.connectOverCDP(connectUrl), CONNECT_TIMEOUT_MS, 'CDP connect timed out');
      const context = browser.contexts()[0] ?? (await browser.newContext());
      page = context.pages()[0] ?? (await context.newPage());
    });

    try {
      await step('download', async () => {
        let outcome: DownloadOutcome | null = null;
        const fixtureErrors: string[] = [];
        for (const fixture of TRANSFER_FIXTURES) {
          outcome = await runDownloadOnFixture(page!, browser!, fixture, participant, sessionId, log);
          if (outcome) break;
          fixtureErrors.push(fixture.name);
        }
        if (!outcome) {
          throw new TaskError(`all download fixtures unreachable: ${fixtureErrors.join(', ')}`, { code: 'FIXTURES_UNREACHABLE' });
        }
        out.fixture = outcome.fixture;
        out.downloadMechanism = outcome.mechanism;
        out.downloadAttempts = outcome.attempts;
        out.downloadError = outcome.error;
        out.downloadSha256 = outcome.sha256;
        metrics.downloadSupported = outcome.supported;
        metrics.downloadMs = outcome.supported ? outcome.ms : 0;
        metrics.downloadBytes = outcome.bytes;
        metrics.downloadMatch = outcome.match;
        measure(metrics);
        // Unsupported/unverified is a capability result — mark the step
        // 'error' for honesty but do not fail the record.
        if (outcome.supported === 0 || outcome.match === 0) {
          throw new TaskError(outcome.error ?? 'download not verified', { code: 'CAPABILITY_UNSUPPORTED' });
        }
      });
    } catch (err) {
      if (!(err instanceof TaskError && err.code === 'CAPABILITY_UNSUPPORTED')) throw err;
      log(`download: ${formatError(err)}`, { level: 'warn' });
    }

    try {
      await step('upload', async () => {
        let outcome: UploadOutcome | null = null;
        const fixtureErrors: string[] = [];
        for (const fixture of TRANSFER_FIXTURES) {
          outcome = await runUploadOnFixture(page!, fixture, log);
          if (outcome) break;
          fixtureErrors.push(fixture.name);
        }
        if (!outcome) {
          throw new TaskError(`all upload fixtures unreachable: ${fixtureErrors.join(', ')}`, { code: 'FIXTURES_UNREACHABLE' });
        }
        out.uploadFixture = outcome.fixture;
        out.uploadError = outcome.error;
        metrics.uploadSupported = outcome.supported;
        metrics.uploadMs = outcome.supported ? outcome.ms : 0;
        metrics.uploadMatch = outcome.match;
        measure(metrics);
        if (outcome.supported === 0 || outcome.match === 0) {
          throw new TaskError(outcome.error ?? 'upload not verified', { code: 'CAPABILITY_UNSUPPORTED' });
        }
      });
    } catch (err) {
      if (!(err instanceof TaskError && err.code === 'CAPABILITY_UNSUPPORTED')) throw err;
      log(`upload: ${formatError(err)}`, { level: 'warn' });
    }
  } finally {
    await step('release', async () => {
      if (browser) await browser.close().catch(() => {});
      if (sessionId && browserProvider) {
        await withTimeout(
          browserProvider.session.destroy(sessionId),
          RELEASE_TIMEOUT_MS,
          'session destroy timed out',
        ).catch((err: unknown) => log(`session destroy failed: ${formatError(err)}`, { level: 'warn' }));
      }
    }, { reportConcurrency: false });
  }

  const totalMs = performance.now() - taskStart;

  // Composite: capability gates first (70 pts split across download/upload
  // support), latency differentiates among supported providers (30 pts).
  metrics.totalMs = totalMs;
  metrics.compositeScore = fileTransferPoints(metrics);
  metrics.benchCompleted = 1;

  measure(metrics);
  return { data: { ...out, ...metrics } as unknown as JsonObject, latencyMs: totalMs };
});
