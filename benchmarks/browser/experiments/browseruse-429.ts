/**
 * EXPERIMENT — not a benchmark. Does not report to the platform.
 *
 * Why Browser Use sessions get HTTP 429 from Wikipedia in the public
 * browser-throughput benchmark, and which provider-side fix clears it.
 *
 * Modes (EXPERIMENT_MODE):
 *   baseline   N Browser Use sessions with bench-identical create params
 *              (proxies: false → proxyCountryCode null, 1920×1080), one
 *              Wikipedia navigate each, 15s apart. Records status, response
 *              headers, 429 body text, the session's egress IP (api.ipify.org
 *              fetched from inside the session), navigator.userAgent and the
 *              request headers Chromium actually sent.
 *   rate       Same session: navigate, wait 60s, navigate, navigate again at
 *              once — does the 429 flip within one egress IP?
 *   headers    baseline + a UA / Accept-Language override via CDP before
 *              navigating (EXPERIMENT_UA). No egress change.
 *   proxy-us   baseline + proxies: [{type:'residential', geolocation:{country:'us'}}]
 *              → Browser Use's own proxyCountryCode 'us' pool.
 *   control    No Browser Use. Plain Node fetch (Chrome-like UA and a
 *              descriptive bot UA) and, when a Chromium is installed,
 *              Playwright Chromium from the runner itself against the same URLs.
 *
 * Output: EXPERIMENT_OUT/<label>.json + <label>-navs.csv. Metrics only — no
 * API keys, connect URLs, or proxy credentials are ever written or logged.
 *
 *   EXPERIMENT_MODE=baseline EXPERIMENT_SESSIONS=30 THROUGHPUT_URLS='...' \
 *     npx tsx benchmarks/browser/experiments/browseruse-429.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { browseruse } from '@computesdk/browseruse';
import { chromium, type Browser, type Page, type Response } from 'playwright-core';

type Mode = 'baseline' | 'rate' | 'headers' | 'proxy-us' | 'control';

const MODE = (process.env.EXPERIMENT_MODE ?? 'baseline') as Mode;
const LABEL = process.env.EXPERIMENT_LABEL ?? MODE;
const SESSIONS = Number(process.env.EXPERIMENT_SESSIONS ?? (MODE === 'rate' ? 8 : 30));
const SPACING_MS = Number(process.env.EXPERIMENT_SPACING_MS ?? 15_000);
const RATE_PAUSE_MS = Number(process.env.EXPERIMENT_RATE_PAUSE_MS ?? 60_000);
const OUT_DIR = process.env.EXPERIMENT_OUT ?? path.resolve('results/experiments/browseruse-429');
const RUNNER = process.env.EXPERIMENT_RUNNER ?? 'unknown';
const UA_PRESET = process.env.EXPERIMENT_UA_PRESET ?? 'bot';
/**
 * headers-mode tweak: which client-side change to apply before navigating.
 *   ua+al     CDP Network.setUserAgentOverride + Accept-Language extra header (default)
 *   ua        CDP Network.setUserAgentOverride only
 *   al        page.setExtraHTTPHeaders({ Accept-Language }) only
 *   xhdr      page.setExtraHTTPHeaders({ X-ComputeSDK-Bench: '1' }) only — any extra header
 *   cdp-noop  attach a CDP session and send Network.enable only — no header change
 */
const TWEAK = process.env.EXPERIMENT_TWEAK ?? 'ua+al';
/** headers mode: also record the ordered wire headers of Wikipedia document requests via CDP. */
const WIRE = process.env.EXPERIMENT_WIRE === '1';
/** Browser Use modes: also fetch https://tls.peet.ws/api/all from inside the session (TLS JA3/JA4 + HTTP/2 fingerprint + ordered headers as the server saw them). */
const PROBE = process.env.EXPERIMENT_PROBE === '1';
const UA_OVERRIDE = process.env.EXPERIMENT_UA ?? '';
const NAV_TIMEOUT_MS = 30_000;
const VIEWPORT = { width: 1920, height: 1080 };

