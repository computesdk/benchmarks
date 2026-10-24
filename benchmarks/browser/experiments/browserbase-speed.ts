/**
 * EXPERIMENT — not a benchmark. Does not report to the platform. DO NOT MERGE.
 *
 * Where does Browserbase lose ~800ms/session to Tilion on the public
 * browser-throughput benchmark, and which public-API create options recover
 * any of it? Runs "arms" (provider × create options × release mode) in
 * interleaved rounds — round i runs every arm once against the same Wikipedia
 * article, 15s apart — so time-of-day confounds cancel and every Browserbase
 * arm is paired in time with a Tilion session.
 *
 * Every arm replays the bench's exact session: create → connectOverCDP →
 * [goto, waitForSelector, screenshot, textContent, click, waitForSelector,
 * screenshot, textContent, goBack, waitForSelector] → browser.close → destroy,
 * timed like benchmarks/browser/browser-throughput.bench.ts. Outside the timed
 * actions it also records Navigation Timing of the first goto, Wikipedia's
 * x-cache / x-client-ip / server / age headers, navigator.userAgent, a second
 * goto (cold vs warm profile), an in-page fetch TTFB, and control-plane
 * DNS/TCP/TLS/HTTP probes from the runner.
 *
 * Output: EXPERIMENT_OUT/<leg>.json — metrics only. No API keys, project ids,
 * connect URLs, session ids, or non-public hostnames are written or logged.
 *
 *   EXPERIMENT_ARMS=tilion,bb-default,bb-raw EXPERIMENT_SESSIONS=30 \
 *     THROUGHPUT_URLS='...' npx tsx benchmarks/browser/experiments/browserbase-speed.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import dns from 'node:dns/promises';
import net from 'node:net';
import tls from 'node:tls';
import https from 'node:https';
import Browserbase from '@browserbasehq/sdk';
import { browserbase } from '@computesdk/browserbase';
import { tilion } from '@computesdk/tilion';
import { chromium, type Browser, type Page, type Response } from 'playwright-core';

const LEG = process.env.EXPERIMENT_LEG ?? 'local';
const RUNNER = process.env.EXPERIMENT_RUNNER ?? 'unknown';
const SESSIONS = Number(process.env.EXPERIMENT_SESSIONS ?? 30);
const SPACING_MS = Number(process.env.EXPERIMENT_SPACING_MS ?? 15_000);
const OUT_DIR = process.env.EXPERIMENT_OUT ?? path.resolve('results/experiments/browserbase-speed');
const ARMS = (process.env.EXPERIMENT_ARMS ?? 'tilion,bb-default').split(',').map((s) => s.trim()).filter(Boolean);
const PROBE_EVERY = Number(process.env.EXPERIMENT_PROBE_EVERY ?? 10);
const ACTION_TIMEOUT_MS = 30_000;
const VIEWPORT = { width: 1920, height: 1080 };
const FIRST_HEADING = '#firstHeading';
const ARTICLE_LINK_SELECTOR = '#mw-content-text a[href*="/wiki/"]';

// ─── Arms ────────────────────────────────────────────────────────────────────

type ReleaseMode = 'close+release' | 'close-only' | 'release-only' | 'close+release+poll';
type Connect = 'playwright' | 'rawws-then-playwright';
interface Arm {
  name: string;
  provider: 'browserbase' | 'tilion';
  /** how the create call is issued */
  via: 'adapter' | 'sdk-reused' | 'raw-fetch' | 'raw-keepalive';
  /** adapter-shaped options (CreateBrowserSessionOptions) for via=adapter */
  options?: Record<string, unknown>;
  /** Browserbase REST body for via=sdk-reused / raw-fetch (projectId added at runtime) */
  body?: Record<string, unknown>;
  release: ReleaseMode;
  connect: Connect;
  note: string;
}

// Exactly what the bench sends Browserbase (benchmarks/browser/throughput-providers.ts).
const BENCH_BB_OPTIONS = {
  region: 'us-east-1', stealth: false, proxies: false, headless: true,
  viewport: VIEWPORT, recording: false, enableNativeSelectPolyfill: false,
};
// What @computesdk/browserbase turns that into on the wire.
const BENCH_BB_BODY = {
  region: 'us-east-1', proxies: false,
  browserSettings: { viewport: VIEWPORT, advancedStealth: false, recordSession: false },
};
const BENCH_TILION_OPTIONS = { stealth: false, proxies: false, headless: true, viewport: VIEWPORT };

function bbBody(patch: Record<string, unknown>, settings?: Record<string, unknown>): Record<string, unknown> {
  const base = JSON.parse(JSON.stringify(BENCH_BB_BODY));
  const bs = { ...base.browserSettings, ...(settings ?? {}) };
  for (const k of Object.keys(bs)) if (bs[k] === undefined) delete bs[k];
  return { ...base, ...patch, browserSettings: bs };
}

