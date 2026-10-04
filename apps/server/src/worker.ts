import { migrate } from './db/migrate.js';
import { ensureDefaultPortfolio } from './services/portfolio-service.js';
import { registerAllJobs, startJobs, stopJobs } from './jobs/runners.js';
import { closePool } from './db/client.js';
import { logger } from './utils/logger.js';
import { env } from './config/env.js';
import { logBotEvent } from './services/token-service.js';
import { refreshStorageState, stateRank } from './db/storage-guard.js';
import { pruneOldData } from './db/retention.js';

/**
 * Before any collection starts: measure the volume and clean up if it is already filling.
 * Research writes stay paused while the state is STOP_NON_ESSENTIAL_WRITES; trading continues.
 */
async function protectStorageOnStartup(): Promise<void> {
  try {
    const before = await refreshStorageState();
    if (stateRank(before.state) >= stateRank('WARNING')) {
      await pruneOldData(new Date(), before.state);
      const after = await refreshStorageState();
      logger.warn(
        { before: before.state, after: after.state, usedMb: Math.round(after.usedBytes / 1048576) },
        'Startup storage cleanup',
      );
    }
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'Startup storage check failed; continuing');
  }
}

async function main(): Promise<void> {
  await migrate();
  await protectStorageOnStartup();
  const portfolioId = await ensureDefaultPortfolio();
  registerAllJobs();
  startJobs();
  await logBotEvent({
    portfolioId,
    level: 'info',
    category: 'worker',
    message: `Worker started in ${env.DATA_MODE} mode`,
  });
  logger.info({ dataMode: env.DATA_MODE }, 'MemeBot worker running');

  const shutdown = async () => {
    logger.info('Shutting down worker');
    stopJobs();
    await closePool();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((err) => {
  logger.error(err);
  process.exit(1);
});
