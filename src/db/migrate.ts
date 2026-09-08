import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

import { loadEnv } from '../config/env.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

/**
 * Apply pending SQL migrations inside transactions, recording each in
 * `_migrations`. Idempotent — safe to run at every startup.
 */
export async function runMigrations(databaseUrl?: string): Promise<string[]> {
  const env = loadEnv();
  const pool = new pg.Pool({ connectionString: databaseUrl ?? env.DATABASE_URL });
  const applied: string[] = [];
  try {
    await pool.query(
      `CREATE TABLE IF NOT EXISTS _migrations (
         name TEXT PRIMARY KEY,
         applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
       )`,
    );
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      const { rowCount } = await pool.query('SELECT 1 FROM _migrations WHERE name = $1', [file]);
      if (rowCount && rowCount > 0) {
        continue;
      }
      const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO _migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(e as Error).message}`);
      } finally {
        client.release();
      }
      applied.push(file);
    }
    return applied;
  } finally {
    await pool.end();
  }
}

// `pnpm migrate` entry point
if (import.meta.url === `file://${process.argv[1]}`) {
  runMigrations()
    .then((applied) => {
      console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'No pending migrations');
      process.exit(0);
    })
    .catch((e) => {
      console.error(e.message);
      process.exit(1);
    });
}