const ARM_DEFS: Arm[] = [
  { name: 'tilion', provider: 'tilion', via: 'adapter', options: BENCH_TILION_OPTIONS, release: 'close+release', connect: 'playwright', note: 'reference: bench-identical Tilion session' },
  { name: 'tilion-rawws', provider: 'tilion', via: 'adapter', options: BENCH_TILION_OPTIONS, release: 'close+release', connect: 'rawws-then-playwright', note: 'Tilion + raw WebSocket open/Browser.getVersion before connectOverCDP' },
  { name: 'bb-default', provider: 'browserbase', via: 'adapter', options: BENCH_BB_OPTIONS, release: 'close+release', connect: 'playwright', note: 'bench-identical: @computesdk/browserbase adapter, new SDK client per call' },
  { name: 'bb-sdk-reused', provider: 'browserbase', via: 'sdk-reused', body: BENCH_BB_BODY, release: 'close+release', connect: 'playwright', note: 'same body through one long-lived @browserbasehq/sdk client' },
  { name: 'bb-raw', provider: 'browserbase', via: 'raw-fetch', body: BENCH_BB_BODY, release: 'close+release', connect: 'playwright', note: 'same body via node https.request on a fresh TCP+TLS connection, no SDK; phases recorded' },
  { name: 'bb-raw-keepalive', provider: 'browserbase', via: 'raw-keepalive', body: BENCH_BB_BODY, release: 'close+release', connect: 'playwright', note: 'same request on a keep-alive agent (connection reused across sessions) — isolates server time' },
  { name: 'bb-rawws', provider: 'browserbase', via: 'adapter', options: BENCH_BB_OPTIONS, release: 'close+release', connect: 'rawws-then-playwright', note: 'raw WebSocket open/Browser.getVersion before connectOverCDP' },
  // Release path (D)
  { name: 'bb-rel-close-only', provider: 'browserbase', via: 'sdk-reused', body: BENCH_BB_BODY, release: 'close-only', connect: 'playwright', note: 'browser.close() only, then poll sessions.retrieve until not RUNNING' },
  { name: 'bb-rel-release-only', provider: 'browserbase', via: 'sdk-reused', body: BENCH_BB_BODY, release: 'release-only', connect: 'playwright', note: 'REQUEST_RELEASE without browser.close()' },
  { name: 'bb-rel-poll', provider: 'browserbase', via: 'sdk-reused', body: BENCH_BB_BODY, release: 'close+release+poll', connect: 'playwright', note: 'close + REQUEST_RELEASE, then poll until COMPLETED' },
  // Public knobs (C) — one change each vs bb-sdk-reused
  { name: 'bb-region-us-west-2', provider: 'browserbase', via: 'sdk-reused', body: bbBody({ region: 'us-west-2' }), release: 'close+release', connect: 'playwright', note: 'region us-west-2' },
  { name: 'bb-region-eu-central-1', provider: 'browserbase', via: 'sdk-reused', body: bbBody({ region: 'eu-central-1' }), release: 'close+release', connect: 'playwright', note: 'region eu-central-1' },
  { name: 'bb-region-ap-southeast-1', provider: 'browserbase', via: 'sdk-reused', body: bbBody({ region: 'ap-southeast-1' }), release: 'close+release', connect: 'playwright', note: 'region ap-southeast-1' },
  { name: 'bb-region-omitted', provider: 'browserbase', via: 'sdk-reused', body: bbBody({ region: undefined }), release: 'close+release', connect: 'playwright', note: 'no region (project default)' },
  { name: 'bb-log-off', provider: 'browserbase', via: 'sdk-reused', body: bbBody({}, { logSession: false }), release: 'close+release', connect: 'playwright', note: 'logSession false' },
  { name: 'bb-rec-on', provider: 'browserbase', via: 'sdk-reused', body: bbBody({}, { recordSession: true }), release: 'close+release', connect: 'playwright', note: 'recordSession true (bench sends false)' },
  { name: 'bb-captcha-off', provider: 'browserbase', via: 'sdk-reused', body: bbBody({}, { solveCaptchas: false }), release: 'close+release', connect: 'playwright', note: 'solveCaptchas false' },
  { name: 'bb-blockads', provider: 'browserbase', via: 'sdk-reused', body: bbBody({}, { blockAds: true }), release: 'close+release', connect: 'playwright', note: 'blockAds true' },
  { name: 'bb-stealth', provider: 'browserbase', via: 'sdk-reused', body: bbBody({}, { advancedStealth: true }), release: 'close+release', connect: 'playwright', note: 'advancedStealth true' },
  { name: 'bb-no-viewport', provider: 'browserbase', via: 'sdk-reused', body: bbBody({}, { viewport: undefined }), release: 'close+release', connect: 'playwright', note: 'viewport omitted' },
  { name: 'bb-keepalive', provider: 'browserbase', via: 'sdk-reused', body: bbBody({ keepAlive: true }), release: 'close+release', connect: 'playwright', note: 'keepAlive true' },
  { name: 'bb-timeout60', provider: 'browserbase', via: 'sdk-reused', body: bbBody({ timeout: 60 }), release: 'close+release', connect: 'playwright', note: 'timeout 60s' },
  { name: 'bb-minimal', provider: 'browserbase', via: 'sdk-reused', body: { region: 'us-east-1' }, release: 'close+release', connect: 'playwright', note: 'region only, no browserSettings/proxies' },
  { name: 'bb-lean', provider: 'browserbase', via: 'sdk-reused', body: bbBody({}, { logSession: false, solveCaptchas: false }), release: 'close+release', connect: 'playwright', note: 'logSession false + solveCaptchas false' },
];
const ARM_BY_NAME = new Map(ARM_DEFS.map((a) => [a.name, a]));

// ─── Records ─────────────────────────────────────────────────────────────────

