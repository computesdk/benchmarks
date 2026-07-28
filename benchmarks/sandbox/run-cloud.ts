import {
  Client,
  type CreateSandboxOptions,
  type ExecResult,
} from '@run-cloud/sdk';
import { randomUUID } from 'node:crypto';

interface RunCommandOptions {
  timeout?: number;
}

interface RunCloudComputeOptions {
  apiKey: string;
  apiUrl?: string;
}

export function runCloud(options: RunCloudComputeOptions) {
  const client = new Client(options);

  return {
    sandbox: {
      async create(createOptions: CreateSandboxOptions = {}) {
        const sandbox = await client.sandboxes.create(createOptions);

        return {
          id: sandbox.id,
          runCommand(
            command: string,
            commandOptions: RunCommandOptions = {},
          ): Promise<ExecResult> {
            // The public API proxy terminates long synchronous requests. Detach
            // benchmark workloads and poll them through short exec requests.
            if ((commandOptions.timeout ?? 0) > 45_000) {
              return runLongCommand(
                client,
                sandbox.id,
                command,
                commandOptions.timeout!,
              );
            }

            return client.sandboxes.exec(sandbox.id, command, {
              timeoutSeconds: toTimeoutSeconds(commandOptions.timeout),
            });
          },
          destroy(): Promise<void> {
            return client.sandboxes.destroy(sandbox.id);
          },
        };
      },
    },
  };
}

async function runLongCommand(
  client: Client,
  sandboxId: string,
  command: string,
  timeoutMs: number,
): Promise<ExecResult> {
  const runId = randomUUID().replaceAll('-', '');
  const prefix = `/tmp/run-cloud-benchmark-${runId}`;
  const scriptPath = `${prefix}.sh`;
  const stdoutPath = `${prefix}.stdout`;
  const stderrPath = `${prefix}.stderr`;
  const statusPath = `${prefix}.status`;
  const unitName = `run-cloud-benchmark-${runId}`;
  const encodedCommand = Buffer.from(command).toString('base64');

  const launch = [
    `printf '%s' '${encodedCommand}' | base64 -d > '${scriptPath}'`,
    `chmod 700 '${scriptPath}'`,
    `systemd-run --unit='${unitName}' --collect --quiet --property=OOMPolicy=continue /bin/sh -c 'bash "$1" >"$2" 2>"$3"; printf "%s" "$?" >"$4"' _ '${scriptPath}' '${stdoutPath}' '${stderrPath}' '${statusPath}'`,
  ].join('\n');

  const launched = await client.sandboxes.exec(sandboxId, launch, {
    timeoutSeconds: 30,
  });
  if (launched.exitCode !== 0) return launched;

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let status: ExecResult;
    try {
      status = await client.sandboxes.exec(
        sandboxId,
        `if [ -f '${statusPath}' ]; then cat '${statusPath}'; else printf pending; fi`,
        { timeoutSeconds: 30 },
      );
    } catch (error) {
      if (!isTransientApiError(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500));
      continue;
    }

    if (status.stdout.trim() !== 'pending') {
      const exitCode = Number.parseInt(status.stdout.trim(), 10);
      const stdout = await execWithTransientRetry(
        client,
        sandboxId,
        ['cat', stdoutPath],
        deadline,
      );
      const stderr = await execWithTransientRetry(
        client,
        sandboxId,
        ['cat', stderrPath],
        deadline,
      );
      await cleanupCommandFiles(client, sandboxId, prefix);

      return {
        exit_code: Number.isFinite(exitCode) ? exitCode : 1,
        exitCode: Number.isFinite(exitCode) ? exitCode : 1,
        stdout: stdout.stdout,
        stderr: stderr.stdout,
      };
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  await client.sandboxes.exec(
    sandboxId,
    `systemctl stop '${unitName}' 2>/dev/null || true`,
    { timeoutSeconds: 30 },
  ).catch(() => {});
  await cleanupCommandFiles(client, sandboxId, prefix);
  throw new Error(`Run Cloud command timed out after ${timeoutMs}ms`);
}

async function execWithTransientRetry(
  client: Client,
  sandboxId: string,
  command: string[],
  deadline: number,
): Promise<ExecResult> {
  while (Date.now() < deadline) {
    try {
      return await client.sandboxes.exec(sandboxId, command, {
        timeoutSeconds: 30,
      });
    } catch (error) {
      if (!isTransientApiError(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  throw new Error('Run Cloud API remained unavailable while collecting benchmark output');
}

function isTransientApiError(error: unknown): boolean {
  return error instanceof Error
    && /run\.cloud API (?:429|5\d\d)\b/.test(error.message);
}

async function cleanupCommandFiles(
  client: Client,
  sandboxId: string,
  prefix: string,
): Promise<void> {
  await client.sandboxes.exec(
    sandboxId,
    `rm -f '${prefix}.sh' '${prefix}.stdout' '${prefix}.stderr' '${prefix}.status'`,
    { timeoutSeconds: 30 },
  ).catch(() => {});
}

function toTimeoutSeconds(timeoutMs?: number): number | undefined {
  return timeoutMs === undefined ? undefined : Math.ceil(timeoutMs / 1_000);
}
