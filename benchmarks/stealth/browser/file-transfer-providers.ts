import { unzipSync } from 'fflate';
import { browserbase } from '@computesdk/browserbase';
import { browseruse } from '@computesdk/browseruse';
import { hyperbrowser } from '@computesdk/hyperbrowser';
import { kernel } from '@computesdk/kernel';
import { notte } from '@computesdk/notte';
import { steel } from '@computesdk/steel';
import { styneBrowser } from '@computesdk/styne-browser';
import { tilion } from '@computesdk/tilion';
import type { ConcurrentProviderConfig } from './concurrent-types.js';

/**
 * File-transfer provider configurations.
 *
 * Same 8 browser providers as concurrent-providers.ts (browserbase,
 * browseruse, hyperbrowser, kernel, notte, steel, styne, tilion) with the same
 * 1920x1080 viewport. On top of that, each provider can expose hooks that let
 * the benchmark retrieve downloaded bytes when the remote browser cannot hand
 * them back through playwright:
 *
 *   fetchRemoteFile — read an absolute path from the remote browser's
 *     filesystem. Enables the `cdp` mechanism (Browser.setDownloadBehavior to
 *     a known remote dir, then read the file chromium wrote).
 *   fetchSessionDownloads — list files the provider captured as session
 *     downloads. Enables the `provider-api` mechanism (poll the provider's
 *     own downloads/files API for the file the page triggered).
 *
 * Providers with no hook (tilion) can still pass via the `playwright`
 * mechanism; if that fails the download step records a capability result of
 * unsupported rather than failing the task.
 */

export interface RetrievedFile {
  name: string;
  bytes: Buffer;
}

export interface FileTransferProviderConfig extends ConcurrentProviderConfig {
  fetchRemoteFile?: (sessionId: string, remotePath: string) => Promise<Buffer>;
  fetchSessionDownloads?: (sessionId: string) => Promise<RetrievedFile[]>;
  /** Remote dir passed to CDP Browser.setDownloadBehavior. */
  remoteDownloadDir?: string;
  /**
   * CDP download behavior applied at browserContext scope before the
   * provider-api click. Playwright overrides the context's download behavior
   * at init (allowAndName + a runner-local path), so the provider-api attempt
   * must re-point it at the dir the provider's downloads API actually scans.
   */
  downloadBehavior?: { behavior: 'allow' | 'allowAndName'; downloadPath?: string };
}

const VIEWPORT = { width: 1920, height: 1080 };
const API_TIMEOUT_MS = 30_000;

async function httpJson(url: string, headers: Record<string, string>): Promise<any> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(API_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.json();
}

async function httpBytes(url: string, headers: Record<string, string>): Promise<Buffer> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(API_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Unpack a zip archive body into {name, bytes} entries, skipping directories. */
function unzipEntries(zipBytes: Buffer): RetrievedFile[] {
  return Object.entries(unzipSync(new Uint8Array(zipBytes)))
    .filter(([name]) => !name.endsWith('/'))
    .map(([name, data]) => ({ name, bytes: Buffer.from(data) }));
}

// ── kernel: remote fs read (CDP mechanism) ──────────────────────────────────
async function kernelFetchRemoteFile(sessionId: string, remotePath: string): Promise<Buffer> {
  const url = `https://api.onkernel.com/browsers/${sessionId}/fs/read_file?path=${encodeURIComponent(remotePath)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${process.env.KERNEL_API_KEY}` },
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`kernel read_file ${remotePath} -> ${res.status}`);
  const body = Buffer.from(await res.arrayBuffer());
  // Some deployments wrap file content in JSON; unwrap the obvious shapes.
  if ((res.headers.get('content-type') ?? '').includes('json')) {
    try {
      const json = JSON.parse(body.toString('utf8'));
      const content = json?.content ?? json?.data ?? json?.contents;
      if (typeof content === 'string') return Buffer.from(content);
    } catch { /* fall through to raw body */ }
  }
  return body;
}

// ── steel: session files zip (provider-api mechanism) ───────────────────────
async function steelFetchSessionDownloads(sessionId: string): Promise<RetrievedFile[]> {
  const zip = await httpBytes(
    `https://api.steel.dev/v1/sessions/${sessionId}/files.zip`,
    { 'steel-api-key': process.env.STEEL_API_KEY! },
  );
  return unzipEntries(zip);
}

