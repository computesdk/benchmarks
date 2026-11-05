/**
 * Sandbox capabilities matrix benchmark.
 *
 * Creates one sandbox per provider and probes the full ComputeSDK surface,
 * recording a pass/fail (plus error text) for each named capability. Each
 * probe is its own `ctx.step` with an individual try/catch so a failure in one
 * capability does not abort the remaining probes. Results are aggregated into
 * a feature matrix JSON under `results/sandbox-capabilities/`.
 *
 *   bench run benchmarks/sandbox/capabilities.bench.ts
 *   bench run benchmarks/sandbox/capabilities.bench.ts --provider e2b,modal
 */
import '../src/env.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineBenchmarkConfig, defineTask } from '@benchsdk/runner';
import type { TaskResult } from '@benchsdk/runner';
import type { JsonObject } from '@benchsdk/client';
import type {
  SandboxInterface,
  CommandResult,
  SandboxInfo,
  FileEntry,
  RunCommandOptions,
  CreateSandboxOptions,
} from 'computesdk';
import { withTimeout } from '../src/util/timeout.js';
import { formatError } from '../src/util/error.js';
import { providers } from './providers.js';
import type { ProviderConfig, ProviderCapabilityMatrix } from './types.js';
import { writeSandboxCapabilitiesResults } from './capabilities-results.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CREATE_TIMEOUT_MS = 120_000;
const COMMAND_TIMEOUT_MS = 30_000;
const DESTROY_TIMEOUT_MS = 15_000;
const LIST_TIMEOUT_MS = 30_000;
const GETURL_TIMEOUT_MS = 30_000;
const SNAPSHOT_TIMEOUT_MS = 120_000;
const TEMPLATE_TIMEOUT_MS = 120_000;
const STREAM_TIMEOUT_MS = 30_000;
const FS_TIMEOUT_MS = 30_000;
const GETURL_PORT = 3000;

interface CapabilityCompute {
  readonly name: string;
  readonly sandbox: {
    create(options?: CreateSandboxOptions): Promise<SandboxInterface>;
    getById(sandboxId: string): Promise<SandboxInterface | null>;
    list(): Promise<SandboxInterface[]>;
    destroy(sandboxId: string): Promise<void>;
  };
  readonly snapshot?: {
    create(sandboxId: string, options?: { name?: string; metadata?: Record<string, string> }): Promise<unknown>;
    list(options?: { sandboxId?: string; limit?: number }): Promise<unknown[]>;
    delete(snapshotId: string): Promise<void>;
  };
  readonly template?: {
    create(options: { name: string; description?: string; metadata?: Record<string, string> }): Promise<unknown>;
    list(options?: { limit?: number }): Promise<unknown[]>;
    delete(templateId: string): Promise<void>;
  };
}

export const config = defineBenchmarkConfig({
  benchmarkSlug: 'sandbox-capabilities',
  benchmarkName: 'Sandbox Capabilities',
  iterations: 1,
  concurrency: 1,
  participants: providers,
  onComplete: (outcome) =>
    writeSandboxCapabilitiesResults(outcome.participants, {
      resultsDir: path.resolve(__dirname, '../../results/sandbox-capabilities'),
      runConfig: outcome.config,
    }),
});

