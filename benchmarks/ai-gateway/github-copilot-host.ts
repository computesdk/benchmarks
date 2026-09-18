import https from 'node:https';

const REQUEST_TIMEOUT_MS = 30_000;

export interface CopilotHost {
  /** Hostname to connect to over TLS. */
  host: string;
  /** Extra headers to merge into model-list requests. */
  headers?: Record<string, string>;
}

const COPILOT_CLIENT_HEADERS: Record<string, string> = {
  'User-Agent': 'GitHubCopilotChat/0.32.4',
  'Editor-Version': 'vscode/1.105.1',
  'Editor-Plugin-Version': 'copilot-chat/0.32.4',
  'Copilot-Integration-Id': 'vscode-chat',
  'OpenAI-Intent': 'conversation-edits',
};

const GITHUB_API_VERSION = '2025-10-01';

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

function maskToken(token: string | undefined): string {
  if (!token) return '<empty>';
  if (token.startsWith('ghp_')) return 'ghp_...';
  if (token.startsWith('gho_')) return 'gho_...';
  if (token.startsWith('ghu_')) return 'ghu_...';
  if (token.startsWith('ghs_')) return 'ghs_...';
  if (token.startsWith('github_pat_')) return 'github_pat_...';
  if (token.startsWith('tid=')) return 'tid=...';
  return `(${token.length} chars)`;
}

export function maskSecrets(body: string): string {
  return body
    .replace(/gh[pousr]_[A-Za-z0-9_]+/g, (match) => `${match.slice(0, 4)}...`)
    .replace(/github_pat_[A-Za-z0-9_]+/g, 'github_pat_...')
    .replace(/(token|access_token|refresh_token)[:=][^;&\s"'<>]+/gi, '$1=...')
    .replace(/tid=[^;&\s]+/g, 'tid=...');
}

function httpsGet(options: https.RequestOptions): Promise<{ statusCode?: number; body: string }> {
  return new Promise((resolve) => {
    let settled = false;
    function settle(result: { statusCode?: number; body: string }) {
      if (settled) return;
      settled = true;
      resolve(result);
    }

    const req = https.request(
      { ...options, timeout: REQUEST_TIMEOUT_MS },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('error', () => settle({ statusCode: res.statusCode, body }));
        res.on('aborted', () => settle({ statusCode: res.statusCode, body }));
        res.on('end', () => settle({ statusCode: res.statusCode, body }));
      },
    );

    req.on('error', () => settle({ body: '' }));
    req.on('timeout', () => {
      req.destroy();
      settle({ body: '' });
    });
    req.end();
  });
}

function hostFromUrl(apiUrl: string | undefined): string | undefined {
  if (!apiUrl) return undefined;
  try {
    return new URL(apiUrl).host;
  } catch {
    return undefined;
  }
}

function hostFromSessionToken(sessionToken: string | undefined): string | undefined {
  if (!sessionToken) return undefined;
  const match = sessionToken.match(/proxy-ep=([^;]+)/);
  if (!match) return undefined;
  return match[1].replace(/^proxy\./, 'api.');
}

interface TokenExchangeResult {
  sessionToken: string;
  apiUrl?: string;
}

async function exchangeCopilotToken(
  token: string,
  log: (message: string) => void,
): Promise<TokenExchangeResult | undefined> {
  log(`Copilot: exchanging token ${maskToken(token)} via GET /copilot_internal/v2/token`);
  const { statusCode, body } = await httpsGet({
    method: 'GET',
    hostname: 'api.github.com',
    path: '/copilot_internal/v2/token',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': GITHUB_API_VERSION,
      ...COPILOT_CLIENT_HEADERS,
    },
  });

  if (!statusCode || statusCode < 200 || statusCode >= 300) {
    log(
      `Copilot: token exchange failed with HTTP ${statusCode ?? 'unknown'}: ${maskSecrets(body.slice(0, 500))}`,
    );
    return undefined;
  }

  const parsed = parseJson(body) as
    | { token?: unknown; endpoints?: { api?: string } }
    | undefined;
  const sessionToken =
    parsed && typeof parsed.token === 'string' ? parsed.token : undefined;
  const apiUrl =
    parsed && typeof parsed.endpoints?.api === 'string' ? parsed.endpoints.api : undefined;

  if (!sessionToken) {
    log(`Copilot: token exchange returned no token: ${maskSecrets(body.slice(0, 500))}`);
    return undefined;
  }

  log(
    `Copilot: token exchange OK (session token ${maskToken(sessionToken)}, endpoints.api=${apiUrl ?? 'unknown'})`,
  );
  return { sessionToken, apiUrl };
}

async function discoverCopilotApiUrl(
  token: string,
  log: (message: string) => void,
): Promise<string | undefined> {
  log(`Copilot: discovering API host via GET /copilot_internal/user`);
  const { statusCode, body } = await httpsGet({
    method: 'GET',
    hostname: 'api.github.com',
    path: '/copilot_internal/user',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': GITHUB_API_VERSION,
      ...COPILOT_CLIENT_HEADERS,
    },
  });

  if (!statusCode || statusCode < 200 || statusCode >= 300) {
    log(
      `Copilot: host discovery failed with HTTP ${statusCode ?? 'unknown'}: ${maskSecrets(body.slice(0, 500))}`,
    );
    return undefined;
  }

  const parsed = parseJson(body) as { endpoints?: { api?: string } } | undefined;
  const apiUrl = parsed?.endpoints?.api;
  if (typeof apiUrl !== 'string') {
    log(`Copilot: host discovery response missing endpoints.api: ${maskSecrets(body.slice(0, 500))}`);
    return undefined;
  }

  log(`Copilot: discovered endpoints.api=${apiUrl}`);
  return apiUrl;
}

/**
 * Discover the correct GitHub Copilot API host and obtain a usable session
 * token for the model-list request.
 *
 * GitHub Copilot routes individual, business, and enterprise subscribers to
 * different API hosts (e.g. api.individual.githubcopilot.com or
 * api.enterprise.githubcopilot.com), and the `/models` endpoint may reject
 * plain user tokens unless they are exchanged for a short-lived Copilot API
 * token and accompanied by the client headers the official editors send.
 */
export async function resolveCopilotHost(
  token: string,
  log?: (message: string) => void,
): Promise<CopilotHost | undefined> {
  const writeLog = log ?? (() => {});
  writeLog(`Copilot: resolving API host for token ${maskToken(token)}`);

  const exchange = await exchangeCopilotToken(token, writeLog);

  let authToken = token;
  let apiUrl: string | undefined = exchange?.apiUrl;

  if (exchange) {
    authToken = exchange.sessionToken;
    if (!apiUrl) {
      const tokenHost = hostFromSessionToken(exchange.sessionToken);
      if (tokenHost) {
        apiUrl = `https://${tokenHost}`;
        writeLog(`Copilot: derived API host from session token: ${apiUrl}`);
      }
    }
  }

  if (!apiUrl) {
    apiUrl = await discoverCopilotApiUrl(token, writeLog);
  }

  const host = hostFromUrl(apiUrl);
  if (!host) {
    writeLog(`Copilot: could not determine API host`);
    return undefined;
  }

  writeLog(`Copilot: using host ${host} with token ${maskToken(authToken)}`);
  return {
    host,
    headers: {
      Authorization: `Bearer ${authToken}`,
      ...COPILOT_CLIENT_HEADERS,
      'X-GitHub-Api-Version': GITHUB_API_VERSION,
    },
  };
}
