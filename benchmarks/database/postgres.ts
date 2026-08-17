import { Pool } from 'pg';
import type { DatabaseClient, DatabaseDocument } from './types.js';

const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

function quoteIdentifier(identifier: string): string {
  if (!IDENTIFIER_PATTERN.test(identifier)) {
    throw new Error(
      `Invalid database table name "${identifier}"; use letters, numbers, and underscores`,
    );
  }
  return `"${identifier}"`;
}

export function createPostgresClient(
  options: { connectionString?: string; table: string },
): DatabaseClient {
  const { connectionString, table: tableName } = options;
  if (!connectionString) {
    throw new Error('DATABASE_POSTGRES_URL is required');
  }

  const table = quoteIdentifier(tableName);
  const pool = new Pool({ connectionString, max: 1 });

  return {
    async setup() {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS ${table} (
          id text primary key,
          name text not null,
          payload text not null,
          version integer not null,
          updated_at timestamptz not null default now()
        )
      `);
    },

    async create(doc: DatabaseDocument) {
      await pool.query(
        `INSERT INTO ${table} (id, name, payload, version) VALUES ($1, $2, $3, $4)`,
        [doc.id, doc.name, doc.payload, doc.version],
      );
    },

    async read(id: string) {
      const result = await pool.query<DatabaseDocument>(
        `SELECT id, name, payload, version FROM ${table} WHERE id = $1`,
        [id],
      );
      return result.rows[0] ?? null;
    },

    async update(id: string, patch: Pick<DatabaseDocument, 'name' | 'payload' | 'version'>) {
      await pool.query(
        `UPDATE ${table}
         SET name = $1, payload = $2, version = $3, updated_at = now()
         WHERE id = $4`,
        [patch.name, patch.payload, patch.version, id],
      );
    },

    async delete(id: string) {
      const result = await pool.query(`DELETE FROM ${table} WHERE id = $1`, [id]);
      return result.rowCount ?? 0;
    },

    async close() {
      await pool.end();
    },
  };
}
