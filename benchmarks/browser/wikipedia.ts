import type { BrowserContext } from 'playwright-core';
import { withTimeout } from '../src/util/timeout.js';

/**
 * Give every Wikipedia session the same cookie state before its first request.
 * Some cloud egress ranges receive HTTP 429 for fresh, cookieless sessions.
 * This only updates the browser's cookie jar; it does not warm DNS, TLS, or HTTP.
 * Call outside measured navigation/action windows.
 */
export async function seedWikipediaCookie(context: Pick<BrowserContext, 'addCookies'>): Promise<void> {
  try {
    await withTimeout(context.addCookies([{
      name: 'WMF-Last-Access-Global',
      // DD-Mon-YYYY in UTC, e.g. 20-Nov-2026.
      value: new Date().toUTCString().slice(5, 16).replaceAll(' ', '-'),
      domain: '.wikipedia.org',
      path: '/',
      secure: true,
      sameSite: 'Lax',
    }]), 5_000, 'Wikipedia cookie setup timed out');
  } catch (error) {
    throw new Error(`Wikipedia cookie setup failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}