// ── browserbase: session downloads zip (provider-api mechanism) ─────────────
async function browserbaseFetchSessionDownloads(sessionId: string): Promise<RetrievedFile[]> {
  const zip = await httpBytes(
    `https://api.browserbase.com/v1/sessions/${sessionId}/downloads`,
    { 'X-BB-API-Key': process.env.BROWSERBASE_API_KEY! },
  );
  return unzipEntries(zip);
}

// ── hyperbrowser: presigned downloads zip (provider-api mechanism) ──────────
async function hyperbrowserFetchSessionDownloads(sessionId: string): Promise<RetrievedFile[]> {
  const json = await httpJson(
    `https://api.hyperbrowser.ai/api/session/${sessionId}/downloads-url`,
    { 'x-api-key': process.env.HYPERBROWSER_API_KEY! },
  );
  const url = json?.downloadsUrl;
  if (!url) return [];
  return unzipEntries(await httpBytes(url, {}));
}

// ── browseruse: per-file presigned URLs (provider-api mechanism) ────────────
async function browseruseFetchSessionDownloads(sessionId: string): Promise<RetrievedFile[]> {
  const json = await httpJson(
    `https://api.browser-use.com/api/v3/browsers/${sessionId}/downloads?includeUrls=true`,
    { 'X-Browser-Use-API-Key': process.env.BROWSER_USE_API_KEY! },
  );
  const files = (json?.files ?? []) as { fileName?: string; name?: string; url?: string }[];
  const out: RetrievedFile[] = [];
  for (const f of files) {
    if (!f.url) continue;
    try {
      out.push({ name: f.fileName ?? f.name ?? 'download', bytes: await httpBytes(f.url, {}) });
    } catch { /* skip unreadable entries */ }
  }
  return out;
}

// ── notte: session files API (provider-api mechanism) ───────────────────────
async function notteFetchSessionDownloads(sessionId: string): Promise<RetrievedFile[]> {
  // Same base URL resolution as @computesdk/notte.
  const base = (process.env.NOTTE_API_URL || 'https://api.notte.cc').replace(/\/+$/, '');
  const headers = { Authorization: `Bearer ${process.env.NOTTE_API_KEY}` };
  const json = await httpJson(`${base}/sessions/${sessionId}/files?source=session_download`, headers);
  const files = (json?.files ?? []) as { id?: string; filename?: string }[];
  const out: RetrievedFile[] = [];
  for (const f of files) {
    if (!f.id) continue;
    try {
      // Answers with a redirect to a presigned URL; fetch drops the
      // Authorization header on the cross-origin hop.
      out.push({
        name: f.filename ?? 'download',
        bytes: await httpBytes(`${base}/sessions/${sessionId}/files/${f.id}`, headers),
      });
    } catch { /* skip unreadable entries */ }
  }
  return out;
}

// ── styne: session VM files API (CDP mechanism) ─────────────────────────────
async function styneFetchRemoteFile(sessionId: string, remotePath: string): Promise<Buffer> {
  const base = (process.env.STYNE_API_URL || 'https://api.styne.ai').replace(/\/+$/, '');
  return httpBytes(`${base}/sandboxes/${encodeURIComponent(sessionId)}/files?path=${encodeURIComponent(remotePath)}`, {
    Authorization: `Bearer ${process.env.STYNE_API_KEY}`,
  });
}

