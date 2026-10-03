import { Router } from 'express';
import {
  botControlSchema,
  resetSchema,
  portfolioSettingsSchema,
  scannerQuerySchema,
  botEventsQuerySchema,
} from '@memebot/shared';
import { env } from '../../config/env.js';
import {
  ensureDefaultPortfolio,
  getPortfolio,
  getPortfolioSettings,
  updatePortfolioSettings,
  setBotStatus,
  resetPaperAccount,
  resetAllSimulationData,
} from '../../services/portfolio-service.js';
import {
  getBotStatus,
  getScannerRows,
  getPositions,
  getTrades,
  getTradeDetail,
  getEquityHistory,
  getBotEvents,
  getAnalytics,
  getStrategyLab,
  getTokenDetail,
  meta,
} from '../../services/query-service.js';
import { logBotEvent } from '../../services/token-service.js';
import { publish } from '../../ws/hub.js';

export const apiRouter = Router();

function portfolioId(): string {
  return env.DEFAULT_PORTFOLIO_ID;
}

apiRouter.get('/health', (_req, res) => {
  res.json({ ok: true, dataMode: meta().dataMode });
});

apiRouter.get('/meta', (_req, res) => {
  res.json(meta());
});

apiRouter.get('/fees/sol-price', async (_req, res, next) => {
  try {
    const { createProviders } = await import('../../providers/index.js');
    const providers = createProviders();
    const quote = await providers.solPrice.getSolPriceUsd();
    const gas = await providers.gasFee.getFeeEstimate();
    res.json({
      solPriceUsd: quote?.priceUsd ?? null,
      source: quote?.source ?? null,
      observedAt: quote?.observedAt?.toISOString() ?? null,
      stale: quote?.stale ?? true,
      usable: gas.usable,
      dataMode: meta().dataMode,
      note:
        meta().dataMode === 'demo'
          ? 'DEMO DATA — deterministic SOL/USD for fee conversion (not a live market price).'
          : 'Live SOL/USD from DexScreener (primary) with CoinGecko fallback. Stale/unavailable blocks new paper trades.',
    });
  } catch (err) {
    next(err);
  }
});

apiRouter.get('/portfolio', async (_req, res, next) => {
  try {
    await ensureDefaultPortfolio();
    const p = await getPortfolio(portfolioId());
    res.json(p);
  } catch (err) {
    next(err);
  }
});

apiRouter.get('/bot/status', async (_req, res, next) => {
  try {
    await ensureDefaultPortfolio();
    res.json(await getBotStatus(portfolioId()));
  } catch (err) {
    next(err);
  }
});

apiRouter.post('/bot/control', async (req, res, next) => {
  try {
    const body = botControlSchema.parse(req.body);
    await ensureDefaultPortfolio();
    const status = body.action === 'start' ? 'RUNNING' : 'PAUSED';
    await setBotStatus(portfolioId(), status);
    await logBotEvent({
      portfolioId: portfolioId(),
      level: 'info',
      category: 'control',
      message: status === 'RUNNING' ? 'Bot started' : 'Bot paused',
    });
    const info = await getBotStatus(portfolioId());
    publish('bot_status', info);
    res.json(info);
  } catch (err) {
    next(err);
  }
});

apiRouter.post('/bot/reset', async (req, res, next) => {
  try {
    const body = resetSchema.parse(req.body);
    await ensureDefaultPortfolio();
    if (body.scope === 'paper_account') {
      await resetPaperAccount(portfolioId());
      await logBotEvent({
        portfolioId: portfolioId(),
        level: 'warn',
        category: 'control',
        message: 'Paper account reset',
      });
    } else {
      await resetAllSimulationData(portfolioId());
      await logBotEvent({
        portfolioId: portfolioId(),
        level: 'warn',
        category: 'control',
        message: 'All simulation data reset',
      });
    }
    publish('portfolio_updated', await getPortfolio(portfolioId()));
    publish('bot_status', await getBotStatus(portfolioId()));
    res.json({ ok: true, portfolio: await getPortfolio(portfolioId()) });
  } catch (err) {
    next(err);
  }
});

apiRouter.get('/settings', async (_req, res, next) => {
  try {
    await ensureDefaultPortfolio();
    res.json(await getPortfolioSettings(portfolioId()));
  } catch (err) {
    next(err);
  }
});

apiRouter.put('/settings', async (req, res, next) => {
  try {
    const body = portfolioSettingsSchema.parse(req.body);
    await ensureDefaultPortfolio();
    const { strategyParams, ...rest } = body;
    const updated = await updatePortfolioSettings(portfolioId(), {
      ...rest,
      ...(strategyParams
        ? {
            strategyParams: {
              ...(await getPortfolioSettings(portfolioId())).strategyParams,
              ...strategyParams,
            },
          }
        : {}),
    });
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

apiRouter.get('/scanner', async (req, res, next) => {
  try {
    const q = scannerQuerySchema.parse(req.query);
    res.json({
      rows: await getScannerRows(q),
      scoreDisclaimer: meta().scoreDisclaimer,
      dataMode: meta().dataMode,
    });
  } catch (err) {
    next(err);
  }
});

apiRouter.get('/tokens/:id', async (req, res, next) => {
  try {
    const detail = await getTokenDetail(req.params.id);
    if (!detail) {
      res.status(404).json({ error: 'Token not found' });
      return;
    }
    res.json(detail);
  } catch (err) {
    next(err);
  }
});

apiRouter.get('/positions', async (req, res, next) => {
  try {
    const status =
      req.query.status === 'OPEN' || req.query.status === 'CLOSED'
        ? req.query.status
        : undefined;
    res.json(await getPositions(portfolioId(), status));
  } catch (err) {
    next(err);
  }
});

apiRouter.get('/trades', async (_req, res, next) => {
  try {
    res.json(await getTrades(portfolioId()));
  } catch (err) {
    next(err);
  }
});

apiRouter.get('/trades/:id', async (req, res, next) => {
  try {
    const detail = await getTradeDetail(portfolioId(), req.params.id);
    if (!detail) {
      res.status(404).json({ error: 'Trade not found' });
      return;
    }
    res.json(detail);
  } catch (err) {
    next(err);
  }
});

apiRouter.get('/equity', async (_req, res, next) => {
  try {
    res.json(await getEquityHistory(portfolioId()));
  } catch (err) {
    next(err);
  }
});

apiRouter.get('/events', async (req, res, next) => {
  try {
    const q = botEventsQuerySchema.parse(req.query);
    res.json(await getBotEvents(portfolioId(), q));
  } catch (err) {
    next(err);
  }
});

apiRouter.get('/analytics', async (_req, res, next) => {
  try {
    res.json({
      ...(await getAnalytics(portfolioId())),
      scoreDisclaimer: meta().scoreDisclaimer,
    });
  } catch (err) {
    next(err);
  }
});

apiRouter.get('/strategies', async (_req, res, next) => {
  try {
    res.json({
      strategies: await getStrategyLab(portfolioId()),
      scoreDisclaimer: meta().scoreDisclaimer,
      note: 'Comparison only — no strategy is labeled best unless you choose a sort metric.',
    });
  } catch (err) {
    next(err);
  }
});
