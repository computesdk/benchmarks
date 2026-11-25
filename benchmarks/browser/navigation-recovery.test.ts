import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import test, { before, after, type TestContext } from 'node:test';
import { chromium, type Browser } from 'playwright-core';
import { installNavigationRecovery, Navigation429Error } from './navigation-recovery.js';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { summarizeRounds, writeConcurrentResultsJson } from '../stealth/browser/concurrent-benchmark.js';
import type { ActionResult, RoundResult } from '../stealth/browser/concurrent-types.js';
import { summarizeIterations, writeThroughputResultsJson } from './throughput-benchmark.js';

let browser: Browser;
let server: Server;
let origin: string;
const routes = new Map<string, (request: IncomingMessage, response: ServerResponse, count: number) => void>();
const seen = new Map<string, { at: number; method: string }[]>();
before(async () => {
  server = createServer((request, response) => {
    const url = request.url ?? '/';
    const calls = seen.get(url) ?? [];
    calls.push({ at: performance.now(), method: request.method ?? 'GET' });
    seen.set(url, calls);
    const route = routes.get(url);
    if (route) route(request, response, calls.length);
    else { response.writeHead(404); response.end('missing'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  browser = await chromium.launch({ channel: 'chromium', headless: true });
});
after(async () => {
  await browser?.close();
  await new Promise<void>(resolve => server.close(() => resolve()));
});

function html(response: ServerResponse, body: string, status = 200, headers: Record<string, string> = {}) {
  response.writeHead(status, { 'Content-Type': 'text/html', ...headers });
  response.end(body);
}
async function fixture(t: TestContext) {
  const page = await browser.newPage();
  const recovery = installNavigationRecovery(page, { jitterMs: 0, timeoutMs: 5000, maxRecoveryMs: 3500 });
  t.after(async () => { recovery.dispose(); await page.close(); });
  return { page, recovery };
}

test('normal navigation keeps its response and adds no retry', async t => {
  routes.set('/ok', (_, r) => html(r, '<h1 id="firstHeading">OK</h1>'));
  const { page, recovery } = await fixture(t);
  assert.equal((await recovery.navigate(origin + '/ok'))?.status(), 200);
  await recovery.waitForSelector('#firstHeading');
  assert.equal(await page.textContent('#firstHeading'), 'OK');
  assert.equal(seen.get('/ok')!.length, 1);
  assert.deepEqual(recovery.drainEvents(), []);
});

test('initial 429 recovers inside the measured navigate and returns the final HTTP status', async t => {
  routes.set('/initial', (_, r, n) => n === 1
    ? html(r, '<p>429</p>', 429, { 'Retry-After': '1' }) : html(r, '<h1 id="firstHeading">OK</h1>'));
  const { recovery } = await fixture(t);
  const start = performance.now();
  assert.equal((await recovery.navigate(origin + '/initial'))?.status(), 200);
  assert.ok(performance.now() - start >= 1000, 'backoff is part of the call duration');
  const events = recovery.drainEvents();
  assert.equal(events.filter(e => e.type === 'http429').length, 1);
  assert.equal(events.find(e => e.type === 'retry')?.responseStatus, 200);
});

test('post-click 429 honors Retry-After and reloads the exact URL including query', async t => {
  const target = '/once?keep=exact';
  routes.set('/source', (_, r) => html(r, `<h1 id="firstHeading">Source</h1><a href="${target}">next</a>`));
  routes.set(target, (_, r, n) => n === 1
    ? html(r, '<p>429</p>', 429, { 'Retry-After': '1' }) : html(r, '<h1 id="firstHeading">Recovered</h1>'));
  const { page, recovery } = await fixture(t);
  await recovery.navigate(origin + '/source');
  await page.click('a');
  const initial = recovery.drainEvents();
  assert.equal(initial.filter(e => e.type === 'http429').length, 1, 'click retains the initial block before readiness recovers');
  const start = performance.now();
  await recovery.waitForSelector('#firstHeading');
  assert.ok(performance.now() - start >= 1000);
  const calls = seen.get(target)!;
  assert.equal(calls.length, 2);
  assert.ok(calls[1].at - calls[0].at >= 1000);
  assert.equal(page.url(), origin + target);
  const retries = recovery.drainEvents().filter(e => e.type === 'retry');
  assert.equal(retries.length, 1);
  assert.ok(retries[0].actualWaitMs! >= 1000);
  assert.equal(retries[0].responseStatus, 200);
  assert.equal(JSON.parse(JSON.stringify(initial))[0].retryAfter, '1');
});

test('persistent 429 exhausts two retries shared across navigate and readiness', async t => {
  routes.set('/always', (_, r) => html(r, '<p>429</p>', 429, { 'Retry-After': '1' }));
  const { recovery } = await fixture(t);
  const exhausted = (e: unknown) => e instanceof Navigation429Error && e.retries === 2 && e.status === 429;
  await assert.rejects(recovery.navigate(origin + '/always'), exhausted);
  await assert.rejects(recovery.waitForSelector('#firstHeading'), exhausted);
  assert.equal(seen.get('/always')!.length, 3, 'readiness cannot silently obtain two more retries');
  assert.equal(recovery.drainEvents().filter(e => e.type === 'http429').length, 3);
});

test('a long Retry-After stays a failure without a shortened wait', async t => {
  routes.set('/long', (_, r) => html(r, '<p>429</p>', 429, { 'Retry-After': '60' }));
  const { page, recovery } = await fixture(t);
  await page.goto(origin + '/long');
  await assert.rejects(recovery.waitForSelector('#firstHeading'), /exceeds the recovery\/action budget/);
  assert.equal(seen.get('/long')!.length, 1);
});

test('an HTTP-date Retry-After is respected', async t => {
  let due = '';
  routes.set('/date', (_, r, n) => {
    if (n === 1) { due = new Date(Date.now() + 2000).toUTCString(); html(r, '<p>429</p>', 429, { 'Retry-After': due }); }
    else html(r, '<h1 id="firstHeading">Recovered</h1>');
  });
  const { page, recovery } = await fixture(t);
  await page.goto(origin + '/date');
  await recovery.waitForSelector('#firstHeading');
  assert.ok(Date.now() >= Date.parse(due));
  assert.equal(seen.get('/date')!.length, 2);
});

test('an invalid fractional delay is not misread as a past date and retried', async t => {
  routes.set('/invalid', (_, r) => html(r, '<p>429</p>', 429, { 'Retry-After': '0.5' }));
  const { page, recovery } = await fixture(t);
  await page.goto(origin + '/invalid');
  await assert.rejects(recovery.waitForSelector('#firstHeading'), /invalid Retry-After/);
  assert.equal(seen.get('/invalid')!.length, 1);
});

test('does not replay an unsafe POST navigation', async t => {
  routes.set('/form', (_, r) => html(r, '<form method="POST" action="/post"><button>send</button></form>'));
  routes.set('/post', (_, r) => html(r, '<p>429</p>', 429, { 'Retry-After': '1' }));
  const { page, recovery } = await fixture(t);
  await page.goto(origin + '/form');
  await page.click('button');
  await assert.rejects(recovery.waitForSelector('#firstHeading'), /unsafe request method/);
  assert.equal(seen.get('/post')!.length, 1);
});

test('ignores iframe 429s when the main document is healthy', async t => {
  routes.set('/iframe', (_, r) => html(r, '<p>429</p>', 429, { 'Retry-After': '1' }));
  routes.set('/parent', (_, r) => html(r, '<h1 id="firstHeading">OK</h1><iframe src="/iframe"></iframe>'));
  const { recovery } = await fixture(t);
  await recovery.navigate(origin + '/parent');
  await recovery.waitForSelector('#firstHeading');
  assert.deepEqual(recovery.drainEvents(), []);
  assert.equal(seen.get('/parent')!.length, 1);
});

test('a subsequent navigation obtains its own budget and disposal removes the observer', async t => {
  for (const name of ['/first', '/second']) {
    routes.set(name, (_, r, n) => n === 1
      ? html(r, '<p>429</p>', 429, { 'Retry-After': '1' }) : html(r, '<h1 id="firstHeading">OK</h1>'));
  }
  const { page, recovery } = await fixture(t);
  await recovery.navigate(origin + '/first');
  await recovery.navigate(origin + '/second');
  assert.equal(seen.get('/first')!.length, 2);
  assert.equal(seen.get('/second')!.length, 2);
  assert.deepEqual(recovery.drainEvents().filter(e => e.type === 'retry').map(e => e.attempt), [1, 1]);
  recovery.dispose();
  routes.set('/disposed', (_, r) => html(r, '<p>429</p>', 429, { 'Retry-After': '1' }));
  await page.goto(origin + '/disposed');
  assert.deepEqual(recovery.drainEvents(), [], 'the disposed observer no longer captures responses');
  await assert.rejects(recovery.waitForSelector('#firstHeading'), /disposed/);
  assert.equal(seen.get('/disposed')!.length, 1);
});

test('saved concurrency and throughput results retain recovered blocks, retry details, and measured time', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'navigation-recovery-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const action: ActionResult = {
    index: 6, type: 'waitForSelector', durationMs: 1350, success: true,
    navigationEvents: [
      { type: 'http429', url: 'https://en.wikipedia.org/wiki/Fixture', method: 'GET', status: 429, at: '2026-01-01T00:00:00Z', retryAfter: '1' },
      { type: 'retry', url: 'https://en.wikipedia.org/wiki/Fixture', attempt: 1, retryAfter: '1', minimumWaitMs: 1000,
        scheduledWaitMs: 1000, actualWaitMs: 1001, reloadMs: 349, responseStatus: 200, at: '2026-01-01T00:00:00Z' },
    ],
  };
  const round: RoundResult = {
    concurrencyLevel: 1, roundIndex: 0, sessionsAttempted: 1, sessionsAlive: 1,
    createMs: 5, connectMs: 5, taskMs: 1350, releaseMs: 5, totalMs: 1365, aggregateActionsPerSecond: 1 / 1.35,
    sessions: [{ sessionId: 'fixture', createMs: 5, connectMs: 5, taskMs: 1350, actionsCompleted: 1,
      actionsPerSecond: 1 / 1.35, actions: [action] }],
  };
  const concurrencyFile = path.join(directory, 'concurrency.json');
  await writeConcurrentResultsJson([{ provider: 'fixture', mode: 'browser-concurrent', concurrencyLevel: 1,
    rounds: [round], summary: summarizeRounds([round]) }], concurrencyFile);
  const concurrency = JSON.parse(await readFile(concurrencyFile, 'utf8'));
  assert.deepEqual(concurrency.results[0].rounds[0].sessions[0].actions[0], action);
  assert.equal(concurrency.results[0].rounds[0].taskMs, 1350);

  const iteration = { createMs: 5, connectMs: 5, releaseMs: 5, totalMs: 1365, taskMs: 1350,
    actionsCompleted: 1, actionsPerSecond: 1 / 1.35, actions: [action] };
  const throughputFile = path.join(directory, 'throughput.json');
  await writeThroughputResultsJson([{ provider: 'fixture', mode: 'browser-throughput', iterations: [iteration],
    summary: summarizeIterations([iteration]) }], throughputFile);
  const throughput = JSON.parse(await readFile(throughputFile, 'utf8'));
  assert.deepEqual(throughput.results[0].iterations[0].actions[0], action);
  assert.equal(throughput.results[0].iterations[0].taskMs, 1350);
});
