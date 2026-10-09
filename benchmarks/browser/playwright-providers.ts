import { setTimeout as delay } from 'node:timers/promises';
import { readFileSync } from 'node:fs';
import type { JsonObject } from '@benchsdk/api';
import { parseCliArgs, selectParticipants, filterParticipantsByEnv } from '@benchsdk/runner';
import type { PlaywrightProviderConfig } from './playwright-types.js';

export const PLAYWRIGHT_VERSION = '1.60.0';
export const PROVISION_TIMEOUT_MS = 120_000;
export const CONNECT_TIMEOUT_MS = 30_000;
export const CLEANUP_TIMEOUT_MS = 15_000;
export const VIEWPORT = { width: 1920, height: 1080 };

// Parse only flags owned by the suites; the runner handles the rest of the CLI.
export const playwrightArgs = parseCliArgs(process.argv.flatMap((arg, index) => {
  if (/^--(?:provider|iterations)=/.test(arg)) return [arg];
  if (arg === '--provider' || arg === '--iterations') return [arg, process.argv[index + 1] ?? ''];
  return [];
}));

export function requireProviderCredentials(): void {
  const selected = selectParticipants(playwrightProviders, playwrightArgs.providers);
  const { skipped } = filterParticipantsByEnv(selected);
  if (skipped.length) {
    const missing = skipped.map(({ name, missing }) => `${name}: ${missing.join(', ')}`).join('; ');
    throw new Error(`Unavailable Playwright participant(s): ${missing}. Supply credentials for every selected provider; use --provider for an explicit diagnostic run.`);
  }
}

export function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid provider response');
  return value as Record<string, unknown>;
}

function string(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Missing provider response field');
  return value;
}

function environment(provider: string): JsonObject {
  const filename = requiredEnv('PLAYWRIGHT_NATIVE_ENVIRONMENT_FILE');
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(filename, 'utf8')); }
  catch { throw new Error('Cannot read a valid Playwright-native environment manifest'); }
  const manifest = object(parsed);
  const entry = object(object(manifest.providers)[provider]);
  const region = string(manifest.region);
  const serverVersion = string(entry.playwrightVersion);
  if (entry.region !== region || !/^1\.60\.\d+$/.test(serverVersion)) {
    throw new Error('Both providers must attest to the shared region and Playwright 1.60.x');
  }
  if (entry.os !== 'linux' || entry.headless !== true || entry.stealth !== false || entry.proxy !== false || entry.recording !== false) {
    throw new Error('Environment must attest to headless Linux Chromium without optional features');
  }
  return {
    region,
    runnerLocation: string(manifest.runnerLocation),
    placementEvidence: string(entry.placementEvidence),
    versionEvidence: string(entry.versionEvidence),
    cleanupEvidence: string(entry.cleanupEvidence),
    serverPlaywrightVersion: serverVersion,
    serverPlaywrightVersionSource: 'operator-verified environment manifest',
    clientPlaywrightVersion: PLAYWRIGHT_VERSION,
    browserOs: 'linux', headless: true, viewport: VIEWPORT,
    stealth: false, proxy: false, recording: false,
    metadataSource: 'operator-verified environment manifest',
  };
}

export function safeError(error: unknown, secrets: string[] = []): string {
  let message = error instanceof Error ? error.message : 'Operation failed';
  const values = [...secrets, ...Object.entries(process.env)
    .filter(([key]) => /token|key|secret|password/i.test(key))
    .map(([, value]) => value ?? '')];
  for (const value of values) if (value) message = message.split(value).join('[redacted]');
  return message.replace(/(?:https?|wss?):\/\/[^\s<>]+/g, '[endpoint]')
    .replace(/Bearer\s+[^\s]+/gi, 'Bearer [redacted]');
}

async function request(url: URL, init: RequestInit, signal: AbortSignal): Promise<Response> {
  const response = await fetch(url, { ...init, signal, redirect: 'error' });
  if (!response.ok) throw new Error(`Provider request failed (HTTP ${response.status})`);
  return response;
}

async function sessionResponse(response: Response): Promise<Record<string, unknown>> {
  // JSON parser diagnostics may include credential-bearing response snippets.
  try { return object(await response.json()); }
  catch { throw new Error('Provider returned invalid session JSON'); }
}

