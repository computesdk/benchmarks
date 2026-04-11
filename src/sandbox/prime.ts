interface PrimeComputeConfig {
  apiKey: string;
  baseUrl?: string;
  teamId?: string;
}

interface PrimeCompute {
  sandbox: {
    create: () => Promise<PrimeSandbox>;
  };
}

interface PrimeSandbox {
  runCommand: (
    command: string,
    options?: { cwd?: string; timeout?: number; background?: boolean; env?: Record<string, string> }
  ) => Promise<PrimeRunResult>;
  destroy: () => Promise<void>;
}

interface PrimeRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

interface PrimeSandboxResponse {
  id: string;
  status: string;
  errorType?: string;
  error_type?: string;
  errorMessage?: string;
  error_message?: string;
}

interface PrimeAuthResponse {
  token: string;
  gateway_url?: string;
  gatewayUrl?: string;
  user_ns?: string;
  userNs?: string;
  job_id?: string;
  jobId?: string;
}

interface PrimeCommandResponse {
  stdout?: string;
  stderr?: string;
  exit_code?: number;
  exitCode?: number;
}

const DEFAULT_BASE_URL = 'https://api.primeintellect.ai';
const FAILED_STATUSES = new Set(['ERROR', 'TERMINATED', 'TIMEOUT']);

export function createPrimeCompute(config: PrimeComputeConfig): PrimeCompute {
  const baseUrl = normalizeBaseUrl(config.baseUrl || process.env.PRIME_API_BASE_URL || process.env.PRIME_BASE_URL || DEFAULT_BASE_URL);
  const apiKey = config.apiKey;
  const teamId = config.teamId || process.env.PRIME_TEAM_ID;

  return {
    sandbox: {
      create: async () => {
        const created = await fetchJson<PrimeSandboxResponse>(`${baseUrl}/api/v1/sandbox`, {
          method: 'POST',
          headers: withJsonHeaders(apiHeaders(apiKey)),
          body: JSON.stringify({
            name: createSandboxName(),
            docker_image: process.env.PRIME_SANDBOX_IMAGE || 'node:22',
            start_command: 'tail -f /dev/null',
            cpu_cores: parsePositiveNumber(process.env.PRIME_SANDBOX_CPU_CORES) || 1,
            memory_gb: parsePositiveNumber(process.env.PRIME_SANDBOX_MEMORY_GB) || 2,
            disk_size_gb: parsePositiveNumber(process.env.PRIME_SANDBOX_DISK_SIZE_GB) || 5,
            gpu_count: 0,
            vm: false,
            network_access: true,
            timeout_minutes: parsePositiveInt(process.env.PRIME_SANDBOX_TIMEOUT_MINUTES) || 15,
            team_id: teamId,
          }),
        });

        return createSandbox(baseUrl, apiKey, created.id);
      },
    },
  };
}

function createSandbox(baseUrl: string, apiKey: string, sandboxId: string): PrimeSandbox {
  return {
    runCommand: async (command, options) => {
      const startedAt = performance.now();
      const timeoutSeconds = options?.timeout
        ? Math.max(1, Math.ceil(options.timeout / 1000))
        : 300;
      const result = await runCommandWithRetry(baseUrl, apiKey, sandboxId, command, {
        cwd: options?.cwd,
        env: options?.env,
        timeoutSeconds,
      });

      return {
        ...result,
        durationMs: performance.now() - startedAt,
      };
    },
    destroy: async () => {
      const response = await fetch(`${baseUrl}/api/v1/sandbox/${sandboxId}`, {
        method: 'DELETE',
        headers: apiHeaders(apiKey),
      });

      if (response.status === 404 || response.status === 410) {
        return;
      }

      if (!response.ok) {
        throw new Error(`Prime delete failed (${response.status}): ${await safeReadText(response)}`);
      }
    },
  };
}

