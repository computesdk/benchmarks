/**
 * Database CRUD benchmark: create → read → update → read → delete cycles.
 * Declarative — exports `config` + `task`; `bench run` owns the entrypoint.
 * The custom `--payload-size` flag is scanned from argv here.
 *
 *   bench run benchmarks/database/crud.bench.ts
 *   bench run benchmarks/database/crud.bench.ts --payload-size 4096 --iterations 10
 *   bench run benchmarks/database/crud.bench.ts --payload-size 1024 --provider postgres
 */
import '../src/env.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineBenchmarkConfig, defineTask, TaskError } from '@benchsdk/runner';
import { withTimeout } from '../src/util/timeout.js';
import { formatError } from '../src/util/error.js';
import { databaseProviders } from './providers.js';
import { writeDatabaseLegacyResults } from './legacy-results.js';
import { runCrudCycle } from './benchmark.js';
import type { DatabaseClient, DatabaseProviderConfig } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function getArgValue(argv: string[], flag: string): string | undefined {
  const idx = argv.indexOf(flag);
  if (idx !== -1 && idx + 1 < argv.length) return argv[idx + 1];
  const equals = argv.find((arg) => arg.startsWith(`${flag}=`));
  return equals?.slice(flag.length + 1);
}

const payloadSizeArg = getArgValue(process.argv.slice(2), '--payload-size');
const payloadBytes = payloadSizeArg === undefined ? 1024 : Number(payloadSizeArg);
if (!Number.isInteger(payloadBytes) || payloadBytes < 1) {
  console.error(`Invalid --payload-size "${payloadSizeArg}". Provide a positive integer.`);
  process.exit(1);
}

const clients = new Map<string, DatabaseClient>();
const setupPromises = new Map<string, Promise<void>>();

export const config = defineBenchmarkConfig({
  benchmarkSlug: 'database-crud-local',
  benchmarkName: 'Database CRUD (local)',
  benchmarkKind: 'database',
  iterations: 10,
  concurrency: 1,
  participants: databaseProviders,
  onComplete: async (outcome) => {
    await writeDatabaseLegacyResults(outcome.participants, {
      resultsDir: path.resolve(__dirname, '../../results/database'),
      providers: databaseProviders,
      payloadBytes,
    });
    await Promise.all([...clients.values()].map((client) => client.close()));
  },
});

export const task = defineTask<DatabaseProviderConfig>(async (ctx) => {
  const { participant, step } = ctx;
  const timeout = participant.timeout ?? 30_000;
  let client = clients.get(participant.name);
  if (!client) {
    client = participant.createClient();
    clients.set(participant.name, client);
  }

  try {
    let setup = setupPromises.get(participant.name);
    if (!setup) {
      setup = withTimeout(client.setup(), timeout, 'Database setup timed out');
      setupPromises.set(participant.name, setup);
    }
    await setup;

    const result = await runCrudCycle(
      client,
      {
        step: (name, fn) => step(name, () => withTimeout(Promise.resolve(fn()), timeout, `${name} timed out`)),
        cleanup: (fn) => withTimeout(Promise.resolve(fn()), 10_000, 'Delete timed out'),
      },
      payloadBytes,
    );
    return { data: result };
  } catch (error) {
    const message = formatError(error);
    throw new TaskError(message, {
      code: 'DATABASE_ERROR',
      data: {
        createMs: 0,
        readMs: 0,
        updateMs: 0,
        readAfterUpdateMs: 0,
        deleteMs: 0,
        totalMs: 0,
        payloadBytes,
      },
    });
  }
});
