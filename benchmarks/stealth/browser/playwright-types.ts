import type { NavigationRecoveryEvent } from '../../browser/navigation-recovery.js';

import type { JsonObject } from '@benchsdk/client';

export interface PlaywrightSession {
  /** Provider/environment attestation recorded on every record. */
  metadata: JsonObject;
  /** Allocate a browser session and return its Playwright connect endpoint. */
  provision(): Promise<{ endpoint: string; headers: Record<string, string> }>;
  /** Release the session. `connected` is true once chromium.connect() succeeded. */
  cleanup(options: { connected: boolean }): Promise<void>;
}

export interface PlaywrightProviderConfig {
  name: string;
  /** Environment variables that must all be set to run this provider. */
  requiredEnvVars: string[];
  session(identity: string): PlaywrightSession;
}

export const ACTION_TYPES = ['navigate', 'waitForSelector', 'screenshot', 'textContent', 'click', 'goBack'] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

export interface ActionResult {
  index: number;
  type: ActionType;
  durationMs: number;
  success: boolean;
  error?: string;
  /** Initial HTTP 429s and every timed recovery attempt, including successful recoveries. */
  navigationEvents?: NavigationRecoveryEvent[];
}
