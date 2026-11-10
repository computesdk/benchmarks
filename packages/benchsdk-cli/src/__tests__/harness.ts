import { vi } from 'vitest';
import { run } from '../cli.js';

// Shared by the command test files: they mock '../config.js' (no saved
// config or credentials) and 'node:readline/promises' themselves, because
// vi.mock calls are hoisted per file.

export class ExitCalled extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

export interface RecordedRequest {
  method: string;
  /** Path below /api/v1, e.g. `/benchmarks/alpha`. */
  path: string;
  query: URLSearchParams;
  body: unknown;
  authorization: string | undefined;
}

export interface Reply {
  status?: number;
  body?: unknown;
}

/** Handlers keyed by `METHOD /path` (path below /api/v1, no query). */
export type Routes = Record<string, (request: RecordedRequest) => Reply | Promise<Reply>>;

export interface Invocation {
  exitCode: number | undefined;
  stdout: string;
  stderr: string;
}

const STATUS_TEXT: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  429: 'Too Many Requests',
  503: 'Service Unavailable',
};

export const PLATFORM_URL = 'http://localhost:3210';

export interface CliHarness {
  requests: RecordedRequest[];
  routes: Routes;
  invoke(argv: string[]): Promise<Invocation>;
  useApiKey(key?: string): void;
  useToken(token?: string): void;
  setStdinTTY(value: boolean | undefined): void;
}

/** Call from a `beforeEach`; `restore()` from the matching `afterEach`. */
export function createCliHarness(): CliHarness & { restore(): void } {
  const requests: RecordedRequest[] = [];
  const routes: Routes = {};
  const exitCodes: (number | undefined)[] = [];
  const savedEnv = {
    BENCHMARKS_PLATFORM_URL: process.env.BENCHMARKS_PLATFORM_URL,
    BENCHMARKS_PLATFORM_API_KEY: process.env.BENCHMARKS_PLATFORM_API_KEY,
    BENCHMARKS_PLATFORM_TOKEN: process.env.BENCHMARKS_PLATFORM_TOKEN,
  };
  const savedFetch = globalThis.fetch;
  const ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');

  process.env.BENCHMARKS_PLATFORM_URL = PLATFORM_URL;
  process.env.BENCHMARKS_PLATFORM_API_KEY = 'bp_test_key';
  delete process.env.BENCHMARKS_PLATFORM_TOKEN;

  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCodes.push(code);
    throw new ExitCalled(code);
  }) as never);

  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = (init?.method ?? 'GET').toUpperCase();
    const path = url.pathname.replace(/^\/api\/v1/, '');
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const recorded: RecordedRequest = {
      method,
      path,
      query: url.searchParams,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      authorization: headers.Authorization,
    };
    requests.push(recorded);
    const handler = routes[`${method} ${path}`];
    const reply = handler ? await handler(recorded) : { status: 404, body: { error: `No mock for ${method} ${path}` } };
    const status = reply.status ?? 200;
    return new Response(reply.body === undefined ? '' : JSON.stringify(reply.body), {
      status,
      statusText: STATUS_TEXT[status] ?? '',
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  const join = (spy: { mock: { calls: unknown[][] } }) =>
    spy.mock.calls.map((call) => call.map(String).join(' ')).join('\n');

  return {
    requests,
    routes,
    async invoke(argv) {
      exitCodes.length = 0;
      logSpy.mockClear();
      errorSpy.mockClear();
      try {
        await run(argv);
      } catch (err) {
        if (!(err instanceof ExitCalled)) throw err;
      }
      // run() exits from inside its own try block on success, so a later exit
      // call can follow the first; the first one is the real exit code.
      return { exitCode: exitCodes[0], stdout: join(logSpy), stderr: join(errorSpy) };
    },
    useApiKey(key = 'bp_test_key') {
      delete process.env.BENCHMARKS_PLATFORM_TOKEN;
      process.env.BENCHMARKS_PLATFORM_API_KEY = key;
    },
    useToken(token = 'user_token') {
      delete process.env.BENCHMARKS_PLATFORM_API_KEY;
      process.env.BENCHMARKS_PLATFORM_TOKEN = token;
    },
    setStdinTTY(value) {
      Object.defineProperty(process.stdin, 'isTTY', { value, configurable: true, writable: true });
    },
    restore() {
      vi.restoreAllMocks();
      globalThis.fetch = savedFetch;
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      if (ttyDescriptor) Object.defineProperty(process.stdin, 'isTTY', ttyDescriptor);
      else delete (process.stdin as { isTTY?: boolean }).isTTY;
    },
  };
}

/** Parses the JSON a command printed to stdout. */
export function stdoutJson(invocation: Invocation): unknown {
  return JSON.parse(invocation.stdout);
}
