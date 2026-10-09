import type { JsonObject } from '@benchsdk/api';

export interface PlaywrightSession {
  metadata: JsonObject;
  provision(): Promise<{ endpoint: string; headers: Record<string, string> }>;
  cleanup(options: { connected: boolean }): Promise<void>;
}

export interface PlaywrightProviderConfig {
  name: string;
  requiredEnvVars: string[];
  session(identity: string): PlaywrightSession;
}