interface ActionRec { index: number; type: string; durationMs: number; success: boolean; error?: string }
interface NavTiming {
  redirect: number; dns: number; connect: number; tls: number; ttfb: number; response: number;
  domInteractive: number; domContentLoaded: number; loadEvent: number; duration: number;
  transferSize?: number; protocol?: string; type?: string;
}
interface SessionRec {
  arm: string; round: number; ts: string; url: string;
  createMs?: number; connectMs?: number; releaseMs?: number; totalMs?: number; taskMs?: number;
  actionsCompleted?: number; actionsPerSecond?: number; screenshotMs?: number;
  actions: ActionRec[];
  createHttp?: { status?: number; serverTiming?: string; cfRay?: boolean; via?: string; server?: string; sessionStatus?: string; sessionRegion?: string; phases?: Record<string, number> };
  connectHost?: string;
  rawWs?: { openMs: number; getVersionMs: number; product?: string; error?: string };
  navTiming?: NavTiming; navHeaders?: Record<string, string>; navStatus?: number; navCache?: 'hit' | 'miss' | 'unknown'; navPop?: string; orderInRound?: number;
  secondNav?: { durationMs: number; status?: number; timing?: NavTiming; headers?: Record<string, string>; error?: string };
  inPageFetch?: { ttfbMs: number; totalMs: number; status?: number; xCache?: string; error?: string };
  egressIp?: string; userAgent?: string; chromeVersion?: string;
  release?: { mode: ReleaseMode; closeMs?: number; restMs?: number; restPhases?: Record<string, number>; pollMs?: number; finalStatus?: string; polls?: number };
  error?: string;
}
interface Probe { host: string; label: string; ts: string; dnsMs: number; tcpMs: number; tlsMs: number; httpMs: number; status?: number; ip?: string; alpn?: string; error?: string }

const sessions: SessionRec[] = [];
const probes: Probe[] = [];
const STARTED_AT = new Date().toISOString();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const now = () => performance.now();
const r1 = (n: number) => Math.round(n * 10) / 10;
function log(msg: string, extra?: Record<string, unknown>) {
  console.log(`[${new Date().toISOString()}] ${msg}${extra ? ' ' + JSON.stringify(extra) : ''}`);
}

// ─── URLs (same env contract as the bench) ───────────────────────────────────

function parseNavUrls(): string[] {
  const raw = process.env.THROUGHPUT_URLS?.trim();
  if (!raw) return [];
  if (raw.startsWith('[')) {
    try { const p = JSON.parse(raw); if (Array.isArray(p)) return p.filter((u): u is string => typeof u === 'string' && u.length > 0); } catch { /* fall through */ }
  }
  return raw.split(/\s+/).filter((u) => u.length > 0);
}
const navUrls = parseNavUrls();
const urlFor = (i: number) => navUrls.length ? navUrls[i % navUrls.length] : 'https://en.wikipedia.org/wiki/Special:Random';

// ─── Secret hygiene ──────────────────────────────────────────────────────────

/** Hostnames we may write: Browserbase's public hosts and tilion.dev. Anything else is redacted. */
function safeHost(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const h = new URL(url).hostname;
    return /(^|\.)(browserbase\.com|tilion\.dev)$/.test(h) ? h : 'redacted-host';
  } catch { return 'unparseable'; }
}
function scrub(s: string): string {
  return s
    .replace(/wss?:\/\/\S+/g, '<ws-url>')
    .replace(/https?:\/\/\S+/g, (m) => (/wikipedia\.org/.test(m) ? m : '<url>'))
    .replace(/(apiKey|api_key|token|signingKey)=[^&\s]+/gi, '$1=<redacted>')
    .replace(/bb_live_[A-Za-z0-9_-]+/g, '<bb-key>')
    .slice(0, 300);
}
const errMsg = (e: unknown) => scrub(e instanceof Error ? e.message.split('\n')[0] : String(e));

// ─── Control-plane probes (DNS / TCP / TLS / HTTP from the runner) ───────────

async function probeHost(host: string, label: string, httpPath = '/'): Promise<Probe> {
  const p: Probe = { host, label, ts: new Date().toISOString(), dnsMs: -1, tcpMs: -1, tlsMs: -1, httpMs: -1 };
  try {
    let t = now();
    const { address } = await dns.lookup(host);
    p.dnsMs = r1(now() - t); p.ip = address;
    t = now();
    const sock = await new Promise<net.Socket>((res, rej) => { const s = net.connect({ host: address, port: 443 }, () => res(s)); s.once('error', rej); });
    p.tcpMs = r1(now() - t);
    t = now();
    const tsock = await new Promise<tls.TLSSocket>((res, rej) => { const s = tls.connect({ socket: sock, servername: host, ALPNProtocols: ['http/1.1'] }, () => res(s)); s.once('error', rej); });
    p.tlsMs = r1(now() - t); p.alpn = tsock.alpnProtocol || undefined;
    t = now();
    await new Promise<void>((res, rej) => {
      const req = https.request({ host, path: httpPath, method: 'GET', createConnection: () => tsock, headers: { 'user-agent': 'computesdk-bench-experiment' } }, (resp) => {
        p.status = resp.statusCode; resp.resume(); resp.on('end', res);
      });
      req.setTimeout(10_000, () => req.destroy(new Error('timeout')));
      req.once('error', rej); req.end();
    });
    p.httpMs = r1(now() - t);
    tsock.destroy();
  } catch (e) { p.error = errMsg(e); }
  return p;
}

/** Real hostnames to probe, keyed by label. Non-public names are probed but written as 'redacted-host' with no IP. */
const probeTargets = new Map<string, string>([['browserbase-api', 'api.browserbase.com'], ['wikipedia-from-runner', 'en.wikipedia.org']]);
function rememberProbeHost(label: string, url: string | undefined) {
  try { if (url) probeTargets.set(label, new URL(url).hostname); } catch { /* ignore */ }
}
async function runProbes() {
  for (const [label, host] of probeTargets) {
    for (let k = 0; k < 3; k++) {
      const p = await probeHost(host, label);
      if (!/(^|\.)(browserbase\.com|tilion\.dev|wikipedia\.org)$/.test(host)) { p.host = 'redacted-host'; delete p.ip; }
      probes.push(p);
    }
  }
}

// ─── Create / release implementations ────────────────────────────────────────

