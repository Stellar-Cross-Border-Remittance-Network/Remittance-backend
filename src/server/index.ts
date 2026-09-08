import { loadEnv, resetEnvCache } from '../config/env.js';
import { closeDb, createDb } from '../db/client.js';
import { stellarAccounts } from '../db/schema.js';
import { runMigrations } from '../db/migrate.js';
import { createLogger } from '../lib/logger.js';
import { buildApp } from './app.js';
import { buildContainer } from './container.js';
import { initTracing } from './plugins/otel.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const logger = createLogger();
  initTracing(logger);

  logger.info({ network: env.NETWORK, node: process.version }, 'remittance-backend starting');

  // Apply migrations before serving traffic.
  const applied = await runMigrations();
  if (applied.length > 0) {
    logger.info({ applied }, 'database migrations applied');
  }

  const db = createDb();
  const container = buildContainer(db, logger);

  // SEP-1 discovery for well-known testnet anchors (best-effort).
  await container.anchors.seedKnownAnchors().catch((e) =>
    logger.warn({ err: (e as Error).message }, 'anchor seeding failed'),
  );

  const app = await buildApp(container);
  await app.listen({ port: env.PORT, host: env.HOST });

  // Streaming + jobs start after the HTTP server is up.
  await container.jobs.start();
  if (env.STREAM_ENABLED) {
    const accounts = (await db.select().from(stellarAccounts)).map((a) => a.public_key);
    await container.streamer.start(accounts);
    container.reconciler.start(accounts);
  }

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down');
    await container.streamer.stop().catch(() => undefined);
    container.reconciler.stop();
    await container.jobs.stop().catch(() => undefined);
    await app.close().catch(() => undefined);
    await closeDb(db).catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((e) => {
  // Re-parse env on the way out so the error is descriptive even if config
  // was the failure.
  try {
    resetEnvCache();
    loadEnv();
  } catch {
    // ignore
  }
  console.error('[fatal]', e instanceof Error ? e.message : e);
  process.exit(1);
});