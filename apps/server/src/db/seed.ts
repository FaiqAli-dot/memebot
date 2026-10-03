import { env } from '../config/env.js';
import { migrate } from './migrate.js';
import { ensureDefaultPortfolio } from '../services/portfolio-service.js';
import { closePool, query } from './client.js';
import { logger } from '../utils/logger.js';
import { defaultPortfolioSettings } from '../engines/risk/engine.js';

async function seed(): Promise<void> {
  await migrate();
  await ensureDefaultPortfolio();
  const settings = defaultPortfolioSettings();
  await query(
    `UPDATE user_portfolios SET settings = $2, bot_status = 'RUNNING' WHERE id = $1`,
    [env.DEFAULT_PORTFOLIO_ID, JSON.stringify(settings)],
  );
  logger.info('Seed complete — default portfolio ready, bot RUNNING');
}

seed()
  .then(async () => {
    await closePool();
    process.exit(0);
  })
  .catch(async (err) => {
    logger.error(err);
    await closePool();
    process.exit(1);
  });
