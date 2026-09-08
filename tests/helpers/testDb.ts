import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PGlite } from '@electric-sql/pglite';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';

import type { Db } from '../../src/db/client.js';
import * as schema from '../../src/db/schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, '../../src/db/migrations');

/** In-memory Postgres for tests, with the real SQL migrations applied. */
export async function createTestDb(): Promise<Db> {
  const pglite = new PGlite();
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
    await pglite.exec(sql);
  }
  // PGlite's drizzle instance is structurally identical for our query usage.
  return drizzlePglite(pglite, { schema }) as unknown as Db;
}

export { schema };