const bbApiKey = process.env.BROWSERBASE_API_KEY ?? '';
const bbProjectId = process.env.BROWSERBASE_PROJECT_ID ?? '';
const tilionBaseUrl = (process.env.TILION_BASE_URL || 'https://api.tilion.dev').replace(/\/+$/, '');
let sdkClient: Browserbase | undefined;
let sdkInitMs: number | undefined;
function sdk(): Browserbase {
  if (!sdkClient) { const t = now(); sdkClient = new Browserbase({ apiKey: bbApiKey }); sdkInitMs = r1(now() - t); }
  return sdkClient;
}
const adapterBb = () => browserbase({ apiKey: bbApiKey, projectId: bbProjectId });
const adapterTilion = () => tilion({ apiKey: process.env.TILION_API_KEY!, baseUrl: tilionBaseUrl });
const adapterCache = new Map<string, any>();
function adapterFor(arm: Arm) {
  let a = adapterCache.get(arm.provider);
  if (!a) { a = arm.provider === 'tilion' ? adapterTilion() : adapterBb(); adapterCache.set(arm.provider, a); }
  return a;
}

interface Created { sessionId: string; connectUrl: string; http?: SessionRec['createHttp'] }

async function createSession(arm: Arm, rec: SessionRec): Promise<Created> {
  if (arm.via === 'adapter') {
    const s = await adapterFor(arm).session.create(arm.options);
    const native = (s as any).session ?? {};
    return { sessionId: s.sessionId, connectUrl: s.connectUrl, http: { sessionStatus: native.status ?? native.state, sessionRegion: native.region ?? undefined } };
  }
  const body = { ...arm.body, projectId: bbProjectId };
  if (arm.via === 'sdk-reused') {
    const { data, response } = await sdk().sessions.create(body as any).withResponse();
    return { sessionId: data.id, connectUrl: data.connectUrl, http: { status: response.status, ...pickRespMeta(response.headers), sessionStatus: data.status, sessionRegion: (data as any).region } };
  }
  // raw request: same wire request the SDK makes, no SDK, with socket phases.
  const r = await rawBbRequest('POST', '/v1/sessions', body, arm.via === 'raw-keepalive');
  if (r.status >= 300) throw new Error(`browserbase create ${r.status}: ${scrub(r.text).slice(0, 120)}`);
  const data = JSON.parse(r.text);
  return { sessionId: data.id, connectUrl: data.connectUrl, http: { status: r.status, ...pickRespMeta(r.headers), sessionStatus: data.status, sessionRegion: data.region, phases: r.phases } };
}

const keepAliveAgent = new https.Agent({ keepAlive: true, maxSockets: 1 });
const freshAgent = new https.Agent({ keepAlive: false });
/** One HTTPS request to api.browserbase.com with per-phase timings (dns/tcp/tls only when a new socket is opened). */
function rawBbRequest(method: string, pathName: string, body: unknown, keepAlive: boolean): Promise<{ status: number; headers: { get(k: string): string | null; has(k: string): boolean }; text: string; phases: Record<string, number> }> {
  return new Promise((resolve, reject) => {
    const t0 = now(); const phases: Record<string, number> = {}; let reused = true;
    const payload = JSON.stringify(body);
    const req = https.request({ host: 'api.browserbase.com', path: pathName, method, agent: keepAlive ? keepAliveAgent : freshAgent,
      headers: { 'X-BB-API-Key': bbApiKey, 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), accept: 'application/json' } }, (res) => {
      phases.ttfbMs = r1(now() - t0);
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        phases.totalMs = r1(now() - t0); phases.reusedSocket = reused ? 1 : 0;
        const h = res.headers;
        resolve({ status: res.statusCode ?? 0, headers: { get: (k) => { const v = h[k.toLowerCase()]; return Array.isArray(v) ? v.join(',') : v ?? null; }, has: (k) => h[k.toLowerCase()] !== undefined }, text: Buffer.concat(chunks).toString('utf8'), phases });
      });
    });
    req.on('socket', (sock) => {
      if (sock.connecting) {
        reused = false;
        sock.once('lookup', () => { phases.dnsMs = r1(now() - t0); });
        sock.once('connect', () => { phases.tcpMs = r1(now() - t0); });
        sock.once('secureConnect', () => { phases.tlsMs = r1(now() - t0); });
      }
    });
    req.setTimeout(60_000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(payload);
  });
}

function pickRespMeta(h: { get(k: string): string | null; has(k: string): boolean }) {
  return { serverTiming: h.get('server-timing') ?? undefined, cfRay: h.has('cf-ray'), via: h.get('via') ?? undefined, server: h.get('server') ?? undefined };
}

async function bbRetrieveStatus(sessionId: string): Promise<string> {
  const s = await sdk().sessions.retrieve(sessionId);
  return s.status;
}

async function releaseSession(arm: Arm, sessionId: string, browser: Browser | undefined, rec: SessionRec): Promise<number> {
  const info: NonNullable<SessionRec['release']> = { mode: arm.release };
  rec.release = info;
  const doClose = async () => { if (!browser) return; const t = now(); await browser.close().catch(() => undefined); info.closeMs = r1(now() - t); };
  const doRest = async () => {
    const t = now();
    if (arm.via === 'adapter') await adapterFor(arm).session.destroy(sessionId);
    else if (arm.via === 'sdk-reused') await sdk().sessions.update(sessionId, { status: 'REQUEST_RELEASE', projectId: bbProjectId });
    else {
      const r = await rawBbRequest('POST', `/v1/sessions/${encodeURIComponent(sessionId)}`, { status: 'REQUEST_RELEASE', projectId: bbProjectId }, arm.via === 'raw-keepalive');
      info.restPhases = r.phases;
      if (r.status >= 300) throw new Error(`browserbase release ${r.status}`);
    }
    info.restMs = r1(now() - t);
  };
  const doPoll = async () => {
    if (arm.provider !== 'browserbase') return;
    const t = now(); let polls = 0; let status = 'RUNNING';
    while (now() - t < 20_000) {
      polls++;
      status = await bbRetrieveStatus(sessionId).catch(() => 'ERR');
      if (status !== 'RUNNING' && status !== 'ERR') break;
      await sleep(250);
    }
    info.pollMs = r1(now() - t); info.polls = polls; info.finalStatus = status;
  };
  // The bench closes the browser (untimed) and then times destroy() alone.
  if (arm.release === 'release-only') { const t = now(); await doRest(); return r1(now() - t); }
  await doClose();
  if (arm.release === 'close-only') { await doPoll(); return 0; }
  const t = now();
  await doRest();
  const releaseMs = r1(now() - t);
  if (arm.release === 'close+release+poll') await doPoll();
  return releaseMs;
}

