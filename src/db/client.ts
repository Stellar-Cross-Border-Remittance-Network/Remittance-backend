import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';

import { loadEnv } from '../config/env.js';
import * as schema from './schema.js';

export type Db = NodePgDatabase<typeof schema>;
export { schema };

/**
 * Create the pg pool and drizzle instance. One pool per process.
 * Tests construct their own in-memory instance and cast to Db.
 */
export function createDb(databaseUrl?: string): Db {
  const env = loadEnv();
  const pool = new pg.Pool({
    connectionString: databaseUrl ?? env.DATABASE_URL,
    max: 10,
    connectionTimeoutMillis: 10_000,
  });
  pool.on('error', (err) => {
    // Prevent an idle-client error from crashing the process.
    console.error('[db] idle client error', err.message);
  });
  return drizzle(pool, { schema });
}

export async function closeDb(db: Db): Promise<void> {
  const pool = (db as unknown as { $client: pg.Pool }).$client;
  await pool.end();
}