// Same shape the bench sends (benchmarks/browser/throughput-providers.ts).
const BENCH_SESSION_OPTIONS = { stealth: false, proxies: false as const, headless: true, viewport: VIEWPORT };

const CHROME_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const BOT_UA =
  'ComputeSDKBenchmarkBot/1.0 (https://github.com/computesdk/benchmarks; garrison@computesdk.com) playwright-core/1.64';

/** UA used by the headers mode: explicit EXPERIMENT_UA, else preset 'bot' | 'chrome'. */
const HEADERS_UA = UA_OVERRIDE || (UA_PRESET === 'chrome' ? CHROME_UA : BOT_UA);

const HEADER_KEYS = [
  'server', 'x-cache', 'x-cache-status', 'x-client-ip', 'retry-after', 'x-request-id',
  'content-type', 'content-length', 'age', 'via', 'x-varnish', 'cf-ray', 'cf-cache-status',
  'x-analytics', 'server-timing', 'date', 'set-cookie', 'cache-control', 'vary',
];

interface NavRecord {
  ts: string;
  label: string;
  session: number;
  sessionId?: string;
  phase: string;
  client: string;
  url: string;
  status: number | null;
  ok: boolean;
  durationMs: number;
  error?: string;
  egressIp?: string;
  headers: Record<string, string>;
  requestHeaders?: Record<string, string>;
  title?: string;
  bodySnippet?: string;
  /** Ordered request headers as sent (CDP Network.requestWillBeSentExtraInfo), headers mode + EXPERIMENT_WIRE=1 only. */
  wireHeaders?: Array<[string, string]>;
}

interface SessionRecord {
  session: number;
  sessionId?: string;
  createMs?: number;
  connectMs?: number;
  egressIp?: string;
  egressIpError?: string;
  userAgent?: string;
  webdriver?: boolean | null;
  languages?: string[];
  uaBrands?: unknown;
  error?: string;
  /** tls.peet.ws view of the session's egress: TLS/HTTP2 fingerprints and the header list the server received. */
  probe?: Record<string, unknown>;
  navs: NavRecord[];
}

const navUrls = parseNavUrls();
const sessions: SessionRecord[] = [];
const allNavs: NavRecord[] = [];

function parseNavUrls(): string[] {
  const raw = process.env.THROUGHPUT_URLS?.trim();
  if (!raw) return [];
  if (raw.startsWith('[')) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.filter((u): u is string => typeof u === 'string' && u.length > 0);
    } catch { /* fall through */ }
  }
  return raw.split(/\s+/).filter((u) => u.length > 0);
}

