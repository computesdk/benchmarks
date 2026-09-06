import '../src/env.js';
import { defineBenchmarkConfig, defineTask, TaskError } from '@benchsdk/runner';
import { withTimeout } from '../src/util/timeout.js';
import { formatError } from '../src/util/error.js';
import { providers } from '../sandbox/providers.js';
import type { ProviderConfig } from '../sandbox/types.js';

function preview(text: string | null | undefined, max = 2000): string | null {
  if (!text) return null;
  if (text.length <= max) return text;
  return text.slice(0, max) + '...';
}

export const config = defineBenchmarkConfig({
  benchmarkSlug: 'tensorlake-opencode-reliability',
  benchmarkName: 'Tensorlake OpenCode Reliability',
  iterations: 3,
  concurrency: 1,
  staggerDelayMs: 60_000,
  participants: providers,
  defaultProviders: ['tensorlake'],
  display: {
    description: 'Tensorlake OpenCode installation and run reliability.',
    steps: [
      { key: 'create', label: 'Create sandbox' },
      { key: 'install', label: 'Install OpenCode' },
      { key: 'run', label: 'Run OpenCode' },
      { key: 'destroy', label: 'Destroy sandbox' },
    ],
  },
});

export const task = defineTask<ProviderConfig>(async (ctx) => {
  const { participant, step, log } = ctx;
  const compute = participant.createCompute();

  let sandbox: any;

  try {
    sandbox = await step('create', () =>
      withTimeout(
        compute.sandbox.create({
          ...participant.sandboxOptions,
          timeout: 600_000,
        }),
        participant.timeout ?? 120_000,
        'Sandbox creation timed out',
      ),
    );

    await step('install', async () => {
      const result = await sandbox.runCommand(
        'curl -fsSL https://opencode.ai/install -o /tmp/opencode-install.sh && HOME=/tmp/opencode-home bash /tmp/opencode-install.sh --no-modify-path',
        { timeout: 60_000 },
      );
      if (result.exitCode !== 0) {
        log('OpenCode install failed', {
          level: 'error',
          meta: { exitCode: result.exitCode, stderr: preview(result.stderr) },
        });
        throw new TaskError(`OpenCode install failed (exit ${result.exitCode})`);
      }
      log('OpenCode install succeeded', { level: 'info', meta: { exitCode: result.exitCode } });
    });

    const output = await step('run', async () =>
      sandbox.runCommand(
        `export HOME=/tmp/opencode-home && export PATH="/tmp/opencode-home/.opencode/bin:$PATH" && opencode run --auto --model opencode/gpt-5-nano 'Reply with the exact text "tensorlake-ok".'`,
        { timeout: 180_000 },
      ),
    );

    const stdout = output.stdout || '';
    if (output.exitCode !== 0) {
      log('OpenCode run failed', {
        level: 'error',
        meta: { exitCode: output.exitCode, stdout: preview(stdout), stderr: preview(output.stderr) },
      });
      throw new TaskError(`OpenCode run failed (exit ${output.exitCode})`);
    }

    const foundOk = stdout.includes('tensorlake-ok');
    log('OpenCode run completed', {
      level: foundOk ? 'info' : 'error',
      meta: { exitCode: output.exitCode, outputLength: stdout.length, foundOk, stdout: preview(stdout) },
    });
    if (!foundOk) {
      throw new TaskError(`OpenCode output did not include "tensorlake-ok": ${stdout}`.trim());
    }
  } finally {
    if (sandbox) {
      await step(
        'destroy',
        () =>
          withTimeout(
            sandbox.destroy(),
            participant.destroyTimeoutMs ?? 30_000,
            'Destroy timeout',
          ),
        { reportConcurrency: false },
      ).catch((err: unknown) => log('destroy failed', { level: 'warn', meta: { error: formatError(err) } }));
    }
  }
});
