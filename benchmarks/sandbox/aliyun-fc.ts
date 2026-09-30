/**
 * Lightweight ComputeSDK adapter for Alibaba Cloud Function Compute (FC)
 * sandbox benchmarks.
 *
 * This adapter talks to a small FC-side gateway over HTTP instead of requiring
 * a published `@computesdk/aliyun-fc` package. The gateway must expose three
 * endpoints:
 *
 *   POST /create  - create/resume a sandbox
 *   POST /run     - run a command inside the sandbox
 *   POST /destroy - tear down the sandbox
 *
 * Authentication is done via `Authorization: Bearer <gatewaySecret>`.
 *
 * The gateway is responsible for translating these calls into FC sandbox
 * lifecycle operations (e.g. FC function invocation, microsandbox resume,
 * envd exec, etc.). Only the benchmark-facing contract lives in this file.
 */

export interface AliyunFcGatewayOptions {
  /** Base URL of the FC sandbox gateway. */
  gatewayUrl: string;
  /** Shared secret used in the `Authorization` header. Optional for testing. */
  gatewaySecret?: string;
  /** Optional FC region, passed through as metadata. */
  region?: string;
}

interface GatewayCreateResponse {
  sandboxId: string;
  [key: string]: unknown;
}

interface GatewayRunResponse {
  exitCode: number;
  stdout?: string;
  stderr?: string;
  durationMs?: number;
}

const PROVIDER_NAME = 'aliyun-fc';

function gatewayUrl(base: string, path: string): string {
  const normalized = base.replace(/\/$/, '');
  return `${normalized}${path}`;
}

async function gatewayRequest<T>(
  options: AliyunFcGatewayOptions,
  path: string,
  body: unknown,
): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (options.gatewaySecret) {
    headers.Authorization = `Bearer ${options.gatewaySecret}`;
  }

  const response = await fetch(gatewayUrl(options.gatewayUrl, path), {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `FC gateway ${path} failed (${response.status} ${response.statusText}): ${text}`,
    );
  }

  if (!text) {
    return undefined as T;
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`FC gateway ${path} returned invalid JSON: ${text}`);
  }
}

function notImplemented(method: string) {
  return async () => {
    throw new Error(`${method} is not implemented by the aliyun-fc gateway adapter`);
  };
}

export function aliyunFc(options: AliyunFcGatewayOptions) {
  return {
    sandbox: {
      create: async (createOptions?: Record<string, unknown>) => {
        const body = {
          ...(createOptions ?? {}),
          provider: PROVIDER_NAME,
          region: options.region,
        };

        const created = await gatewayRequest<GatewayCreateResponse>(options, '/create', body);
        if (!created?.sandboxId) {
          throw new Error('FC gateway /create did not return a sandboxId');
        }

        const sandboxId = created.sandboxId;

        return {
          sandboxId,
          provider: PROVIDER_NAME,

          runCommand: async (command: string) => {
            const result = await gatewayRequest<GatewayRunResponse>(options, '/run', {
              sandboxId,
              command,
            });

            return {
              exitCode: result.exitCode ?? 1,
              stdout: result.stdout ?? '',
              stderr: result.stderr ?? '',
              durationMs: result.durationMs ?? 0,
            };
          },

          destroy: async () => {
            await gatewayRequest<unknown>(options, '/destroy', { sandboxId });
          },

          // The TTI benchmark only needs `runCommand` and `destroy`. The rest
          // are stubs so the returned object satisfies the ComputeSDK sandbox
          // shape without adding network calls that would perturb measurements.
          getInfo: notImplemented('getInfo'),
          getUrl: notImplemented('getUrl'),
          filesystem: {
            readFile: notImplemented('filesystem.readFile'),
            writeFile: notImplemented('filesystem.writeFile'),
            readdir: notImplemented('filesystem.readdir'),
            mkdir: notImplemented('filesystem.mkdir'),
            exists: notImplemented('filesystem.exists'),
            remove: notImplemented('filesystem.remove'),
          },
        };
      },
    },
  };
}
