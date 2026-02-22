interface IsloComputeConfig {
  baseUrl: string;
  token: string;
  tenantPublicId?: string;
  userPublicId?: string;
  image?: string;
  vcpus?: number;
  memoryMb?: number;
  diskGb?: number;
}

interface IsloRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

interface IsloSandbox {
  runCommand: (
    command: string,
    options?: { cwd?: string; timeout?: number; background?: boolean }
  ) => Promise<IsloRunResult>;
  destroy: () => Promise<void>;
}

interface IsloCompute {
  sandbox: {
    create: () => Promise<IsloSandbox>;
  };
}

interface IsloCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export function createIsloCompute(config: IsloComputeConfig): IsloCompute {
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  const headers = buildAuthHeaders(config);

  return {
    sandbox: {
      create: async () => {
        const requestedName = createSandboxName();
        const body = {
          name: requestedName,
          image: config.image ?? 'docker.io/library/python:3.12-slim',
          vcpus: config.vcpus ?? 2,
          memory_mb: config.memoryMb ?? 512,
          disk_gb: config.diskGb ?? 10,
        };

        const created = await fetchJson(`${baseUrl}/sandboxes/`, {
          method: 'POST',
          headers: withJsonHeaders(headers),
          body: JSON.stringify(body),
        });

        const sandboxName =
          created && typeof created.name === 'string' && created.name.trim().length > 0
            ? created.name
            : requestedName;

        return createSandbox(baseUrl, headers, sandboxName);
      },
    },
  };
}

function createSandbox(baseUrl: string, headers: Record<string, string>, sandboxName: string): IsloSandbox {
  return {
    runCommand: async (command, options) => {
      const startedAt = performance.now();
      const timeoutSeconds = options?.timeout ?? 300;
      const timeoutMs = Math.max(1, Math.ceil(timeoutSeconds * 1000));

      const result = await runCommandViaSse(baseUrl, headers, sandboxName, command, {
        cwd: options?.cwd,
        timeoutMs,
      });

      return {
        ...result,
        durationMs: performance.now() - startedAt,
      };
    },
    destroy: async () => {
      const response = await fetch(`${baseUrl}/sandboxes/${encodeURIComponent(sandboxName)}`, {
        method: 'DELETE',
        headers,
      });

      if (response.status === 404 || response.status === 410) {
        return;
      }

      if (!response.ok) {
        throw new Error(
          `ISLO delete failed (${response.status}): ${await safeReadText(response)}`
        );
      }
    },
  };
}

async function runCommandViaSse(
  baseUrl: string,
  headers: Record<string, string>,
  sandboxName: string,
  command: string,
  options: { cwd?: string; timeoutMs: number }
): Promise<IsloCommandResult> {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), options.timeoutMs);

  try {
    const response = await fetch(
      `${baseUrl}/sandboxes/${encodeURIComponent(sandboxName)}/exec/stream`,
      {
        method: 'POST',
        headers: {
          ...withJsonHeaders(headers),
          Accept: 'text/event-stream',
        },
        body: JSON.stringify({
          command: ['/bin/sh', '-lc', command],
          ...(options.cwd ? { cwd: options.cwd } : {}),
        }),
        signal: controller.signal,
      }
    );

    if (!response.ok) {
      throw new Error(`ISLO exec failed (${response.status}): ${await safeReadText(response)}`);
    }

    if (!response.body) {
      throw new Error('ISLO exec stream missing response body');
    }

    return await parseSseResult(response.body);
  } catch (error) {
    if (isAbortError(error)) {
      throw new Error('ISLO exec timed out');
    }
    throw error;
  } finally {
    clearTimeout(timeoutHandle);
  }
}

async function parseSseResult(body: ReadableStream<Uint8Array>): Promise<IsloCommandResult> {
  const reader = body.getReader();
  const decoder = new TextDecoder();

  let stdout = '';
  let stderr = '';
  let exitCode: number | null = null;
  let pendingError: string | null = null;

  let buffer = '';
  let currentEvent = 'message';
  let dataLines: string[] = [];

  const emitEvent = () => {
    if (dataLines.length === 0) {
      currentEvent = 'message';
      return;
    }

    const payload = dataLines.join('\n');
    switch (currentEvent) {
      case 'stdout':
        stdout += payload;
        break;
      case 'stderr':
        stderr += payload;
        break;
      case 'exit': {
        const parsed = parseInt(payload, 10);
        if (Number.isInteger(parsed)) {
          exitCode = parsed;
        }
        break;
      }
      case 'error':
        pendingError = pendingError ? `${pendingError}\n${payload}` : payload;
        break;
      default:
        break;
    }

    currentEvent = 'message';
    dataLines = [];
  };

  const handleLine = (rawLine: string) => {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;

    if (line === '') {
      emitEvent();
      return;
    }

    if (line.startsWith(':')) {
      return;
    }

    if (line.startsWith('event:')) {
      currentEvent = line.slice(6).trim();
      return;
    }

    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart());
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });

    while (true) {
      const newlineIndex = buffer.indexOf('\n');
      if (newlineIndex === -1) {
        break;
      }
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      handleLine(line);
    }
  }

  buffer += decoder.decode();
  if (buffer.length > 0) {
    handleLine(buffer);
  }
  emitEvent();

  if (pendingError) {
    throw new Error(`ISLO exec stream error: ${pendingError}`);
  }

  if (exitCode === null) {
    throw new Error('ISLO exec stream ended without exit event');
  }

  return { stdout, stderr, exitCode };
}

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

function buildAuthHeaders(config: IsloComputeConfig): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.token}`,
  };

  if (config.tenantPublicId) {
    headers['X-Public-Tenant-Id'] = config.tenantPublicId;
  }
  if (config.userPublicId) {
    headers['X-Public-User-Id'] = config.userPublicId;
  }

  return headers;
}

function withJsonHeaders(headers: Record<string, string>): Record<string, string> {
  return {
    ...headers,
    'Content-Type': 'application/json',
  };
}

function createSandboxName(): string {
  return `bench-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function fetchJson(url: string, init: RequestInit): Promise<any> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`ISLO request failed (${response.status}): ${await safeReadText(response)}`);
  }

  return response.json();
}

async function safeReadText(response: Response): Promise<string> {
  try {
    const text = (await response.text()).trim();
    return text || '<empty response>';
  } catch {
    return '<failed to read response>';
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}
