#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

function toValidPackageName(input: string): string {
  const name = input
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/^[^a-z]+/, '')
    .replace(/-+/g, '-')
    .replace(/^-+/, '');
  return name || 'bench';
}

function scaffold(targetDir: string, projectName: string): void {
  fs.mkdirSync(targetDir, { recursive: true });

  const packageJson = {
    name: toValidPackageName(projectName),
    version: '0.0.0',
    private: true,
    type: 'module',
    scripts: {
      // `bench run` loads the *.bench.ts module; run it under tsx so the
      // TypeScript benchmark file can be imported without a build step.
      bench: 'tsx node_modules/@benchsdk/runner/dist/bin.js run bench.ts',
      typecheck: 'tsc --noEmit',
    },
    dependencies: {
      '@benchsdk/runner': '^0.2.0',
    },
    devDependencies: {
      tsx: '^4.22.4',
      typescript: '^5.0.0',
    },
  };

  fs.writeFileSync(
    path.join(targetDir, 'package.json'),
    `${JSON.stringify(packageJson, null, 2)}\n`,
  );

  const tsconfigJson = {
    compilerOptions: {
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'bundler',
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
      resolveJsonModule: true,
      noEmit: true,
    },
    include: ['**/*.ts'],
  };

  fs.writeFileSync(
    path.join(targetDir, 'tsconfig.json'),
    `${JSON.stringify(tsconfigJson, null, 2)}\n`,
  );

  const benchTs = `import { defineBenchmarkConfig, defineTask } from '@benchsdk/runner';

// A benchmark file declares two things and nothing else:
//   - config: identity + orchestration knobs + the participants to run against
//   - task:   the workload for ONE iteration
// Run it with \`pnpm bench\` (CLI flags like --iterations / --concurrency
// override the config knobs). No imperative entrypoint needed.
export const config = defineBenchmarkConfig({
  benchmarkSlug: process.env.BENCHMARK_SLUG ?? 'example',
  benchmarkName: 'Example benchmark',
  iterations: 10,
  concurrency: 1,
  participants: [{ name: 'local', requiredEnvVars: [] }],
  display: {
    metrics: [
      { key: 'durationMs', label: 'Duration', unit: 'ms', direction: 'lower-better' },
    ],
  },
  scoring: {
    metrics: [
      { key: 'durationMs', ceiling: 1000, weights: { median: 0.7, p95: 0.2, p99: 0.1 } },
    ],
  },
});

export const task = defineTask(async ({ taskIndex, step, measure, log }) => {
  log(\`running task \${taskIndex}\`);
  // Declare named steps with \`step(...)\`; values flow between them via
  // closures and each step is recorded on the platform with its own timing.
  const start = Date.now();
  await step('work', async () => {
    // Replace with your benchmark logic.
    await new Promise((resolve) => setTimeout(resolve, 100));
  });
  // \`measure(...)\` attaches metrics to the current step (or the task).
  measure({ durationMs: Date.now() - start });
});
`;

  fs.writeFileSync(path.join(targetDir, 'bench.ts'), benchTs);

  const envExample = `# Copy to .env and fill in your values
BENCHMARKS_PLATFORM_URL=
BENCHMARKS_PLATFORM_API_KEY=
BENCHMARK_SLUG=example
`;

  fs.writeFileSync(path.join(targetDir, '.env.example'), envExample);

  const readme = `# ${projectName}

This project was scaffolded by [\`create-bench\`](https://github.com/computesdk/benchmarks/tree/master/packages/create-bench).

## Getting started

1. Install dependencies:

   \`\`\`sh
   pnpm install
   \`\`\`

2. Copy \`.env.example\` to \`.env\` and fill in the required values.

3. Run the benchmark worker:

   \`\`\`sh
   pnpm bench
   \`\`\`
`;

  fs.writeFileSync(path.join(targetDir, 'README.md'), readme);
}

async function askProjectName(): Promise<string | undefined> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const answer = await rl.question('Project name: ');
    return answer.trim() || undefined;
  } finally {
    rl.close();
  }
}

export async function createBench(projectName?: string): Promise<void> {
  const resolvedName = projectName ?? (await askProjectName());

  if (!resolvedName) {
    throw new Error('A project name is required.');
  }

  const targetDir = path.isAbsolute(resolvedName)
    ? resolvedName
    : path.resolve(process.cwd(), resolvedName);
  const packageName = path.basename(targetDir);

  if (fs.existsSync(targetDir) && fs.readdirSync(targetDir).length > 0) {
    throw new Error(`Directory ${targetDir} is not empty.`);
  }

  scaffold(targetDir, packageName);

  console.log(`Created ${packageName} at ${targetDir}`);
  console.log('Next steps:');
  console.log(`  cd ${path.relative(process.cwd(), targetDir) || packageName}`);
  console.log('  pnpm install');
  console.log('  cp .env.example .env');
  console.log('  pnpm bench');
}

async function main(): Promise<void> {
  const projectName = process.argv[2];
  await createBench(projectName);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
