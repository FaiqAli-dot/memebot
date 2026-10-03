/**
 * Production entry for single-service hosting: migrate once, then run the API and the worker
 * as two child processes. If either exits, stop the other and exit so the platform restarts both.
 */
import { fork, type ChildProcess } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from './db/migrate.js';
import { closePool } from './db/client.js';
import { logger } from './utils/logger.js';

const here = dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  await migrate();
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