function urlFor(i: number): string {
  if (navUrls.length > 0) return navUrls[i % navUrls.length];
  return 'https://en.wikipedia.org/wiki/Special:Random';
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function pickHeaders(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of HEADER_KEYS) if (h[k] !== undefined) out[k] = h[k];
  return out;
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function log(msg: string, extra?: Record<string, unknown>) {
  console.log(`[${new Date().toISOString()}] ${msg}${extra ? ' ' + JSON.stringify(extra) : ''}`);
}

// ─── Browser Use session helpers ─────────────────────────────────────────────

async function readEgress(page: Page, rec: SessionRecord): Promise<void> {
  for (const probe of ['https://api.ipify.org?format=json', 'https://ifconfig.me/ip']) {
    try {
      await page.goto(probe, { waitUntil: 'load', timeout: 15_000 });
      const text = (await page.textContent('body'))?.trim() ?? '';
      const ip = text.startsWith('{') ? JSON.parse(text).ip : text;
      if (ip && /^[0-9a-f.:]+$/i.test(ip)) {
        rec.egressIp = ip;
        return;
      }
      rec.egressIpError = `unexpected body from ${probe}: ${text.slice(0, 80)}`;
    } catch (err) {
      rec.egressIpError = `${probe}: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`;
    }
  }
}

async function readProbe(page: Page, rec: SessionRecord): Promise<void> {
  if (!PROBE) return;
  try {
    await page.goto('https://tls.peet.ws/api/all', { waitUntil: 'load', timeout: 20_000 });
    const text = (await page.textContent('body'))?.trim() ?? '';
    const j = JSON.parse(text);
    const headersFrame = (j.http2?.sent_frames ?? []).find((f: any) => f.frame_type === 'HEADERS');
    rec.probe = {
      ip: j.ip, httpVersion: j.http_version, userAgent: j.user_agent,
      ja3: j.tls?.ja3, ja3Hash: j.tls?.ja3_hash, ja4: j.tls?.ja4, peetprintHash: j.tls?.peetprint_hash,
      tlsVersion: j.tls?.tls_version_negotiated,
      akamaiH2: j.http2?.akamai_fingerprint, akamaiH2Hash: j.http2?.akamai_fingerprint_hash,
      h2Settings: (j.http2?.sent_frames ?? []).filter((f: any) => f.frame_type !== 'HEADERS'),
      headerOrder: headersFrame?.headers ?? j.http1?.headers ?? null,
    };
  } catch (err) {
    rec.probe = { error: err instanceof Error ? err.message.split('\n')[0] : String(err) };
  }
}

async function readFingerprint(page: Page, rec: SessionRecord): Promise<void> {
  try {
    const fp = await page.evaluate(() => ({
      userAgent: navigator.userAgent,
      webdriver: (navigator as any).webdriver ?? null,
      languages: Array.from(navigator.languages ?? []),
      uaBrands: (navigator as any).userAgentData?.brands ?? null,
    }));
    Object.assign(rec, fp);
  } catch (err) {
    rec.error = `fingerprint: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function navigate(page: Page, rec: SessionRecord, phase: string, url: string, client: string): Promise<NavRecord> {
  const nav: NavRecord = {
    ts: new Date().toISOString(), label: LABEL, session: rec.session, sessionId: rec.sessionId, phase, client,
    url, status: null, ok: false, durationMs: 0, egressIp: rec.egressIp, headers: {},
  };
  const start = performance.now();
  let resp: Response | null = null;
  try {
    resp = await page.goto(url, { waitUntil: 'load', timeout: NAV_TIMEOUT_MS });
    nav.durationMs = Math.round(performance.now() - start);
    if (!resp) {
      nav.error = 'no response object';
    } else {
      nav.status = resp.status();
      nav.ok = nav.status < 400;
      nav.headers = pickHeaders(await resp.allHeaders());
      nav.requestHeaders = await resp.request().allHeaders();
      const wire = wireCapture.get(url) ?? wireCapture.get(resp.url());
      if (wire) nav.wireHeaders = wire;
      nav.title = (await page.title().catch(() => '')).slice(0, 120);
      if (!nav.ok) {
        const html = await resp.text().catch(() => page.content().catch(() => ''));
        nav.bodySnippet = stripHtml(html).slice(0, 1500);
      }
    }
  } catch (err) {
    nav.durationMs = Math.round(performance.now() - start);
    nav.error = err instanceof Error ? err.message.split('\n')[0] : String(err);
  }
  log(`nav s${rec.session} ${phase} → ${nav.status ?? 'ERR'} ${nav.durationMs}ms ip=${rec.egressIp ?? '?'} ${nav.error ?? ''}`);
  rec.navs.push(nav);
  allNavs.push(nav);
  return nav;
}

function sessionOptions(): Record<string, unknown> {
  if (MODE === 'proxy-us') {
    return { ...BENCH_SESSION_OPTIONS, proxies: [{ type: 'residential', geolocation: { country: 'us' } }] };
  }
  return { ...BENCH_SESSION_OPTIONS };
}

/** Wire headers captured per session, keyed by request URL. */
const wireCapture = new Map<string, Array<[string, string]>>();

async function applyHeaderOverride(page: Page): Promise<void> {
  if (MODE !== 'headers') return;
  if (WIRE) {
    const cdp = await page.context().newCDPSession(page);
    const urls = new Map<string, string>();
    cdp.on('Network.requestWillBeSent', (e: any) => {
      if (e.type === 'Document') urls.set(e.requestId, e.request.url);
    });
    cdp.on('Network.requestWillBeSentExtraInfo', (e: any) => {
      const url = urls.get(e.requestId);
      if (url && url.includes('wikipedia.org')) {
        wireCapture.set(url, Object.entries(e.headers as Record<string, string>).map(([k, v]) => [k, k === 'cookie' ? `<${v.length} chars>` : v]));
      }
    });
    await cdp.send('Network.enable');
  }
  if (TWEAK === 'ua+al' || TWEAK === 'ua' || TWEAK === 'cdp-noop') {
    const cdp = await page.context().newCDPSession(page);
    if (TWEAK === 'cdp-noop') {
      await cdp.send('Network.enable');
    } else {
      await cdp.send('Network.setUserAgentOverride', {
        userAgent: HEADERS_UA,
        acceptLanguage: 'en-US,en;q=0.9',
        platform: 'Linux x86_64',
      });
    }
  }
  if (TWEAK === 'ua+al' || TWEAK === 'al') {
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
  }
  if (TWEAK === 'xhdr') {
    await page.setExtraHTTPHeaders({ 'X-ComputeSDK-Bench': '1' });
  }
}

async function runBrowserUseSession(i: number): Promise<void> {
  const provider = browseruse({ apiKey: process.env.BROWSER_USE_API_KEY! });
  const rec: SessionRecord = { session: i, navs: [] };
  sessions.push(rec);
  let browser: Browser | undefined;
  let sessionId: string | undefined;
  try {
    const t0 = performance.now();
    const session = await provider.session.create(sessionOptions());
    rec.createMs = Math.round(performance.now() - t0);
    sessionId = session.sessionId;
    rec.sessionId = sessionId;
    if (!session.connectUrl) throw new Error('Browser Use session has no connectUrl');

    const t1 = performance.now();
    browser = await chromium.connectOverCDP(session.connectUrl, { timeout: 30_000 });
    const [context] = browser.contexts();
    if (!context) throw new Error('No default browser context');
    const page = context.pages()[0] ?? (await context.newPage());
    rec.connectMs = Math.round(performance.now() - t1);

    await applyHeaderOverride(page);
    await readEgress(page, rec);
    await readFingerprint(page, rec);
    await readProbe(page, rec);

    const client = MODE === 'headers' ? `browseruse+${TWEAK}:${HEADERS_UA.split(' ')[0]}` : `browseruse:${MODE}`;
    if (MODE === 'rate') {
      await navigate(page, rec, 'nav-1', urlFor(i * 3), client);
      log(`s${i} pausing ${RATE_PAUSE_MS}ms inside the same session`);
      await sleep(RATE_PAUSE_MS);
      await navigate(page, rec, `nav-2-after-${RATE_PAUSE_MS}ms`, urlFor(i * 3 + 1), client);
      await navigate(page, rec, 'nav-3-immediate', urlFor(i * 3 + 2), client);
    } else {
      await navigate(page, rec, 'nav', urlFor(i), client);
    }
  } catch (err) {
    rec.error = err instanceof Error ? err.message.split('\n')[0] : String(err);
    log(`s${i} session error: ${rec.error}`);
  } finally {
    await browser?.close().catch(() => undefined);
    if (sessionId) await provider.session.destroy(sessionId).catch(() => undefined);
  }
}

// ─── Control (runner egress, no Browser Use) ─────────────────────────────────

async function fetchControl(i: number, url: string, client: string, headers: Record<string, string>, egressIp?: string): Promise<NavRecord> {
  const nav: NavRecord = {
    ts: new Date().toISOString(), label: LABEL, session: i, phase: 'nav', client, url,
    status: null, ok: false, durationMs: 0, egressIp, headers: {}, requestHeaders: headers,
  };
  const start = performance.now();
  try {
    const res = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(NAV_TIMEOUT_MS) });
    nav.durationMs = Math.round(performance.now() - start);
    nav.status = res.status;
    nav.ok = res.status < 400;
    const h: Record<string, string> = {};
    res.headers.forEach((v, k) => { h[k] = v; });
    nav.headers = pickHeaders(h);
    const body = await res.text();
    const m = body.match(/<title>([^<]*)<\/title>/i);
    nav.title = m?.[1]?.slice(0, 120);
    if (!nav.ok) nav.bodySnippet = stripHtml(body).slice(0, 1500);
  } catch (err) {
    nav.durationMs = Math.round(performance.now() - start);
    nav.error = err instanceof Error ? err.message : String(err);
  }
  log(`control s${i} ${client} → ${nav.status ?? 'ERR'} ${nav.durationMs}ms ${nav.error ?? ''}`);
  allNavs.push(nav);
  return nav;
}

async function runControl(): Promise<void> {
  let egressIp: string | undefined;
  try {
    egressIp = (await (await fetch('https://api.ipify.org?format=json')).json() as { ip: string }).ip;
  } catch (err) {
    log(`runner egress lookup failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  log(`runner (${RUNNER}) egress ip ${egressIp ?? '?'}`);

  let localBrowser: Browser | undefined;
  try {
    localBrowser = await chromium.launch({ headless: true });
    log('runner chromium available');
  } catch (err) {
    log(`runner chromium unavailable, fetch-only control: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
  }

  const chromeHeaders = {
    'User-Agent': CHROME_UA,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
  };
  const botHeaders = { 'User-Agent': BOT_UA, 'Accept': 'text/html', 'Accept-Encoding': 'gzip' };

  for (let i = 0; i < SESSIONS; i++) {
    const rec: SessionRecord = { session: i, egressIp, navs: [] };
    sessions.push(rec);
    const url = urlFor(i);
    rec.navs.push(await fetchControl(i, url, `runner-fetch:chrome-ua`, chromeHeaders, egressIp));
    rec.navs.push(await fetchControl(i, url, `runner-fetch:bot-ua`, botHeaders, egressIp));
    if (localBrowser) {
      const context = await localBrowser.newContext({ viewport: VIEWPORT });
      const page = await context.newPage();
      if (i === 0) await readFingerprint(page, rec);
      rec.navs.push(await navigate(page, rec, 'nav', url, 'runner-chromium'));
      await context.close().catch(() => undefined);
    }
    if (i < SESSIONS - 1) await sleep(SPACING_MS);
  }
  await localBrowser?.close().catch(() => undefined);
}

// ─── ASN enrichment (from the runner, never from inside a session) ───────────

async function lookupIps(ips: string[]): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const ip of ips) {
    try {
      const res = await fetch(`https://ipinfo.io/${ip}/json`, { signal: AbortSignal.timeout(10_000) });
      const j = (await res.json()) as Record<string, unknown>;
      out[ip] = { org: j.org, hostname: j.hostname, city: j.city, region: j.region, country: j.country, anycast: j.anycast };
    } catch (err) {
      out[ip] = { error: err instanceof Error ? err.message : String(err) };
    }
    await sleep(300);
  }
  return out;
}

// ─── Summary / output ────────────────────────────────────────────────────────

function summarize(ipInfo: Record<string, unknown>) {
  const byClient: Record<string, { navs: number; ok: number; s429: number; otherFail: number; rate429: number }> = {};
  const byIp: Record<string, { sessions: Set<number>; navs: number; s429: number; ok: number }> = {};
  for (const n of allNavs) {
    const c = (byClient[n.client] ??= { navs: 0, ok: 0, s429: 0, otherFail: 0, rate429: 0 });
    c.navs++;
    if (n.status === 429) c.s429++;
    else if (n.ok) c.ok++;
    else c.otherFail++;
    const ip = n.egressIp ?? 'unknown';
    const b = (byIp[ip] ??= { sessions: new Set(), navs: 0, s429: 0, ok: 0 });
    b.sessions.add(n.session);
    b.navs++;
    if (n.status === 429) b.s429++;
    else if (n.ok) b.ok++;
  }
  for (const c of Object.values(byClient)) c.rate429 = c.navs ? +(c.s429 / c.navs).toFixed(3) : 0;
  const ipTable = Object.entries(byIp)
    .map(([ip, v]) => ({ ip, sessions: v.sessions.size, navs: v.navs, ok: v.ok, s429: v.s429, rate429: v.navs ? +(v.s429 / v.navs).toFixed(3) : 0, info: ipInfo[ip] ?? null }))
    .sort((a, b) => b.navs - a.navs);
  const sampleBody = allNavs.find((n) => n.status === 429)?.bodySnippet;
  const sample429Headers = allNavs.find((n) => n.status === 429)?.headers;
  const sample200Headers = allNavs.find((n) => n.status === 200)?.headers;
  const sampleReqHeaders = allNavs.find((n) => n.requestHeaders && n.client.startsWith('browseruse'))?.requestHeaders
    ?? allNavs.find((n) => n.requestHeaders)?.requestHeaders;
  return {
    label: LABEL, mode: MODE, runner: RUNNER, sessionsRequested: SESSIONS, spacingMs: SPACING_MS,
    sessionsRun: sessions.length, sessionErrors: sessions.filter((s) => s.error).length,
    distinctEgressIps: Object.keys(byIp).filter((k) => k !== 'unknown').length,
    byClient, ipTable, sample429Headers, sample200Headers, sampleReqHeaders, sample429Body: sampleBody,
    userAgents: [...new Set(sessions.map((s) => s.userAgent).filter(Boolean))],
    probes: PROBE ? sessions.map((s) => ({ session: s.session, status429: s.navs.some((n) => n.status === 429), ...(s.probe ?? {}) })) : undefined,
  };
}

function writeOutputs(summary: unknown) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const jsonPath = path.join(OUT_DIR, `${LABEL}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify({
    experiment: 'browseruse-429', label: LABEL, mode: MODE, runner: RUNNER, startedAt: STARTED_AT,
    finishedAt: new Date().toISOString(), config: { sessions: SESSIONS, spacingMs: SPACING_MS, ratePauseMs: RATE_PAUSE_MS, uaOverride: MODE === 'headers' ? HEADERS_UA : null, tweak: MODE === 'headers' ? TWEAK : null, sessionOptions: MODE === 'control' ? null : sessionOptions(), urls: navUrls },
    summary, sessions, navs: allNavs,
  }, null, 2));
  const csvPath = path.join(OUT_DIR, `${LABEL}-navs.csv`);
  const cols = ['ts', 'label', 'session', 'sessionId', 'phase', 'client', 'egressIp', 'url', 'status', 'durationMs', 'error', 'server', 'x-cache', 'x-client-ip', 'retry-after', 'x-request-id'];
  const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = allNavs.map((n) => cols.map((c) => esc(c in n ? (n as any)[c] : n.headers[c])).join(','));
  fs.writeFileSync(csvPath, [cols.join(','), ...rows].join('\n') + '\n');
  log(`wrote ${jsonPath} and ${csvPath}`);
}

const STARTED_AT = new Date().toISOString();

async function main() {
  log(`experiment ${LABEL} mode=${MODE} sessions=${SESSIONS} spacing=${SPACING_MS}ms runner=${RUNNER} urls=${navUrls.length}`);
  if (MODE !== 'control' && !process.env.BROWSER_USE_API_KEY) {
    console.error('BROWSER_USE_API_KEY is not set');
    process.exit(2);
  }
  if (MODE === 'control') {
    await runControl();
  } else {
    for (let i = 0; i < SESSIONS; i++) {
      await runBrowserUseSession(i);
      if (i < SESSIONS - 1) await sleep(SPACING_MS);
    }
  }
  const ips = [...new Set(allNavs.map((n) => n.egressIp).filter((x): x is string => !!x))];
  const ipInfo = await lookupIps(ips);
  const summary = summarize(ipInfo);
  writeOutputs(summary);
  console.log('\n=== SUMMARY ===');
  console.log(JSON.stringify({ ...summary, sample429Body: summary.sample429Body?.slice(0, 400) }, null, 2));
  // Artifact uploads have failed on the platform before; the compact record
  // (without per-nav body snippets) also goes to the log as a fallback.
  console.log('=== NAVS_JSON_BEGIN ===');
  console.log(JSON.stringify({ label: LABEL, mode: MODE, runner: RUNNER, sessions: sessions.map((s) => ({ ...s, navs: undefined })), navs: allNavs.map((n) => ({ ...n, bodySnippet: undefined })) }));
  console.log('=== NAVS_JSON_END ===');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
