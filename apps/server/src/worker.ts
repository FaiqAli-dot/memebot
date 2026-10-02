import { migrate } from './db/migrate.js';
import { ensureDefaultPortfolio } from './services/portfolio-service.js';
import { registerAllJobs, startJobs, stopJobs } from './jobs/runners.js';
import { closePool } from './db/client.js';
import { logger } from './utils/logger.js';
import { env } from './config/env.js';
import { logBotEvent } from './services/token-service.js';

async function main(): Promise<void> {
  await migrate();
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