// ─── The bench's action loop, verbatim semantics ─────────────────────────────

function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([p, new Promise<T>((_, rej) => { timer = setTimeout(() => rej(new Error(msg)), ms); })]).finally(() => clearTimeout(timer));
}
async function timeAction<T>(fn: () => Promise<T>) {
  const start = now();
  try { const value = await withTimeout(fn(), ACTION_TIMEOUT_MS, 'Action timed out'); return { durationMs: now() - start, success: true, value }; }
  catch (err) { return { durationMs: now() - start, success: false, error: errMsg(err), value: undefined as T | undefined }; }
}
const isArticleLink = (href: string | null) => { const m = href?.match(/\/wiki\/([^#]*)/); return !!m && !m[1].includes(':'); };

/** Wikimedia's x-cache lists every cache layer ("cp1104 miss, cp1106 hit/3"); any hit anywhere means the edge served it. */
function cacheState(h?: Record<string, string>): 'hit' | 'miss' | 'unknown' {
  const xc = h?.['x-cache-status'] ?? h?.['x-cache'];
  if (!xc) return 'unknown';
  return /hit/i.test(xc) ? 'hit' : /miss|pass/i.test(xc) ? 'miss' : 'unknown';
}
const NAV_HEADER_KEYS = ['server', 'x-cache', 'x-cache-status', 'x-client-ip', 'age', 'x-varnish', 'content-encoding', 'cache-control', 'date', 'server-timing', 'retry-after'];
async function navMeta(resp: Response | null | undefined) {
  if (!resp) return {};
  const all = await resp.allHeaders().catch(() => ({} as Record<string, string>));
  const headers: Record<string, string> = {};
  for (const k of NAV_HEADER_KEYS) if (all[k] !== undefined) headers[k] = all[k];
  return { status: resp.status(), headers };
}
// A string expression, not a function: tsx/esbuild wraps nested arrows in a
// __name() helper that does not exist inside the page, so function-valued
// evaluate() args with inner closures throw there.
const NAV_TIMING_EXPR = `(() => {
  const e = performance.getEntriesByType('navigation')[0];
  if (!e) return undefined;
  const r = (n) => Math.round(n * 10) / 10;
  return {
    redirect: r(e.redirectEnd - e.redirectStart), dns: r(e.domainLookupEnd - e.domainLookupStart),
    connect: r(e.connectEnd - e.connectStart), tls: r(e.secureConnectionStart ? e.connectEnd - e.secureConnectionStart : 0),
    ttfb: r(e.responseStart - e.requestStart), response: r(e.responseEnd - e.responseStart),
    domInteractive: r(e.domInteractive), domContentLoaded: r(e.domContentLoadedEventEnd), loadEvent: r(e.loadEventEnd), duration: r(e.duration),
    transferSize: e.transferSize, protocol: e.nextHopProtocol, type: e.type,
  };
})()`;
async function readNavTiming(page: Page): Promise<NavTiming | undefined> {
  return page.evaluate(NAV_TIMING_EXPR).catch(() => undefined) as Promise<NavTiming | undefined>;
}

async function runActionLoop(page: Page, rec: SessionRec, url: string) {
  const actions = rec.actions;
  const push = (index: number, type: string, r: { durationMs: number; success: boolean; error?: string }) =>
    actions.push({ index, type, durationMs: r1(r.durationMs), success: r.success, ...(r.error ? { error: r.error } : {}) });
  const skip = (from: number, reason: string) => { for (let i = from; i <= 10; i++) actions.push({ index: i, type: 'skipped', durationMs: 0, success: false, error: reason }); };

  const nav = await timeAction(() => page.goto(url, { waitUntil: 'load' }));
  const status = nav.value?.status?.() ?? null;
  const blocked = !nav.success || (status !== null && status >= 400);
  push(1, 'navigate', { ...nav, success: nav.success && !blocked, error: blocked && nav.success ? `HTTP ${status}` : nav.error });
  // Diagnostics, outside any timed action.
  const meta = await navMeta(nav.value ?? null);
  rec.navStatus = meta.status; rec.navHeaders = meta.headers;
  rec.egressIp = meta.headers?.['x-client-ip'];
  rec.navCache = cacheState(meta.headers);
  rec.navPop = meta.headers?.['x-cache']?.match(/cp\d+/g)?.pop();
  rec.navTiming = await readNavTiming(page);
  if (blocked) { skip(2, 'navigate blocked'); return; }

  push(2, 'waitForSelector', await timeAction(() => page.waitForSelector(FIRST_HEADING)));
  push(3, 'screenshot', await timeAction(() => page.screenshot()));
  push(4, 'textContent', await timeAction(() => page.textContent(FIRST_HEADING)));
  const click = await timeAction(async () => {
    await page.waitForSelector(ARTICLE_LINK_SELECTOR, { timeout: 10_000 });
    for (const link of await page.$$(ARTICLE_LINK_SELECTOR)) {
      if (isArticleLink(await link.getAttribute('href'))) { await link.click(); return; }
    }
    throw new Error('No article body link found on page');
  });
  push(5, 'click', click);
  if (!click.success) { skip(6, 'click failed'); return; }
  push(6, 'waitForSelector', await timeAction(() => page.waitForSelector(FIRST_HEADING)));
  push(7, 'screenshot', await timeAction(() => page.screenshot()));
  push(8, 'textContent', await timeAction(() => page.textContent(FIRST_HEADING)));
  push(9, 'goBack', await timeAction(() => page.goBack({ waitUntil: 'commit' })));
  push(10, 'waitForSelector', await timeAction(() => page.waitForSelector(FIRST_HEADING)));
}

// ─── Post-loop diagnostics (untimed) ─────────────────────────────────────────

async function postLoop(page: Page, rec: SessionRec, secondUrl: string) {
  try {
    const fp = await page.evaluate(() => navigator.userAgent);
    rec.userAgent = fp; rec.chromeVersion = fp.match(/Chrome\/([\d.]+)/)?.[1];
  } catch { /* ignore */ }
  // in-page fetch to the same article: pure TTFB from the browser's egress (no render)
  try {
    rec.inPageFetch = await page.evaluate(`(async () => {
      const t0 = performance.now();
      const r = await fetch(${JSON.stringify(rec.url)}, { cache: 'no-store', credentials: 'omit' });
      const ttfb = performance.now() - t0;
      await r.text();
      return { ttfbMs: Math.round(ttfb * 10) / 10, totalMs: Math.round((performance.now() - t0) * 10) / 10, status: r.status, xCache: r.headers.get('x-cache') || undefined };
    })()`) as SessionRec['inPageFetch'];
  } catch (e) { rec.inPageFetch = { ttfbMs: -1, totalMs: -1, error: errMsg(e) }; }
  // second navigate to a different article: is the first goto paying a cold-profile cost?
  const t = now();
  try {
    const resp = await page.goto(secondUrl, { waitUntil: 'load', timeout: ACTION_TIMEOUT_MS });
    const meta = await navMeta(resp);
    rec.secondNav = { durationMs: r1(now() - t), status: meta.status, headers: meta.headers, timing: await readNavTiming(page) };
  } catch (e) { rec.secondNav = { durationMs: r1(now() - t), error: errMsg(e) }; }
}

async function rawWsProbe(connectUrl: string): Promise<{ info: NonNullable<SessionRec['rawWs']>; ws?: WebSocket }> {
  // The socket is handed back open: Browserbase ends a non-keepAlive session
  // as soon as its last CDP client disconnects (observed: connectOverCDP after
  // closing the probe socket → "410 Gone - session not running").
  const t0 = now();
  let ws: WebSocket | undefined;
  try {
    ws = new WebSocket(connectUrl);
    const sock = ws;
    await new Promise<void>((res, rej) => { sock.onopen = () => res(); sock.onerror = () => rej(new Error('ws error')); setTimeout(() => rej(new Error('ws open timeout')), 15_000); });
    const openMs = r1(now() - t0);
    const t1 = now();
    const product = await new Promise<string | undefined>((res, rej) => {
      sock.onmessage = (ev) => { try { const m = JSON.parse(String(ev.data)); if (m.id === 1) res(m.result?.product); } catch { /* ignore */ } };
      sock.send(JSON.stringify({ id: 1, method: 'Browser.getVersion' }));
      setTimeout(() => rej(new Error('getVersion timeout')), 15_000);
    });
    return { info: { openMs, getVersionMs: r1(now() - t1), product }, ws };
  } catch (e) { return { info: { openMs: r1(now() - t0), getVersionMs: -1, error: errMsg(e) }, ws }; }
}

// ─── One session ─────────────────────────────────────────────────────────────

async function runSession(arm: Arm, round: number, orderInRound = 0): Promise<void> {
  const url = urlFor(round);
  const rec: SessionRec = { arm: arm.name, round, orderInRound, ts: new Date().toISOString(), url, actions: [] };
  sessions.push(rec);
  const totalStart = now();
  let browser: Browser | undefined; let created: Created | undefined;
  try {
    const t0 = now();
    created = await withTimeout(createSession(arm, rec), 120_000, 'Session creation timed out');
    rec.createMs = r1(now() - t0);
    rec.createHttp = created.http;
    rec.connectHost = safeHost(created.connectUrl);
    rememberProbeHost(arm.provider === 'browserbase' ? 'browserbase-connect' : 'tilion-connect', created.connectUrl);

    let probeWs: WebSocket | undefined;
    if (arm.connect === 'rawws-then-playwright') { const r = await rawWsProbe(created.connectUrl); rec.rawWs = r.info; probeWs = r.ws; }

    const t1 = now();
    browser = await withTimeout(chromium.connectOverCDP(created.connectUrl), 30_000, 'CDP connection timed out');
    const [context] = browser.contexts();
    if (!context) throw new Error('No default browser context found');
    const page = context.pages()[0] ?? (await context.newPage());
    rec.connectMs = r1(now() - t1);
    probeWs?.close();

    await runActionLoop(page, rec, url);
    rec.taskMs = r1(rec.actions.reduce((s, a) => s + a.durationMs, 0));
    rec.actionsCompleted = rec.actions.filter((a) => a.success).length;
    rec.actionsPerSecond = rec.taskMs > 0 ? r1(rec.actionsCompleted / (rec.taskMs / 1000) * 10) / 10 : 0;
    const shots = rec.actions.filter((a) => a.type === 'screenshot' && a.success).map((a) => a.durationMs).sort((a, b) => a - b);
    if (shots.length) rec.screenshotMs = shots.length % 2 ? shots[(shots.length - 1) / 2] : (shots[shots.length / 2 - 1] + shots[shots.length / 2]) / 2;

    await postLoop(page, rec, urlFor(round + SESSIONS));
  } catch (e) {
    rec.error = errMsg(e);
  } finally {
    if (created) {
      try { rec.releaseMs = await withTimeout(releaseSession(arm, created.sessionId, browser, rec), 30_000, 'release timed out'); }
      catch (e) { rec.release = { ...(rec.release ?? { mode: arm.release }) }; rec.error = (rec.error ? rec.error + '; ' : '') + `release: ${errMsg(e)}`; }
    } else if (browser) {
      await browser.close().catch(() => undefined);
    }
  }
  rec.totalMs = r1(now() - totalStart);
  log(`r${round} ${arm.name.padEnd(24)} create=${rec.createMs} connect=${rec.connectMs} nav=${rec.actions[0]?.durationMs} click=${rec.actions[4]?.durationMs} task=${rec.taskMs} release=${rec.releaseMs} total=${rec.totalMs} ip=${rec.egressIp ?? '?'} cache=${rec.navCache ?? '?'}@${rec.navPop ?? '?'}${rec.error ? ' ERROR ' + rec.error : ''}`);
}

// ─── Summary ─────────────────────────────────────────────────────────────────

function median(xs: number[]) { const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b); if (!s.length) return undefined; const m = Math.floor(s.length / 2); return r1(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2); }
function p95(xs: number[]) { const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b); if (!s.length) return undefined; return r1(s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)]); }
function stats(xs: number[]) { return { n: xs.filter((x) => Number.isFinite(x)).length, median: median(xs), p95: p95(xs) }; }

