import { Router, type NextFunction, type Response } from 'express';
import { z } from 'zod';
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
  getLivePositions,
  getTrades,
  getFailedOrders,
  getTradeDetail,
  getEquityHistory,
  getBotEvents,
  getAnalytics,
  getStrategyLab,
  getTokenDetail,
  getShadowTrades,
  getMissedOpportunities,
  getRegimeHistory,
  getSystemHealth,
  meta,
} from '../../services/query-service.js';
import { getBotReadiness } from '../../services/readiness-service.js';
import { getLearningStatus } from '../../learning/status-service.js';
import { getWeek1Overview } from '../../services/week1-service.js';
import { rollbackCalibration } from '../../learning/calibration-service.js';
import { logBotEvent } from '../../services/token-service.js';
import { publish } from '../../ws/hub.js';
import {
  ReportError,
  generateDailyReport,
  getReport,
  listReports,
  rollbackReport,
} from '../../services/report-service.js';
import { setKillSwitch } from '../../monitoring/kill-switch.js';
import { createStrategyCatalog } from '../../strategies/catalog.js';
import { DEFAULT_CONFIG_ENTRIES } from '../../domain/config-registry.js';
import { buildWalkForwardPlan } from '../../backtest/walk-forward.js';

export const apiRouter = Router();

const reportIdSchema = z.string().uuid();

function portfolioId(): string {
  return env.DEFAULT_PORTFOLIO_ID;
}