export const fileTransferProviders: FileTransferProviderConfig[] = [
  {
    name: 'browserbase',
    requiredEnvVars: ['BROWSERBASE_API_KEY', 'BROWSERBASE_PROJECT_ID'],
    createBrowserProvider: () => browserbase({
      apiKey: process.env.BROWSERBASE_API_KEY!,
      projectId: process.env.BROWSERBASE_PROJECT_ID!,
    }),
    sessionCreateOptions: {
      region: 'us-west-2',
      stealth: false,
      proxies: false,
      headless: true,
      viewport: VIEWPORT,
      recordSession: false,
      enableNativeSelectPolyfill: false,
    },
    // docs.browserbase.com: 'allow' + downloadPath 'downloads' points the file
    // at the dir Browserbase syncs to cloud storage.
    downloadBehavior: { behavior: 'allow', downloadPath: 'downloads' },
    fetchSessionDownloads: browserbaseFetchSessionDownloads,
  },
  {
    name: 'browseruse',
    requiredEnvVars: ['BROWSER_USE_API_KEY'],
    createBrowserProvider: () => browseruse({
      apiKey: process.env.BROWSER_USE_API_KEY!,
    }),
    sessionCreateOptions: {
      stealth: false,
      proxies: false,
      headless: true,
      viewport: VIEWPORT,
    },
    fetchSessionDownloads: browseruseFetchSessionDownloads,
  },
  {
    name: 'hyperbrowser',
    requiredEnvVars: ['HYPERBROWSER_API_KEY'],
    createBrowserProvider: () => hyperbrowser({
      apiKey: process.env.HYPERBROWSER_API_KEY!,
    }),
    sessionCreateOptions: {
      region: 'us-east',
      stealth: false,
      proxies: false,
      headless: true,
      viewport: VIEWPORT,
      // hyperbrowser requires saveDownloads at session create or the
      // downloads API reports 'not_enabled'.
      saveDownloads: true,
    },
    // docs.hyperbrowser.ai: 'allow' + downloadPath '/tmp/downloads' points the
    // file at the dir saveDownloads syncs to the session downloads zip.
    downloadBehavior: { behavior: 'allow', downloadPath: '/tmp/downloads' },
    fetchSessionDownloads: hyperbrowserFetchSessionDownloads,
  },
  {
    name: 'kernel',
    requiredEnvVars: ['KERNEL_API_KEY'],
    createBrowserProvider: () => kernel({
      apiKey: process.env.KERNEL_API_KEY!,
    }),
    sessionCreateOptions: {
      stealth: false,
      proxies: false,
      headless: true,
      viewport: VIEWPORT,
    },
    remoteDownloadDir: '/tmp',
    fetchRemoteFile: kernelFetchRemoteFile,
  },
  {
    name: 'notte',
    requiredEnvVars: ['NOTTE_API_KEY'],
    createBrowserProvider: () => notte({
      apiKey: process.env.NOTTE_API_KEY!,
    }),
    sessionCreateOptions: {
      stealth: false,
      proxies: false,
      headless: true,
      viewport: VIEWPORT,
    },
    // Notte points every Browser.setDownloadBehavior at the session's
    // download dir, which the session files API lists, so no
    // downloadBehavior override is needed.
    fetchSessionDownloads: notteFetchSessionDownloads,
  },
  {
    name: 'steel',
    requiredEnvVars: ['STEEL_API_KEY'],
    createBrowserProvider: () => steel({
      apiKey: process.env.STEEL_API_KEY!,
    }),
    sessionCreateOptions: {
      stealth: false,
      proxies: false,
      headless: true,
      viewport: VIEWPORT,
    },
    // steel session filesystem is mounted at /files (files API / files.zip).
    downloadBehavior: { behavior: 'allow', downloadPath: '/files' },
    fetchSessionDownloads: steelFetchSessionDownloads,
  },
  {
    name: 'styne',
    requiredEnvVars: ['STYNE_API_KEY'],
    createBrowserProvider: () => styneBrowser({
      apiKey: process.env.STYNE_API_KEY!,
    }),
    sessionCreateOptions: {
      stealth: false,
      proxies: false,
      headless: true,
      viewport: VIEWPORT,
    },
    remoteDownloadDir: '/tmp/downloads',
    fetchRemoteFile: styneFetchRemoteFile,
  },
  {
    name: 'tilion',
    requiredEnvVars: ['TILION_API_KEY', 'TILION_BASE_URL'],
    createBrowserProvider: () => tilion({
      apiKey: process.env.TILION_API_KEY!,
      baseUrl: process.env.TILION_BASE_URL!,
    }),
    sessionCreateOptions: {
      stealth: false,
      proxies: false,
      headless: true,
      viewport: VIEWPORT,
    },
  },
];
