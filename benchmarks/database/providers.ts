import type { DatabaseProviderConfig } from './types.js';
import { createPostgresClient } from './postgres.js';

const table = process.env.DATABASE_BENCH_TABLE || 'benchmark_crud';

/** Database provider configurations. Add future providers above the sentinel. */
export const databaseProviders: DatabaseProviderConfig[] = [
  {
    name: 'postgres',
    requiredEnvVars: ['DATABASE_POSTGRES_URL'],
    table,
    createClient: () => createPostgresClient({
      connectionString: process.env.DATABASE_POSTGRES_URL,
      table,
    }),
  },
  //
  // add providers above
];