function summarize() {
  const byArm: Record<string, unknown> = {};
  for (const arm of ARMS) {
    const all = sessions.filter((s) => s.arm === arm);
    const ok = all.filter((s) => !s.error && s.actionsCompleted === 10);
    const act = (type: string, idx?: number) => ok.flatMap((s) => s.actions.filter((a) => a.type === type && a.success && (idx === undefined || a.index === idx)).map((a) => a.durationMs));
    const nt = (k: keyof NavTiming) => ok.map((s) => (s.navTiming?.[k] as number) ?? NaN);
    const count = (xs: (string | undefined)[]) => { const m: Record<string, number> = {}; for (const x of xs) m[x ?? 'unknown'] = (m[x ?? 'unknown'] ?? 0) + 1; return m; };
    byArm[arm] = {
      note: ARM_BY_NAME.get(arm)?.note, sessions: all.length, fullSuccess: ok.length, errors: all.filter((s) => s.error).map((s) => s.error).slice(0, 5),
      createMs: stats(ok.map((s) => s.createMs!)), connectMs: stats(ok.map((s) => s.connectMs!)), releaseMs: stats(ok.map((s) => s.releaseMs!)),
      taskMs: stats(ok.map((s) => s.taskMs!)), totalMs: stats(ok.map((s) => s.totalMs!)), actionsPerSecond: stats(ok.map((s) => s.actionsPerSecond!)), screenshotMs: stats(ok.map((s) => s.screenshotMs!)),
      navigateByCache: { hit: stats(ok.filter((s) => s.navCache === 'hit').map((s) => s.actions[0]?.durationMs ?? NaN)), miss: stats(ok.filter((s) => s.navCache === 'miss').map((s) => s.actions[0]?.durationMs ?? NaN)) },
      ttfbByCache: { hit: stats(ok.filter((s) => s.navCache === 'hit').map((s) => s.navTiming?.ttfb ?? NaN)), miss: stats(ok.filter((s) => s.navCache === 'miss').map((s) => s.navTiming?.ttfb ?? NaN)) },
      navCache: count(ok.map((s) => s.navCache)),
      actions: { navigate: stats(act('navigate')), waitForSelector2: stats(act('waitForSelector', 2)), screenshot: stats(act('screenshot')), textContent: stats(act('textContent')), click: stats(act('click')), waitForSelector6: stats(act('waitForSelector', 6)), goBack: stats(act('goBack')), waitForSelector10: stats(act('waitForSelector', 10)) },
      navTiming: { dns: stats(nt('dns')), connect: stats(nt('connect')), tls: stats(nt('tls')), ttfb: stats(nt('ttfb')), response: stats(nt('response')), domContentLoaded: stats(nt('domContentLoaded')), loadEvent: stats(nt('loadEvent')), protocol: count(ok.map((s) => s.navTiming?.protocol)) },
      secondNavMs: stats(ok.map((s) => s.secondNav?.durationMs ?? NaN)), secondNavTtfb: stats(ok.map((s) => s.secondNav?.timing?.ttfb ?? NaN)),
      inPageFetchTtfbMs: stats(ok.map((s) => s.inPageFetch?.ttfbMs ?? NaN)),
      rawWs: { openMs: stats(ok.map((s) => s.rawWs?.openMs ?? NaN)), getVersionMs: stats(ok.map((s) => s.rawWs?.getVersionMs ?? NaN)) },
      release: { closeMs: stats(ok.map((s) => s.release?.closeMs ?? NaN)), restMs: stats(ok.map((s) => s.release?.restMs ?? NaN)), pollMs: stats(ok.map((s) => s.release?.pollMs ?? NaN)), finalStatus: count(ok.map((s) => s.release?.finalStatus)) },
      createRawPhases: { dnsMs: stats(ok.map((s) => s.createHttp?.phases?.dnsMs ?? NaN)), tcpMs: stats(ok.map((s) => s.createHttp?.phases?.tcpMs ?? NaN)), tlsMs: stats(ok.map((s) => s.createHttp?.phases?.tlsMs ?? NaN)), ttfbMs: stats(ok.map((s) => s.createHttp?.phases?.ttfbMs ?? NaN)), totalMs: stats(ok.map((s) => s.createHttp?.phases?.totalMs ?? NaN)), reused: count(ok.map((s) => s.createHttp?.phases ? String(s.createHttp.phases.reusedSocket) : undefined)) },
      releaseRawPhases: { tcpMs: stats(ok.map((s) => s.release?.restPhases?.tcpMs ?? NaN)), tlsMs: stats(ok.map((s) => s.release?.restPhases?.tlsMs ?? NaN)), ttfbMs: stats(ok.map((s) => s.release?.restPhases?.ttfbMs ?? NaN)), reused: count(ok.map((s) => s.release?.restPhases ? String(s.release.restPhases.reusedSocket) : undefined)) },
      xCachePop: count(ok.map((s) => s.navPop)),
      xCacheHit: count(ok.map((s) => s.navHeaders?.['x-cache-status'])),
      egressIps: count(ok.map((s) => s.egressIp)), chromeVersions: count(ok.map((s) => s.chromeVersion)), connectHosts: count(ok.map((s) => s.connectHost)), sessionRegions: count(ok.map((s) => s.createHttp?.sessionRegion)),
    };
  }
  const probeSummary: Record<string, unknown> = {};
  for (const label of new Set(probes.map((p) => p.label))) {
    const ps = probes.filter((p) => p.label === label && !p.error);
    probeSummary[label] = { host: ps[0]?.host, ip: ps[0]?.ip, n: ps.length, dnsMs: median(ps.map((p) => p.dnsMs)), tcpMs: median(ps.map((p) => p.tcpMs)), tlsMs: median(ps.map((p) => p.tlsMs)), httpMs: median(ps.map((p) => p.httpMs)), status: ps[0]?.status, errors: probes.filter((p) => p.label === label && p.error).length };
  }
  return { byArm, probes: probeSummary, sdkInitMs };
}

