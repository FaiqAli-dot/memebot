/**
 * Production entry for single-service hosting: migrate once, then run the API and the worker
 * as two child processes. If either exits, stop the other and exit so the platform restarts both.
 */
import { fork, type ChildProcess } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from './db/migrate.js';
import { closePool, query } from './db/client.js';
import { env } from './config/env.js';
import { logger } from './utils/logger.js';

const here = dirname(fileURLToPath(import.meta.url));

async function capWal(maxWalSize: string): Promise<void> {
  try {
    await query(`ALTER SYSTEM SET max_wal_size = '${maxWalSize}'`);
    await query(`ALTER SYSTEM SET min_wal_size = '32MB'`);
    await query(`ALTER SYSTEM SET wal_compression = on`);
    await query(`SELECT pg_reload_conf()`);
    logger.info({ maxWalSize }, 'Postgres WAL capped');
  } catch (err) {
    logger.warn({ err }, 'Could not cap Postgres WAL (needs superuser); continuing');
  }
}

/** Hosted Postgres can still be starting or recovering when the app boots. */
async function waitForDatabase(timeoutMs = 180_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (let attempt = 1; ; attempt++) {
    try {
      await query('SELECT 1');
      return;
    } catch (err) {
      if (Date.now() > deadline) throw err;
      const e = err as { code?: string; message?: string };
      logger.warn({ attempt, reason: e.message || e.code }, 'Database not ready; retrying in 5s');
      await new Promise((r) => setTimeout(r, 5_000));
    }
  }
}

async function main(): Promise<void> {
  await waitForDatabase();
  await migrate();
  if (env.DB_MAX_WAL_SIZE) await capWal(env.DB_MAX_WAL_SIZE);
  await closePool();

  const children: ChildProcess[] = ['index.js', 'worker.js'].map((file) => fork(join(here, file)));
  let stopping = false;
  const stopAll = (code: number) => {
    if (stopping) return;
    stopping = true;
    for (const c of children) if (c.exitCode == null) c.kill('SIGTERM');
    setTimeout(() => process.exit(code), 5_000).unref();
  };
  for (const c of children) {
    c.on('exit', (code) => {
      logger.error({ pid: c.pid, code }, 'Child process exited; stopping');
      stopAll(code ?? 1);
    });
  }
  process.on('SIGTERM', () => stopAll(0));
  process.on('SIGINT', () => stopAll(0));
}

main().catch((err) => {
  logger.error(err);
  process.exit(1);
});
