export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval: number;
}

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  token_type: string;
  expires_in: number;
  scope?: string;
}

export class DeviceFlowError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'DeviceFlowError';
  }
}

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

function formPost(url: string, params: Record<string, string>): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
}

async function errorDescription(response: Response, text: string): Promise<{ code: string; description: string }> {
  let body: { error?: string; error_description?: string } = {};
  try {
    body = JSON.parse(text);
  } catch {
    // ignore
  }
  return {
    code: body.error ?? 'server_error',
    description:
      body.error_description ?? `Request failed: ${response.status} ${response.statusText}`,
  };
}

export async function requestDeviceCode(
  authBaseUrl: string,
  clientId: string,
  resource: string,
  scope: string,
): Promise<DeviceCodeResponse> {
  const response = await formPost(`${authBaseUrl}/device/code`, {
    client_id: clientId,
    resource,
    scope,
  });
  const text = await response.text();
  if (!response.ok) {
    const { description } = await errorDescription(response, text);
    throw new DeviceFlowError('server_error', description);
  }
  return JSON.parse(text) as DeviceCodeResponse;
}

export async function exchangeDeviceToken(
  authBaseUrl: string,
  deviceCode: string,
  clientId: string,
  resource: string,
): Promise<TokenResponse> {
  const response = await formPost(`${authBaseUrl}/oauth2/token`, {
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    device_code: deviceCode,
    client_id: clientId,
    resource,
  });
  const text = await response.text();
  if (!response.ok) {
    const { code, description } = await errorDescription(response, text);
    if (
      code === 'authorization_pending' ||
      code === 'slow_down' ||
      code === 'expired_token' ||
      code === 'access_denied' ||
      code === 'invalid_grant'
    ) {
      throw new DeviceFlowError(code, description);
    }
    throw new Error(description);
  }
  return JSON.parse(text) as TokenResponse;
}

export async function refreshAccessToken(
  authBaseUrl: string,
  refreshToken: string,
  clientId: string,
): Promise<TokenResponse> {
  const response = await formPost(`${authBaseUrl}/oauth2/token`, {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
  });
  const text = await response.text();
  if (!response.ok) {
    const { description } = await errorDescription(response, text);
    throw new AuthError(description);
  }
  return JSON.parse(text) as TokenResponse;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function pollDeviceToken(
  authBaseUrl: string,
  deviceCode: string,
  intervalSeconds: number,
  expiresInSeconds: number,
  clientId: string,
  resource: string,
): Promise<TokenResponse> {
  const start = Date.now();
  let interval = intervalSeconds * 1000;
  const expiresIn = expiresInSeconds * 1000;

  while (Date.now() - start < expiresIn) {
    await sleep(interval);

    try {
      const token = await exchangeDeviceToken(authBaseUrl, deviceCode, clientId, resource);
      return token;
    } catch (err) {
      if (err instanceof DeviceFlowError) {
        if (err.code === 'authorization_pending') continue;
        if (err.code === 'slow_down') {
          interval += 5000;
          continue;
        }
      }
      throw err;
    }
  }

  throw new DeviceFlowError('expired_token', 'Device code expired before authorization completed.');
}