apiRouter.get('/health', async (_req, res, next) => {
  try {
    res.json({ ok: true, ...(await getSystemHealth()) });
  } catch (err) {
    next(err);
  }
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

apiRouter.get('/bot/readiness', async (_req, res, next) => {
  try {
    await ensureDefaultPortfolio();
    res.json(await getBotReadiness(portfolioId()));
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
    res.json(await updatePortfolioSettings(portfolioId(), body));
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

apiRouter.get('/positions/live', async (_req, res, next) => {
  try {
    res.json(await getLivePositions(portfolioId()));
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

apiRouter.get('/trades/failed', async (_req, res, next) => {
  try {
    res.json(await getFailedOrders(portfolioId()));
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

function sendReportError(err: unknown, res: Response, next: NextFunction): void {
  if (err instanceof ReportError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  next(err);
}

apiRouter.get('/reports', async (_req, res, next) => {
  try {
    res.json({
      reports: await listReports(portfolioId()),
      reportTime: env.REPORT_TIME,
      reportTimezone: env.REPORT_TIMEZONE,
      learningEnabled: env.LEARNING_ENABLED,
      minTrades: env.LEARNING_MIN_TRADES,
      dataMode: meta().dataMode,
    });
  } catch (err) {
    next(err);
  }
});

apiRouter.post('/reports/run', async (_req, res, next) => {
  try {
    await ensureDefaultPortfolio();
    const { report } = await generateDailyReport(portfolioId(), { force: true });
    res.json(report);
  } catch (err) {
    sendReportError(err, res, next);
  }
});

apiRouter.get('/reports/:id', async (req, res, next) => {
  try {
    const id = reportIdSchema.parse(req.params.id);
    const report = await getReport(id);
    if (!report) {
      res.status(404).json({ error: 'Report not found' });
      return;
    }
    res.json(report);
  } catch (err) {
    next(err);
  }
});

apiRouter.post('/reports/:id/rollback', async (req, res, next) => {
  try {
    res.json(await rollbackReport(reportIdSchema.parse(req.params.id)));
  } catch (err) {
    sendReportError(err, res, next);
  }
});

apiRouter.get('/learning/status', async (_req, res, next) => {
  try {
    res.json(await getLearningStatus());
  } catch (err) {
    next(err);
  }
});

apiRouter.get('/week1/overview', async (req, res, next) => {
  try {
    const hours = z.coerce.number().positive().max(24 * 30).default(24).parse(req.query.hours);
    res.json(await getWeek1Overview(hours));
  } catch (err) {
    next(err);
  }
});

const rollbackSchema = z.object({ reason: z.string().min(3).max(500) });

/** Operator action only — calibrations are never rolled back automatically after losses. */
apiRouter.post('/learning/calibrations/:strategyId/rollback', async (req, res, next) => {
  try {
    const strategyId = z.string().min(1).max(100).parse(req.params.strategyId);
    const { reason } = rollbackSchema.parse(req.body ?? {});
    res.json(await rollbackCalibration(strategyId, 'operator', reason));
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status) {
      res.status(status).json({ error: (err as Error).message });
      return;
    }
    next(err);
  }
});

apiRouter.get('/shadow-trades', async (_req, res, next) => {
  try {
    res.json({
      rows: await getShadowTrades(portfolioId()),
      note: 'Hypothetical outcomes for rejected opportunities — not real fills.',
    });
  } catch (err) {
    next(err);
  }
});

apiRouter.get('/missed-opportunities', async (_req, res, next) => {
  try {
    res.json({ rows: await getMissedOpportunities(portfolioId()) });
  } catch (err) {
    next(err);
  }
});

apiRouter.get('/intelligence', async (_req, res, next) => {
  try {
    const { getIntelligenceDashboard } = await import('../../intelligence/query.js');
    res.json(await getIntelligenceDashboard());
  } catch (err) {
    next(err);
  }
});

apiRouter.get('/intelligence/tokens', async (req, res, next) => {
  try {
    const { listIntelligenceTokens } = await import('../../intelligence/query.js');
    const q = req.query;
    const num = (v: unknown) =>
      v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined;
    const result = await listIntelligenceTokens({
      q: typeof q.q === 'string' ? q.q : undefined,
      discoverySource: typeof q.discoverySource === 'string' ? q.discoverySource : undefined,
      venue: typeof q.venue === 'string' ? q.venue : undefined,
      status: typeof q.status === 'string' ? q.status : undefined,
      rejectionReason: typeof q.rejectionReason === 'string' ? q.rejectionReason : undefined,
      traded:
        q.traded === 'yes' || q.traded === 'no' || q.traded === 'all'
          ? q.traded
          : 'all',
      signalGenerated:
        q.signalGenerated === 'yes' || q.signalGenerated === 'no' || q.signalGenerated === 'all'
          ? q.signalGenerated
          : 'all',
      minLiquidity: num(q.minLiquidity),
      maxLiquidity: num(q.maxLiquidity),
      minMarketCap: num(q.minMarketCap),
      maxMarketCap: num(q.maxMarketCap),
      from: typeof q.from === 'string' ? q.from : undefined,
      to: typeof q.to === 'string' ? q.to : undefined,
      limit: num(q.limit),
      offset: num(q.offset),
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

apiRouter.get('/intelligence/tokens/:id', async (req, res, next) => {
  try {
    const { getIntelligenceTokenDetail } = await import('../../intelligence/query.js');
    const detail = await getIntelligenceTokenDetail(String(req.params.id));
    if (!detail) {
      res.status(404).json({ error: 'Token not found' });
      return;
    }
    res.json(detail);
  } catch (err) {
    next(err);
  }
});

const storageReport = async (_req: unknown, res: Response, next: NextFunction) => {
  try {
    const { getStorageMonitor } = await import('../../intelligence/storage.js');
    res.json(await getStorageMonitor());
  } catch (err) {
    next(err);
  }
};
apiRouter.get('/storage', storageReport);
apiRouter.get('/intelligence/storage', storageReport);

apiRouter.get('/intelligence/sources', async (_req, res, next) => {
  try {
    const { listSourceHealth } = await import('../../intelligence/source-health.js');
    const { getMeteoraDbcHealth } = await import('../../intelligence/meteora-dbc-health.js');
    res.json({
      sources: await listSourceHealth(),
      meteoraDbc: await getMeteoraDbcHealth(),
    });
  } catch (err) {
    next(err);
  }
});

apiRouter.get('/intelligence/missed', async (_req, res, next) => {
  try {
    const { getMissedOpportunityAnalysis } = await import('../../intelligence/query.js');
    res.json(await getMissedOpportunityAnalysis());
  } catch (err) {
    next(err);
  }
});

apiRouter.get('/regimes', async (_req, res, next) => {
  try {
    res.json({ rows: await getRegimeHistory() });
  } catch (err) {
    next(err);
  }
});

apiRouter.get('/strategies/catalog', (_req, res) => {
  const catalog = createStrategyCatalog().map((s) => ({
    id: s.id,
    name: s.name,
    version: s.version,
    activeByDefault: s.activeByDefault,
  }));
  res.json({ strategies: catalog, note: 'Entry strategies never emit SELL.' });
});

apiRouter.get('/config', (_req, res) => {
  res.json({ entries: DEFAULT_CONFIG_ENTRIES });
});

apiRouter.get('/experiments/walk-forward-plan', (_req, res) => {
  const plan = buildWalkForwardPlan({ start: new Date(Date.now() - 35 * 86_400_000) });
  res.json({
    plan,
    note: 'Learning must never use future data. OOS window is untouched.',
  });
});

apiRouter.post('/bot/kill-switch', async (req, res, next) => {
  try {
    const body = z
      .object({ active: z.boolean(), reason: z.string().max(64).optional() })
      .parse(req.body);
    await ensureDefaultPortfolio();
    await setKillSwitch(
      portfolioId(),
      body.active,
      (body.reason as 'manual_kill_switch') ?? 'manual_kill_switch',
    );
    const info = await getBotStatus(portfolioId());
    publish('kill_switch', { active: body.active });
    publish('bot_status', info);
    res.json(info);
  } catch (err) {
    next(err);
  }
});

apiRouter.get('/safety/:tokenId', async (req, res, next) => {
  try {
    const { query } = await import('../../db/client.js');
    const { rows } = await query(
      `SELECT * FROM safety_assessments WHERE token_id = $1 ORDER BY assessed_at DESC LIMIT 10`,
      [req.params.tokenId],
    );
    res.json({ assessments: rows });
  } catch (err) {
    next(err);
  }
});
