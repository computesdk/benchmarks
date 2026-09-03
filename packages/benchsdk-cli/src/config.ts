import { homedir } from 'node:os';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

export interface Credentials {
  baseUrl?: string;
  token?: string;
  apiKey?: string;
  refreshToken?: string;
  tokenExpiresAt?: number;
  refreshExpiresAt?: number;
  orgSlug?: string;
  orgId?: string;
  kind?: 'oauth' | 'api-key';
}

export interface Config {
  baseUrl?: string;
  org?: string;
  format?: 'json' | 'table';
}

const CONFIG_DIR = join(homedir(), '.benchsdk');
const CREDENTIALS_PATH = join(CONFIG_DIR, 'credentials.json');
const CONFIG_PATH = join(CONFIG_DIR, 'config.json');

export async function loadCredentials(): Promise<Credentials | null> {
  try {
    const raw = await readFile(CREDENTIALS_PATH, 'utf-8');
    return JSON.parse(raw) as Credentials;
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return null;
    throw err;
  }
}

export async function saveCredentials(credentials: Credentials): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  await writeFile(CREDENTIALS_PATH, JSON.stringify(credentials, null, 2), { mode: 0o600 });
}

export async function clearCredentials(): Promise<void> {
  try {
    await rm(CREDENTIALS_PATH);
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return;
    throw err;
  }
}

export async function loadConfig(): Promise<Config | null> {
  try {
    const raw = await readFile(CONFIG_PATH, 'utf-8');
    return JSON.parse(raw) as Config;
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return null;
    throw err;
  }
}

export async function saveConfig(config: Config): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
}

export function mergeConfig(defaults: Config, overrides: Config): Config {
  return {
    baseUrl: overrides.baseUrl ?? defaults.baseUrl,
    org: overrides.org ?? defaults.org,
    format: overrides.format ?? defaults.format,
  };
}