export const playwrightProviders: PlaywrightProviderConfig[] = [
  {
    name: 'momentic',
    requiredEnvVars: ['MOMENTIC_BROWSER_FLEET_URL', 'MOMENTIC_BROWSER_FLEET_API_KEY', 'PLAYWRIGHT_NATIVE_ENVIRONMENT_FILE'],
    session(identity) {
      const base = new URL(requiredEnv('MOMENTIC_BROWSER_FLEET_URL'));
      const headers = { Authorization: `Bearer ${requiredEnv('MOMENTIC_BROWSER_FLEET_API_KEY')}`, 'Content-Type': 'application/json', 'Idempotency-Key': identity };
      const metadata = environment('momentic');
      let sessionId: string | undefined;
      let creationUncertain = false;
      const create = async (signal: AbortSignal) => {
        creationUncertain = true;
        const response = await fetch(new URL('/v1/sessions', base), {
          method: 'POST', headers, signal, redirect: 'error',
          body: JSON.stringify({ browser: 'chromium', playwrightVersion: PLAYWRIGHT_VERSION, network: { mode: 'playwright' }, ttlSeconds: 3600, waitTimeoutMs: 0 }),
        });
        if (!response.ok) {
          // A definitive rejection did not allocate a session. A 5xx may have.
          creationUncertain = response.status >= 500;
          throw new Error(`Session creation failed (HTTP ${response.status})`);
        }
        const data = await sessionResponse(response);
        sessionId = string(data.id); // Retain the ID before validating other fields.
        metadata.sessionId = sessionId;
        creationUncertain = false;
        return data;
      };
      const retrieve = async (signal: AbortSignal) => {
        if (!sessionId) throw new Error('Session ID unavailable');
        return sessionResponse(await request(new URL(`/v1/sessions/${encodeURIComponent(sessionId)}`, base), { headers }, signal));
      };
      return {
        metadata,
        async provision() {
          const signal = AbortSignal.timeout(PROVISION_TIMEOUT_MS);
          let data = await create(signal);
          while (data.status === 'QUEUED' || data.status === 'PROVISIONING') {
            await delay(500, undefined, { signal });
            data = await retrieve(signal);
          }
          if (data.status !== 'READY') throw new Error('Momentic session did not become READY');
          if (typeof data.playwrightVersion !== 'string' || !/^1\.60\.\d+$/.test(data.playwrightVersion)) throw new Error('Momentic returned an incompatible Playwright version');
          metadata.serverPlaywrightVersion = string(data.playwrightVersion);
          metadata.serverPlaywrightVersionSource = 'Momentic session response';
          return { endpoint: string(data.wsEndpoint), headers: { Authorization: `Bearer ${string(data.connectToken)}` } };
        },
        async cleanup() {
          const signal = AbortSignal.timeout(CLEANUP_TIMEOUT_MS);
          // Reconcile a lost POST response using the same key, never a new attempt.
          if (!sessionId && creationUncertain) await create(signal);
          if (!sessionId) return;
          await request(new URL(`/v1/sessions/${encodeURIComponent(sessionId)}`, base), { method: 'DELETE', headers }, signal);
          for (;;) {
            const data = await retrieve(signal);
            if (data.status === 'TERMINATED' || data.status === 'EXPIRED' || data.status === 'FAILED') return;
            await delay(500, undefined, { signal });
          }
        },
      };
    },
  },
  {
    name: 'azure',
    requiredEnvVars: ['AZURE_PLAYWRIGHT_SERVICE_URL', 'AZURE_PLAYWRIGHT_ACCESS_TOKEN', 'PLAYWRIGHT_NATIVE_ENVIRONMENT_FILE'],
    session(identity) {
      const url = new URL(requiredEnv('AZURE_PLAYWRIGHT_SERVICE_URL'));
      const headers = { Authorization: `Bearer ${requiredEnv('AZURE_PLAYWRIGHT_ACCESS_TOKEN')}` };
      const metadata = { ...environment('azure'), runId: identity };
      url.protocol = url.protocol === 'wss:' ? 'https:' : url.protocol === 'ws:' ? 'http:' : url.protocol;
      url.searchParams.set('api-version', '2025-09-01');
      url.searchParams.set('os', 'Linux');
      url.searchParams.set('runId', identity);
      let allocationUncertain = false;
      return {
        metadata,
        async provision() {
          // Resolve the documented redirect inside the measured interval.
          allocationUncertain = true;
          const response = await fetch(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(PROVISION_TIMEOUT_MS) });
          if (response.status >= 400 && response.status < 500) allocationUncertain = false;
          if (response.status !== 302 && response.status !== 307) throw new Error(`Azure browser redirect failed (HTTP ${response.status})`);
          const endpoint = new URL(string(response.headers.get('location')), url);
          if (endpoint.protocol !== 'wss:' && endpoint.protocol !== 'ws:') throw new Error('Azure did not return a Playwright WebSocket endpoint');
          return { endpoint: endpoint.href, headers };
        },
        // Azure owns termination on connection close; verify this before a comparison.
        async cleanup({ connected }) {
          if (allocationUncertain && !connected) {
            throw new Error('Azure allocation cleanup is uncertain after failed provisioning/connection; verify resources before rerunning');
          }
        },
      };
    },
  },
];
