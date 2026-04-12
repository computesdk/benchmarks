import { EphemeralBox, type EphemeralBoxConfig } from '@upstash/box';

type UpstashBoxRunResult = {
  exitCode: number;
  stderr?: string;
};

type UpstashBoxSandbox = {
  runCommand: (command: string) => Promise<UpstashBoxRunResult>;
  destroy: () => Promise<void>;
};

type UpstashBoxCompute = {
  sandbox: {
    create: (options?: Record<string, unknown>) => Promise<UpstashBoxSandbox>;
  };
};

const DEFAULT_EPHEMERAL_BOX_CONFIG: Pick<EphemeralBoxConfig, 'runtime' | 'ttl'> = {
  runtime: 'node',
  ttl: 300,
};

export function createUpstashBoxCompute(connectionOptions: Pick<EphemeralBoxConfig, 'apiKey'>): UpstashBoxCompute {
  return {
    sandbox: {
      async create(options?: Record<string, unknown>): Promise<UpstashBoxSandbox> {
        const box = await EphemeralBox.create({
          ...DEFAULT_EPHEMERAL_BOX_CONFIG,
          ...options as Partial<EphemeralBoxConfig>,
          ...connectionOptions,
        });

        return {
          async runCommand(command: string): Promise<UpstashBoxRunResult> {
            const run = await box.exec.command(command);
            return {
              exitCode: run.exitCode ?? 1,
              stderr: run.exitCode === 0 ? undefined : run.result,
            };
          },
          destroy: () => box.delete(),
        };
      },
    },
  };
}