async function runCommandWithRetry(
  baseUrl: string,
  apiKey: string,
  sandboxId: string,
  command: string,
  options: { cwd?: string; env?: Record<string, string>; timeoutSeconds: number }
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const deadline = Date.now() + options.timeoutSeconds * 1000;
  let lastError: unknown;
  let attempt = 0;

  while (Date.now() < deadline) {
    const sandbox = await fetchJson<PrimeSandboxResponse>(`${baseUrl}/api/v1/sandbox/${sandboxId}`, {
      method: 'GET',
      headers: apiHeaders(apiKey),
    });

    if (FAILED_STATUSES.has(sandbox.status)) {
      throw new Error(formatSandboxError(sandbox));
    }

    if (sandbox.status === 'RUNNING') {
      try {
        return await execPrimeCommand(baseUrl, apiKey, sandboxId, command, {
          cwd: options.cwd,
          env: options.env,
          timeoutSeconds: Math.max(1, Math.ceil((deadline - Date.now()) / 1000)),
        });
      } catch (error) {
        lastError = error;
      }
    }

    await sleep(attempt < 5 ? 1000 : 2000);
    attempt += 1;
  }

  const reason = lastError instanceof Error ? lastError.message : 'sandbox never became command-ready';
  throw new Error(`Prime sandbox ${sandboxId} was not ready in time: ${reason}`);
}

async function execPrimeCommand(
  baseUrl: string,
  apiKey: string,
  sandboxId: string,
  command: string,
  options: { cwd?: string; env?: Record<string, string>; timeoutSeconds: number }
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const auth = await fetchJson<PrimeAuthResponse>(`${baseUrl}/api/v1/sandbox/${sandboxId}/auth`, {
    method: 'POST',
    headers: apiHeaders(apiKey),
  });

  const gatewayUrl = normalizeBaseUrl(auth.gateway_url || auth.gatewayUrl || '');
  const userNs = auth.user_ns || auth.userNs;
  const jobId = auth.job_id || auth.jobId;

  if (!gatewayUrl || !userNs || !jobId || !auth.token) {
    throw new Error(`Prime auth response was missing gateway details for sandbox ${sandboxId}`);
  }

  const result = await fetchJson<PrimeCommandResponse>(
    `${gatewayUrl}/${userNs}/${jobId}/exec`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${auth.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        command,
        working_dir: options.cwd,
        env: validateEnv(options.env),
        sandbox_id: sandboxId,
        timeout: options.timeoutSeconds,
      }),
    },
    options.timeoutSeconds * 1000 + 5000
  );

  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    exitCode: result.exit_code ?? result.exitCode ?? 1,
  };
}

function validateEnv(env?: Record<string, string>): Record<string, string> {
  if (!env) return {};

  const safeKeyPattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
  for (const key of Object.keys(env)) {
    if (!safeKeyPattern.test(key)) {
      throw new Error(`Invalid environment variable name: ${key}`);
    }
  }

  return env;
}

function apiHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
  };
}

function withJsonHeaders(headers: Record<string, string>): Record<string, string> {
  return {
    ...headers,
    'Content-Type': 'application/json',
  };
}

async function fetchJson<T>(url: string, init: RequestInit, timeoutMs = 30000): Promise<T> {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
    });

    const text = await response.text();
    const data = text ? JSON.parse(text) as unknown : {};

    if (!response.ok) {
      const detail = typeof data === 'object' && data !== null && 'detail' in data
        ? String((data as { detail?: unknown }).detail)
        : text || response.statusText;
      throw new Error(`Prime request failed (${response.status}): ${detail}`);
    }

    return data as T;
  } catch (error) {
    if (isAbortError(error)) {
      throw new Error(`Prime request timed out after ${timeoutMs}ms: ${url}`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutHandle);
  }
}

async function safeReadText(response: Response): Promise<string> {
  try {
    const text = (await response.text()).trim();
    return text || '<empty response>';
  } catch {
    return '<failed to read response>';
  }
}

function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '').replace(/\/api\/v1$/, '');
}

function createSandboxName(): string {
  return `prime-bench-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function formatSandboxError(sandbox: PrimeSandboxResponse): string {
  const errorType = sandbox.errorType || sandbox.error_type;
  const errorMessage = sandbox.errorMessage || sandbox.error_message;
  const detail = [errorType, errorMessage].filter(Boolean).join(': ');
  return detail ? `Sandbox ${sandbox.id} ${sandbox.status}: ${detail}` : `Sandbox ${sandbox.id} ${sandbox.status}`;
}

function parsePositiveNumber(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? value : undefined;
  }

  if (typeof value === 'string') {
    if (!value.trim()) return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  }

  return undefined;
}

function parsePositiveInt(value: unknown): number | undefined {
  const parsed = parsePositiveNumber(value);
  return parsed === undefined ? undefined : Math.floor(parsed);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}
