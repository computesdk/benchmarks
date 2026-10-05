import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-native-core';
import { runBenchmark, type BenchmarkRunOutcome } from '@benchsdk/runner';
import { distribution } from './results.js';
import { articleUrl } from './workload.js';

// Plausible failures covered here: incomplete actions, wrong connection auth,
// lost create response, malformed READY response, refused connection, release
// failure, missing round input, leaked contexts, and trimmed/partial summaries.
test('native suites use real Playwright connections and preserve reliability records', { timeout: 120_000 }, async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'native-bench-'));
  const envNames = ['MOMENTIC_BROWSER_FLEET_URL', 'MOMENTIC_BROWSER_FLEET_API_KEY', 'AZURE_PLAYWRIGHT_SERVICE_URL', 'AZURE_PLAYWRIGHT_ACCESS_TOKEN', 'PLAYWRIGHT_NATIVE_ENVIRONMENT_FILE', 'PLAYWRIGHT_NATIVE_URLS_FILE', 'PLAYWRIGHT_NATIVE_RESULTS_DIR'];
  const previous = new Map(envNames.map(key => [key, process.env[key]]));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(directory, 'key.pem'), '-out', path.join(directory, 'cert.pem'), '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
  const listen = (server: http.Server | https.Server) => new Promise<number>(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      resolve(address.port);
    });
  });
  const fixtures = https.createServer({ key: readFileSync(path.join(directory, 'key.pem')), cert: readFileSync(path.join(directory, 'cert.pem')) }, (req, res) => {
    if (req.url === '/slow.gif') {
      setTimeout(() => { res.setHeader('Content-Type', 'image/gif'); res.end(Buffer.from('47494638396101000100800000000000ffffff21f90401000000002c00000000010001000002024401003b', 'hex')); }, 150);
      return;
    }
    res.setHeader('Content-Type', 'text/html');
    if (req.headers.host?.includes('example.com')) {
      res.end('<html><body>Ready<img src="/slow.gif"></body></html>');
      return;
    }
    const link = req.url?.includes('Native_no_links') ? '' : '<a href="/wiki/Native_target">Article</a>';
    res.end(`<html><body><h1 id="firstHeading">Fixture</h1><div id="mw-content-text"><a href="/wiki/Help:Docs">Help</a>${link}</div></body></html>`);
  });
  const fixturePort = await listen(fixtures);
  fixtures.on('connection', socket => socket.on('error', () => {}));
  const sessions = new Map<string, string>();
  const terminated = new Set<string>();
  const order: string[] = [];
  const websocketAuth: string[] = [];
  let mode = '';
  let lost = false;
  let endpoint = '';
  const api = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    res.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/browsers') {
      assert.equal(req.headers.authorization, 'Bearer local-azure-credential');
      assert.equal(url.searchParams.get('os'), 'Linux');
      assert.equal(url.searchParams.get('api-version'), '2025-09-01');
      order.push('azure');
      res.writeHead(302, { Location: mode === 'refused-connection' ? 'ws://127.0.0.1:1/refused?token=private-query' : `ws://127.0.0.1:${apiPort}/connect/azure/${url.searchParams.get('runId')}` });
      res.end();
      return;
    }
    // Chromium may make unrelated startup requests through the fixture proxy.
    if (!url.pathname.startsWith('/v1/sessions')) { res.writeHead(404); res.end('{}'); return; }
    assert.equal(req.headers.authorization, 'Bearer local-momentic-credential');
    const id = url.pathname.split('/').at(-1);
    if (req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      assert.equal(JSON.parse(body).playwrightVersion, '1.60.0');
      const key = String(req.headers['idempotency-key']);
      if (!sessions.has(key)) { sessions.set(key, `session-${sessions.size}`); order.push('momentic'); }
      const sessionId = sessions.get(key);
      if (mode === 'lost-response' && !lost) { lost = true; req.socket.destroy(); return; }
      if (mode === 'malformed-json') { res.end('{"connectToken":"local-unpublished-credential'); return; }
      res.end(JSON.stringify({ id: sessionId, status: 'READY', playwrightVersion: '1.60.0', wsEndpoint: mode === 'refused-connection' ? 'ws://127.0.0.1:1/refused?token=private-query' : `ws://127.0.0.1:${apiPort}/connect/momentic/${sessionId}`, ...(mode !== 'malformed-ready' ? { connectToken: 'local-connect-credential' } : {}) }));
    } else if (req.method === 'DELETE') {
      if (mode === 'cleanup-failure') { res.writeHead(500); res.end('{}'); return; }
      if (id) terminated.add(id);
      res.writeHead(204); res.end();
    } else {
      res.end(JSON.stringify({ id, status: terminated.has(id ?? '') ? 'TERMINATED' : 'READY' }));
    }
  });
  const sockets = new Set<net.Socket>();
  api.on('connection', socket => { sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket)); });
  api.on('connect', (_req, socket, head) => {
    const upstream = net.connect(fixturePort, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('close', () => upstream.destroy());
  });
  api.on('upgrade', (req, socket, head) => {
    const provider = req.url?.includes('/momentic/') ? 'momentic' : 'azure';
    const expected = provider === 'momentic' ? 'Bearer local-connect-credential' : 'Bearer local-azure-credential';
    if (req.headers.authorization !== expected) { socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n'); return; }
    websocketAuth.push(provider);
    const target = new URL(endpoint);
    const upstream = net.connect(Number(target.port), '127.0.0.1', () => {
      const headers = Object.entries(req.headers).filter(([key]) => key !== 'host').map(([key, value]) => `${key}: ${value}`).join('\r\n');
      upstream.write(`GET ${target.pathname} HTTP/1.1\r\nHost: ${target.host}\r\n${headers}\r\n\r\n`);
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('close', () => upstream.destroy());
  });
  const apiPort = await listen(api);
  const server = await chromium.launchServer({ host: '127.0.0.1', headless: true, ...(process.env.PLAYWRIGHT_NATIVE_TEST_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_NATIVE_TEST_EXECUTABLE } : {}), args: ['--ignore-certificate-errors'], proxy: { server: `http://127.0.0.1:${apiPort}` } });
  endpoint = server.wsEndpoint();
  try {
    const environment = { region: 'local-fixture', runnerLocation: 'local-fixture', providers: Object.fromEntries(['momentic', 'azure'].map(name => [name, { region: 'local-fixture', playwrightVersion: '1.60.0', os: 'linux', headless: true, stealth: false, proxy: false, recording: false, placementEvidence: 'local fixture only', versionEvidence: 'local launchServer version', cleanupEvidence: 'fixture lifecycle verification' }])) };
    const urls = Array.from({ length: 100 }, (_, i) => `https://en.wikipedia.org/wiki/${i === 2 ? 'Native_no_links' : `Native_fixture_${i}`}`);
    const environmentFile = path.join(directory, 'environment.json');
    const urlsFile = path.join(directory, 'urls.json');
    writeFileSync(environmentFile, JSON.stringify(environment));
    writeFileSync(urlsFile, JSON.stringify(urls));
    Object.assign(process.env, { MOMENTIC_BROWSER_FLEET_URL: `http://127.0.0.1:${apiPort}`, MOMENTIC_BROWSER_FLEET_API_KEY: 'local-momentic-credential', AZURE_PLAYWRIGHT_SERVICE_URL: `http://127.0.0.1:${apiPort}/browsers`, AZURE_PLAYWRIGHT_ACCESS_TOKEN: 'local-azure-credential', PLAYWRIGHT_NATIVE_ENVIRONMENT_FILE: environmentFile, PLAYWRIGHT_NATIVE_URLS_FILE: urlsFile, PLAYWRIGHT_NATIVE_RESULTS_DIR: directory });
    const readiness = await import('../playwright-readiness.bench.js');
    const throughput = await import('../playwright-throughput.bench.js');
    const records = (outcome: BenchmarkRunOutcome) => outcome.participants.flatMap(p => p.records);
    const ready = await runBenchmark({ ...readiness.config, iterations: 2 }, readiness.task, ['--no-ingest']);
    assert.deepEqual(order, ['momentic', 'azure', 'momentic', 'azure']);
    assert.deepEqual(websocketAuth, order);
    for (const record of records(ready)) {
      assert.equal(record.status, 'success');
      assert.equal(record.data?.sessionSuccess, true);
      assert.ok(Number(record.data?.readinessMs) >= 150, 'readiness waits for the delayed subresource load');
      assert.ok(Number(record.latencyMs) >= Number(record.data?.readinessMs));
    }
    order.length = 0;
    const through = await runBenchmark({ ...throughput.config, iterations: 3 }, throughput.task, ['--no-ingest']);
    assert.deepEqual(order, ['momentic', 'azure', 'momentic', 'azure', 'momentic', 'azure']);
    for (const record of records(through)) {
      const actions = record.data?.actions;
      assert.ok(Array.isArray(actions));
      assert.equal(actions.length, 50);
      const screenshots = actions.filter(a => a && typeof a === 'object' && !Array.isArray(a) && a.type === 'screenshot');
      if (record.taskIndex < 2) {
        assert.equal(record.status, 'success');
        assert.equal(record.data?.actionsCompleted, 50);
        assert.equal(screenshots.length, 10);
        assert.equal(record.data?.articleUrl, urls[record.taskIndex]);
      } else {
        assert.equal(record.status, 'error');
        assert.equal(record.data?.actionsCompleted, 20);
        assert.equal(actions.filter(a => a && typeof a === 'object' && !Array.isArray(a) && a.error === 'skipped: click failed').length, 25);
      }
      const sum = actions.reduce<number>((total, a) => total + (a && typeof a === 'object' && !Array.isArray(a) ? Number(a.durationMs) : 0), 0);
      assert.equal(record.data?.taskMs, sum);
      assert.equal(record.data?.actionsPerSecond, Number(record.data?.actionsCompleted) / (sum / 1000));
      assert.equal(record.steps?.find(step => step.name === 'actions')?.data?.actionsPerSecond, record.data?.actionsPerSecond);
    }
    const outputFile = path.join(directory, 'throughput', readdirSync(path.join(directory, 'throughput'))[0]);
    const raw = readFileSync(outputFile, 'utf8');
    for (const secret of ['local-momentic-credential', 'local-connect-credential', 'local-azure-credential']) assert.ok(!raw.includes(secret));
    const output = JSON.parse(raw);
    assert.deepEqual(output.articleUrls, urls);
    for (const summary of output.summaries) {
      assert.equal(summary.attempts, 3);
      assert.equal(summary.successRate, 2 / 3);
      assert.equal(summary.metrics.actionsPerSecond.count, 2);
      assert.equal(summary.perActionType.screenshot.count, 20);
    }
    for (const failureMode of ['lost-response', 'malformed-ready', 'refused-connection', 'cleanup-failure']) {
      mode = failureMode;
      order.length = 0;
      const participants = readiness.config.participants.filter(p => p.name === 'momentic').map(p => ({ ...p }));
      const failed = await runBenchmark({ ...readiness.config, participants, iterations: failureMode === 'cleanup-failure' ? 2 : 1 }, readiness.task, ['--no-ingest']);
      assert.equal(records(failed)[0].status, 'error');
      assert.equal(records(failed)[0].data?.attemptStarted, true);
      assert.equal(records(failed)[0].data?.cleanupSuccess, failureMode !== 'cleanup-failure');
      assert.ok(!JSON.stringify(failed).includes('private-query'));
      if (failureMode === 'cleanup-failure') {
        assert.equal(records(failed)[1].data?.attemptStarted, false);
        assert.deepEqual(order, ['momentic'], 'uncertain cleanup stops new allocations');
      } else assert.equal(terminated.size, sessions.size);
    }
    mode = 'refused-connection';
    const azureFailure = await runBenchmark({ ...readiness.config, participants: readiness.config.participants.filter(p => p.name === 'azure').map(p => ({ ...p })), iterations: 2 }, readiness.task, ['--no-ingest']);
    assert.equal(records(azureFailure)[0].data?.cleanupSuccess, false);
    assert.equal(records(azureFailure)[1].data?.attemptStarted, false);
    assert.ok(!JSON.stringify(azureFailure).includes('private-query'));
    mode = 'malformed-json';
    const malformed = await runBenchmark({ ...readiness.config, participants: readiness.config.participants.filter(p => p.name === 'momentic').map(p => ({ ...p })), iterations: 1 }, readiness.task, ['--no-ingest']);
    assert.equal(records(malformed)[0].data?.cleanupSuccess, false);
    assert.ok(!JSON.stringify(malformed).includes('local-unpublished-credential'));
    assert.throws(() => articleUrl('https://local-user:local-password@en.wikipedia.org/wiki/Fixture'));
    mode = '';
    order.length = 0;
    const missing = await runBenchmark({ ...throughput.config, iterations: 1 }, ctx => throughput.task({ ...ctx, taskIndex: 100 }), ['--no-ingest']);
    assert.deepEqual(order, []);
    assert.ok(records(missing).every(record => record.status === 'error' && record.data?.attemptStarted === false));
    assert.deepEqual(distribution(Array.from({ length: 100 }, (_, i) => i + 1)), { count: 100, median: 50.5, p95: 95, p99: 99 });
    assert.equal(distribution([]).median, null);
    writeFileSync(urlsFile, JSON.stringify(urls.slice(0, 1)));
    order.length = 0;
    await assert.rejects(promisify(execFile)(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'packages/benchsdk-runner/dist/bin.js', 'run', 'benchmarks/browser/playwright-throughput.bench.ts', '--no-ingest', '--iterations', '2'], { env: process.env }), /Prepare a validated article URL/);
    assert.deepEqual(order, [], 'short input lists fail before any provider request');
    writeFileSync(urlsFile, JSON.stringify(urls));
    // Exercise the published CLI entrypoints, not only runBenchmark imports.
    for (const entry of ['playwright-readiness', 'playwright-throughput']) {
      const { stdout } = await promisify(execFile)(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'packages/benchsdk-runner/dist/bin.js', 'run', `benchmarks/browser/${entry}.bench.ts`, '--no-ingest', '--iterations', '1'], { env: process.env });
      assert.ok(stdout.includes('All done. No platform run created.'));
      assert.ok(!stdout.includes('FAILED'));
    }
    const audit = await chromium.connect(endpoint);
    assert.equal(audit.contexts().length, 0, 'all benchmark contexts were closed');
    await audit.close();
    console.log('Verified real native connections, 50-action records, round interleaving, load boundary, auth, partial failures, cleanup recovery, secret-free artifacts, and untrimmed summaries.');
  } finally {
    await server.close();
    for (const socket of sockets) socket.destroy();
    api.closeAllConnections(); fixtures.closeAllConnections();
    await Promise.all([new Promise<void>(resolve => api.close(() => resolve())), new Promise<void>(resolve => fixtures.close(() => resolve()))]);
    for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(directory, { recursive: true, force: true });
  }
});
