import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { createServer } from 'node:http';
import { env } from './config/env.js';
import { logger } from './utils/logger.js';
import { migrate } from './db/migrate.js';
import { ensureDefaultPortfolio } from './services/portfolio-service.js';
import { apiRouter } from './api/routes/index.js';
import { errorHandler, notFound } from './api/middleware/error.js';
import { attachWebSocket } from './ws/hub.js';
import { closePool } from './db/client.js';

async function main(): Promise<void> {
  await migrate();
  await ensureDefaultPortfolio();

  const app = express();
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(
    cors({
      origin: env.CORS_ORIGIN.split(',').map((s) => s.trim()),
      credentials: false,
    }),
  );
  app.use(express.json({ limit: '1mb' }));
  app.use(
    rateLimit({
      windowMs: env.API_RATE_LIMIT_WINDOW_MS,
      max: env.API_RATE_LIMIT_MAX,
      standardHeaders: true,
      legacyHeaders: false,
    }),
  );

  app.get('/', (_req, res) => {
    res.json({
      name: 'MemeBot API',
      subtitle: 'Meme Coin Paper Trading & Research',
      docs: '/api/meta',
      paperTradingOnly: true,
    });
  });

  app.use('/api', apiRouter);
  app.use(notFound);
  app.use(errorHandler);

  const server = createServer(app);
  attachWebSocket(server);

  server.listen(env.API_PORT, env.API_HOST, () => {
    logger.info(
      { port: env.API_PORT, dataMode: env.DATA_MODE },
      'MemeBot API listening',
    );
  });

  const shutdown = async () => {
    logger.info('Shutting down API');
    server.close();
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