export const task = defineTask<ProviderConfig>(async (ctx): Promise<TaskResult> => {
  const { participant, step, measure } = ctx;
  const compute = participant.createCompute() as CapabilityCompute;

  const rawOptions = participant.sandboxOptions ?? {};
  const getUrlPort = Array.isArray(rawOptions.ports) && rawOptions.ports.length > 0
    ? (rawOptions.ports as number[])[0]
    : GETURL_PORT;
  const sandboxOptions: CreateSandboxOptions = { ...rawOptions };

  const filePath = '/tmp/capabilities-file.txt';
  const dirPath = '/tmp/capabilities-dir';
  const testContent = 'Hello, ComputeSDK filesystem!';

  const matrix: ProviderCapabilityMatrix = {};
  let sandbox: SandboxInterface | null = null;
  let createdSnapshotId: string | undefined;
  let createdTemplateId: string | undefined;

  function recordFeature(name: string, passed: boolean, error?: string) {
    matrix[name] = passed ? { passed: true } : { passed: false, ...(error ? { error } : {}) };
  }

  async function probe(
    name: string,
    fn: () => Promise<void>,
    opts: { needsSandbox?: boolean } = {},
  ): Promise<void> {
    await step(name, async () => {
      if (opts.needsSandbox && !sandbox) {
        const error = 'sandbox creation failed';
        measure({ passed: false, error });
        recordFeature(name, false, error);
        return;
      }
      try {
        await fn();
        measure({ passed: true });
        recordFeature(name, true);
      } catch (err) {
        const error = formatError(err);
        measure({ passed: false, error });
        recordFeature(name, false, error);
      }
    });
  }

  await probe('create', async () => {
    sandbox = await withTimeout(
      compute.sandbox.create(sandboxOptions),
      participant.timeout ?? CREATE_TIMEOUT_MS,
      'Sandbox creation timed out',
    );
  });

  try {
    await probe('runCommand', async () => {
      const result = await withTimeout(
        sandbox!.runCommand('echo "capability-test"'),
        COMMAND_TIMEOUT_MS,
        'Command timed out',
      ) as CommandResult;
      if (result.exitCode !== 0) {
        throw new Error(`Command failed with exit code ${result.exitCode}: ${result.stderr || 'unknown'}`);
      }
    }, { needsSandbox: true });

    await probe('getInfo', async () => {
      const info = (await withTimeout(
        sandbox!.getInfo(),
        COMMAND_TIMEOUT_MS,
        'getInfo timed out',
      )) as SandboxInfo;
      if (!info || typeof info.id !== 'string') {
        throw new Error('getInfo returned invalid sandbox info');
      }
    }, { needsSandbox: true });

    await probe('getById', async () => {
      const retrieved = await withTimeout(
        compute.sandbox.getById(sandbox!.sandboxId),
        LIST_TIMEOUT_MS,
        'getById timed out',
      );
      if (!retrieved) throw new Error('getById returned null');
      if (retrieved.sandboxId !== sandbox!.sandboxId) throw new Error('getById returned a different sandbox');
    }, { needsSandbox: true });

    await probe('list', async () => {
      const list = await withTimeout(compute.sandbox.list(), LIST_TIMEOUT_MS, 'list timed out');
      if (!Array.isArray(list)) throw new Error('list did not return an array');
    });

    await probe('getUrl', async () => {
      const url = await withTimeout(
        sandbox!.getUrl({ port: getUrlPort }),
        GETURL_TIMEOUT_MS,
        'getUrl timed out',
      );
      if (!url || typeof url !== 'string' || !/^(https?|wss?):\/\/.+/.test(url)) {
        throw new Error(`getUrl returned invalid URL: ${url}`);
      }
    }, { needsSandbox: true });

    await probe('background', async () => {
      const result = await withTimeout(
        sandbox!.runCommand('sleep 1', { background: true } as RunCommandOptions),
        COMMAND_TIMEOUT_MS,
        'Background command timed out',
      ) as CommandResult;
      if (result.exitCode !== 0) {
        throw new Error(`Background command failed with exit code ${result.exitCode}: ${result.stderr || 'unknown'}`);
      }
    }, { needsSandbox: true });

    await probe('streaming', async () => {
      const chunks: string[] = [];
      let firstChunkAt: number | undefined;
      const startedAt = Date.now();
      const result = await withTimeout(
        sandbox!.runCommand(
          `sh -c 'for i in 1 2 3 4 5; do echo tick $i; sleep 1; done'`,
          { onStdout: (text: string) => { firstChunkAt ??= Date.now(); chunks.push(text); } } as RunCommandOptions,
        ),
        STREAM_TIMEOUT_MS,
        'Streaming command timed out',
      ) as CommandResult;
      if (result.exitCode !== 0) {
        throw new Error(`Streaming command failed with exit code ${result.exitCode}: ${result.stderr || 'unknown'}`);
      }
      if (firstChunkAt === undefined) throw new Error('No stdout chunk received before command completed');
      if (result.durationMs > 0 && firstChunkAt - startedAt >= result.durationMs / 2) {
        throw new Error('First stdout chunk arrived too late (likely buffered until completion)');
      }
    }, { needsSandbox: true });

    await probe('writeFile', async () => {
      await withTimeout(
        sandbox!.filesystem.writeFile(filePath, testContent),
        FS_TIMEOUT_MS,
        'writeFile timed out',
      );
    }, { needsSandbox: true });

    await probe('readFile', async () => {
      const content = await withTimeout(
        sandbox!.filesystem.readFile(filePath),
        FS_TIMEOUT_MS,
        'readFile timed out',
      );
      if (content !== testContent) {
        throw new Error('readFile returned unexpected content');
      }
    }, { needsSandbox: true });

    await probe('mkdir', async () => {
      await withTimeout(
        sandbox!.filesystem.mkdir(dirPath),
        FS_TIMEOUT_MS,
        'mkdir timed out',
      );
    }, { needsSandbox: true });

    await probe('readdir', async () => {
      await withTimeout(
        sandbox!.filesystem.writeFile(`${dirPath}/file1.txt`, 'content1'),
        FS_TIMEOUT_MS,
        'readdir setup writeFile timed out',
      );
      await withTimeout(
        sandbox!.filesystem.writeFile(`${dirPath}/file2.txt`, 'content2'),
        FS_TIMEOUT_MS,
        'readdir setup writeFile timed out',
      );
      const entries = (await withTimeout(
        sandbox!.filesystem.readdir(dirPath),
        FS_TIMEOUT_MS,
        'readdir timed out',
      )) as FileEntry[];
      const names = entries.map((entry) => entry.name);
      if (!names.includes('file1.txt') || !names.includes('file2.txt')) {
        throw new Error('readdir did not return the expected files');
      }
    }, { needsSandbox: true });

    await probe('exists', async () => {
      const fileExists = await withTimeout(
        sandbox!.filesystem.exists(filePath),
        FS_TIMEOUT_MS,
        'exists timed out',
      );
      if (!fileExists) throw new Error('exists returned false for an existing file');
    }, { needsSandbox: true });

    await probe('remove', async () => {
      await withTimeout(sandbox!.filesystem.remove(filePath), FS_TIMEOUT_MS, 'remove timed out');
      const stillExists = await withTimeout(
        sandbox!.filesystem.exists(filePath),
        FS_TIMEOUT_MS,
        'exists after remove timed out',
      );
      if (stillExists) throw new Error('remove did not delete the file');
    }, { needsSandbox: true });

    await probe('snapshot.create', async () => {
      if (!compute.snapshot) throw new Error('Snapshot manager not exposed');
      const snapshot = await withTimeout(
        compute.snapshot.create(sandbox!.sandboxId, { name: `capability-snapshot-${Date.now()}` }),
        SNAPSHOT_TIMEOUT_MS,
        'Snapshot creation timed out',
      );
      createdSnapshotId = extractId(snapshot, 'snapshot');
    }, { needsSandbox: true });

    await probe('snapshot.list', async () => {
      if (!compute.snapshot) throw new Error('Snapshot manager not exposed');
      const list = await withTimeout(compute.snapshot.list(), SNAPSHOT_TIMEOUT_MS, 'Snapshot list timed out');
      if (!Array.isArray(list)) throw new Error('Snapshot list did not return an array');
    });

    await probe('snapshot.delete', async () => {
      if (!compute.snapshot) throw new Error('Snapshot manager not exposed');
      if (!createdSnapshotId) throw new Error('Snapshot creation failed, nothing to delete');
      await withTimeout(
        compute.snapshot.delete(createdSnapshotId),
        SNAPSHOT_TIMEOUT_MS,
        'Snapshot delete timed out',
      );
    });

    await probe('template.create', async () => {
      if (!compute.template) throw new Error('Template manager not exposed');
      const template = await withTimeout(
        compute.template.create({ name: `capability-template-${Date.now()}`, description: 'benchmark capability probe' }),
        TEMPLATE_TIMEOUT_MS,
        'Template creation timed out',
      );
      createdTemplateId = extractId(template, 'template');
    });

    await probe('template.list', async () => {
      if (!compute.template) throw new Error('Template manager not exposed');
      const list = await withTimeout(compute.template.list(), TEMPLATE_TIMEOUT_MS, 'Template list timed out');
      if (!Array.isArray(list)) throw new Error('Template list did not return an array');
    });

    await probe('template.delete', async () => {
      if (!compute.template) throw new Error('Template manager not exposed');
      if (!createdTemplateId) throw new Error('Template creation failed, nothing to delete');
      await withTimeout(
        compute.template.delete(createdTemplateId),
        TEMPLATE_TIMEOUT_MS,
        'Template delete timed out',
      );
    });
  } finally {
    await probe('destroy', async () => {
      if (!sandbox) throw new Error('sandbox creation failed, no sandbox to destroy');
      await withTimeout(
        sandbox.destroy(),
        participant.destroyTimeoutMs ?? DESTROY_TIMEOUT_MS,
        'Destroy timed out',
      );
    });
  }

  return { data: { features: matrix } as unknown as JsonObject };
});

function extractId(resource: unknown, kind: 'snapshot' | 'template'): string {
  if (resource && typeof resource === 'object') {
    const record = resource as Record<string, unknown>;
    if (typeof record.id === 'string') return record.id;
    if (kind === 'snapshot' && typeof record.snapshotId === 'string') return record.snapshotId;
    if (kind === 'template' && typeof record.templateId === 'string') return record.templateId;
  }
  if (typeof resource === 'string') return resource;
  throw new Error(`Could not determine ${kind} id from create response`);
}