async function ipInfo(ip: string | undefined) {
  if (!ip) return undefined;
  try { const j = await (await fetch(`https://ipinfo.io/${ip}/json`, { signal: AbortSignal.timeout(10_000) })).json() as Record<string, unknown>; return { ip, org: j.org, city: j.city, region: j.region, country: j.country, hostname: j.hostname }; }
  catch (e) { return { ip, error: errMsg(e) }; }
}

async function main() {
  log(`experiment browserbase-speed leg=${LEG} runner=${RUNNER} arms=${ARMS.join(',')} sessions=${SESSIONS} spacing=${SPACING_MS}ms urls=${navUrls.length}`);
  const unknown = ARMS.filter((a) => !ARM_BY_NAME.has(a));
  if (unknown.length) { console.error(`unknown arms: ${unknown.join(',')}`); process.exit(2); }
  const needBb = ARMS.some((a) => ARM_BY_NAME.get(a)!.provider === 'browserbase');
  const needTilion = ARMS.some((a) => ARM_BY_NAME.get(a)!.provider === 'tilion');
  if (needBb && (!bbApiKey || !bbProjectId)) { console.error('BROWSERBASE_API_KEY / BROWSERBASE_PROJECT_ID not set'); process.exit(2); }
  if (needTilion && !process.env.TILION_API_KEY) { console.error('TILION_API_KEY not set'); process.exit(2); }

  let runnerIp: string | undefined;
  try { runnerIp = ((await (await fetch('https://api.ipify.org?format=json')).json()) as { ip: string }).ip; } catch { /* ignore */ }
  const runner = { label: RUNNER, ...(await ipInfo(runnerIp)) };
  log(`runner ${RUNNER}`, runner);

  rememberProbeHost('tilion-api', tilionBaseUrl);
  await runProbes();
  const arms = ARMS.map((a) => ARM_BY_NAME.get(a)!);
  for (let round = 0; round < SESSIONS; round++) {
    // Every arm in a round loads the same article, so whoever goes first pays
    // Wikipedia's cache miss. Rotate the order so that cost lands on every arm
    // equally and can be split out by x-cache afterwards.
    for (let k = 0; k < arms.length; k++) {
      await runSession(arms[(k + round) % arms.length], round, k);
      const last = round === SESSIONS - 1 && k === arms.length - 1;
      if (!last) await sleep(SPACING_MS);
    }
    if ((round + 1) % PROBE_EVERY === 0) await runProbes();
  }
  await runProbes();

  const ips = [...new Set(sessions.map((s) => s.egressIp).filter((x): x is string => !!x))];
  const egress: Record<string, unknown> = {};
  for (const ip of ips) { egress[ip] = await ipInfo(ip); await sleep(250); }

  const summary = summarize();
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const out = path.join(OUT_DIR, `${LEG}.json`);
  const doc = { experiment: 'browserbase-speed', leg: LEG, runner, startedAt: STARTED_AT, finishedAt: new Date().toISOString(),
    config: { arms: ARMS, armDefs: arms.map(({ name, provider, via, release, connect, note, body, options }) => ({ name, provider, via, release, connect, note, body, options })), sessions: SESSIONS, spacingMs: SPACING_MS, urls: navUrls },
    summary, egress, probes, sessions };
  const text = JSON.stringify(doc, null, 2);
  // Last-line defence: refuse to write anything that looks like a credential.
  const leak = [bbApiKey, bbProjectId, process.env.TILION_API_KEY ?? ''].filter((s) => s.length >= 8).find((s) => text.includes(s));
  if (leak || /wss?:\/\//.test(text)) { console.error('refusing to write artifact: credential-looking content detected'); process.exit(3); }
  fs.writeFileSync(out, text);
  log(`wrote ${out}`);
  console.log('\n=== SUMMARY ===');
  console.log(JSON.stringify({ runner, summary }, null, 1));
}

main().catch((err) => { console.error(errMsg(err)); process.exit(1); });
