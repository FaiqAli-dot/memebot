import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { config as loadEnv } from 'dotenv';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(__dirname, '../../../../.env') });

process.env.DATA_MODE = 'demo';
process.env.LEARNING_ENABLED = 'true';
process.env.LEARNING_MIN_TRADES = '20';
process.env.MIN_NEW_OBSERVATIONS_FOR_LEARNING = '20';
process.env.LEARNING_INTERVAL_HOURS = '0.001';
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  'postgresql://memebot:memebot@localhost:5432/memebot_test';

describe('integration: daily learning report', () => {
  let query: typeof import('../../src/db/client.js').query;
  let closePool: typeof import('../../src/db/client.js').closePool;
  let reports: typeof import('../../src/services/report-service.js');
  let getPortfolioSettings: typeof import('../../src/services/portfolio-service.js').getPortfolioSettings;
  let portfolioId: string;
  const now = new Date();
  let reportDate: string;

  beforeAll(async () => {
    const { migrate } = await import('../../src/db/migrate.js');
    ({ query, closePool } = await import('../../src/db/client.js'));
    reports = await import('../../src/services/report-service.js');
    const portfolio = await import('../../src/services/portfolio-service.js');
    getPortfolioSettings = portfolio.getPortfolioSettings;
    const { upsertDiscoveredToken } = await import('../../src/services/token-service.js');

    await migrate(process.env.DATABASE_URL);
    await query(`
      TRUNCATE calibration_activations, calibration_versions, calibration_runs, learning_anomalies,
               learning_health_checks, trade_observations, daily_reports, paper_fills, fee_records, paper_orders, positions, portfolio_snapshots,
               bot_events, signals, strategy_runs, holder_snapshots, liquidity_snapshots,
               market_snapshots, token_snapshots, tokens, user_portfolios CASCADE
    `);
    portfolioId = await portfolio.ensureDefaultPortfolio();
    reportDate = reports.localDateTime(now, process.env.REPORT_TIMEZONE ?? 'Asia/Dubai').date;

    const tokenId = await upsertDiscoveredToken({
      chain: 'solana',
      address: 'DemoLearning11111111111111111111111111',
      symbol: 'LRN',
      name: 'Learning Token',
      decimals: 9,
      createdAt: new Date(Date.now() - 3 * 3600_000),
    });

    // Interleaved losers just above the 1.5% momentum limit and winners well above it, so the
    // older 70% proposes the lesson and the newer unseen 30% can confirm it.
    const seed = Array.from({ length: 60 }, (_, i) =>
      i % 2 === 0
        ? { change: 1.55, pnl: -0.4, reason: 'stop_loss' }
        : { change: 6, pnl: 0.6, reason: 'take_profit' },
    );
    for (const [i, t] of seed.entries()) {
      const { rows } = await query<{ id: string }>(
        `INSERT INTO signals (token_id, strategy_name, strategy_version, side, overall_score,
           risk_label, market_state, data_mode)
         VALUES ($1, 'Momentum Scanner v1', '1.0.0', 'BUY', 70, 'MODERATE', $2, 'demo') RETURNING id`,
        [
          tokenId,
          JSON.stringify({
            priceUsd: 1,
            priceChange5mPct: t.change,
            buyVolume5mUsd: 6000,
            sellVolume5mUsd: 3000,
            volume5mUsd: 9000,
            priorVolume5mUsd: 5000,
            liquidityUsd: 30000,
            txCount5m: 40,
            topHolderPct: 12,
            ageMinutes: 90,
          }),
        ],
      );
      const closedAt = new Date(now.getTime() - (i + 1) * 1000);
      const openedAt = new Date(closedAt.getTime() - 120_000);
      // True entry snapshot: core features observed before entry + the exact strategy inputs
      const snapshot = {
        features: {
          observedAt: new Date(openedAt.getTime() - 2000).toISOString(),
          quoteAgeMs: 800,
          liquidityUsd: 30000,
          priceChange5mPct: t.change,
          volume5mUsd: 9000,
          strategyInputs: {
            priceChange5mPct: t.change,
            buySellRatio: 2,
            volumeAcceleration: 1.8,
            liquidityUsd: 30000,
            txCount5m: 40,
            volume5mUsd: 9000,
            overallScore: 70,
            topHolderPct: 12,
            ageMinutes: 90,
          },
        },
      };
      await query(
        `INSERT INTO positions (
           portfolio_id, token_id, entry_signal_id, status, quantity, entry_price_usd,
           current_price_usd, cost_basis_usd, current_value_usd, realized_pnl_usd, net_pnl_usd,
           gross_pnl_usd, stop_loss_pct, take_profit_pct, highest_price_usd, entry_costs,
           exit_costs, close_reason, opened_at, closed_at, data_mode, strategy_key, entry_snapshot
         ) VALUES ($1,$2,$3,'CLOSED',0,1,1,5,0,$4,$4,$4,0.08,0.2,1.05,$5,$5,$6,$7,$8,'demo','momentum-breakout',$9)`,
        [
          portfolioId,
          tokenId,
          rows[0]!.id,
          t.pnl,
          JSON.stringify({ totalCostUsd: 0.05 }),
          t.reason,
          openedAt,
          closedAt,
          JSON.stringify(snapshot),
        ],
      );
    }
    // Backfilled trades (no entry snapshot) that contradict the lesson: losers far above the limit.
    // If backfill leaked into lessons, the "rest" win rate would drop and the counts would include them.
    for (let i = 0; i < 6; i++) {
      const closedAt = new Date(now.getTime() - (100 + i) * 1000);
      await query(
        `INSERT INTO positions (
           portfolio_id, token_id, status, quantity, entry_price_usd, current_price_usd, cost_basis_usd,
           current_value_usd, realized_pnl_usd, net_pnl_usd, gross_pnl_usd, stop_loss_pct, take_profit_pct,
           highest_price_usd, entry_costs, exit_costs, close_reason, opened_at, closed_at, data_mode, strategy_key
         ) VALUES ($1,$2,'CLOSED',0,1,0.9,5,0,-0.5,-0.5,-0.5,0.08,0.2,1,$3,$3,'stop_loss',$4,$5,'demo','momentum-breakout')`,
        [portfolioId, tokenId, JSON.stringify({ totalCostUsd: 0.05 }), new Date(closedAt.getTime() - 120_000), closedAt],
      );
    }
    const { recordMissingObservations } = await import('../../src/learning/observations.js');
    await recordMissingObservations(1000);
  }, 60_000);

  afterAll(async () => {
    await closePool();
  });

  it('generates a report, applies a strategy-scoped lesson from true snapshots only, and is idempotent', async () => {
    const { env } = await import('../../src/config/env.js');
    env.LEARNING_OBSERVATION_MODE = false;
    const before = await getPortfolioSettings(portfolioId);
    expect(before.strategyParams['momentum-breakout']!.minPriceChange5mPct).toBe(1.5);

    const first = await reports.generateDailyReport(portfolioId, { reportDate, now });
    expect(first.created).toBe(true);
    expect(first.report.summary.tradeCount).toBe(66);
    expect(first.report.importantTrades.length).toBeGreaterThan(0);

    const dq = first.report.analysis.dataQuality!;
    expect(dq.trueEntrySnapshots).toBe(60);
    expect(dq.signalBackfills).toBe(6);
    expect(dq.calibrationEligible).toBe(60);

    const lesson = first.report.lessons.find((l) => l.param === 'minPriceChange5mPct');
    expect(lesson?.status).toBe('applied');
    expect(lesson?.strategyId).toBe('momentum-breakout');
    expect(lesson?.to).toBeCloseTo(1.65, 5);
    expect(lesson!.trainingSampleCount! + lesson!.validationSampleCount!).toBe(60);
    expect(lesson!.trainingSampleCount).toBe(42);
    expect(lesson!.trainingMetrics!.restWinRatePct).toBe(100);
    expect(lesson!.validationMetrics!.bandTrades).toBeGreaterThanOrEqual(8);
    expect(first.report.applied).toBe(true);
    // Exit evidence mixes strategies: reported, never applied
    for (const l of first.report.lessons.filter((x) => !x.strategyId && x.param !== 'all')) {
      expect(l.status).toBe('portfolio_scope');
    }
    expect(first.report.analysis.strategies!.find((s) => s.strategyId === 'momentum-breakout')!.window.trades).toBe(66);

    const after = await getPortfolioSettings(portfolioId);
    expect(after.strategyParams['momentum-breakout']!.minPriceChange5mPct).toBeCloseTo(1.65, 5);
    // Only the owning strategy changed: Liquidity Expansion also has minPriceChange5mPct
    expect(after.strategyParams['liquidity-expansion']).toEqual(before.strategyParams['liquidity-expansion']);
    expect(after.strategyParams['early-volume-expansion']).toEqual(before.strategyParams['early-volume-expansion']);
    expect(after.stopLossPct).toBe(before.stopLossPct);
    expect(after.maxPositionPct).toBe(before.maxPositionPct);

    const second = await reports.generateDailyReport(portfolioId, { reportDate, now });
    expect(second.created).toBe(false);
    expect(second.report.id).toBe(first.report.id);
    const count = await query<{ c: string }>(`SELECT COUNT(*)::text AS c FROM daily_reports`);
    expect(count.rows[0]!.c).toBe('1');
  });

  it('refuses to regenerate a report that changed settings until it is rolled back', async () => {
    await expect(
      reports.generateDailyReport(portfolioId, { reportDate, now, force: true }),
    ).rejects.toMatchObject({ status: 409 });

    const [listed] = await reports.listReports(portfolioId);
    const rolled = await reports.rollbackReport(listed!.id);
    expect(rolled.rolledBackAt).not.toBeNull();
    expect((await getPortfolioSettings(portfolioId)).strategyParams['momentum-breakout']!.minPriceChange5mPct).toBe(1.5);

    await expect(reports.rollbackReport(listed!.id)).rejects.toMatchObject({ status: 409 });
  });

  it('LEARNING_OBSERVATION_MODE validates the same lesson but changes nothing and promotes nothing', async () => {
    const { env } = await import('../../src/config/env.js');
    env.LEARNING_OBSERVATION_MODE = true;
    // Fresh calibration interval so the gate passes again on the same observations
    await query(`TRUNCATE calibration_activations, calibration_versions, calibration_runs CASCADE`);
    const before = JSON.stringify(await getPortfolioSettings(portfolioId));

    const regenerated = await reports.generateDailyReport(portfolioId, { reportDate, now, force: true });
    expect(regenerated.created).toBe(true);
    const r = regenerated.report;
    expect(r.analysis.mode).toMatchObject({
      banner: 'PAPER TRADING — WEEK 1 OBSERVATION MODE',
      liveExecution: 'DISABLED',
      automaticStrategyPromotion: 'DISABLED',
      tradingMode: 'PAPER',
    });
    const lesson = r.lessons.find((l) => l.param === 'minPriceChange5mPct')!;
    expect(lesson.status).toBe('validated_not_applied');
    expect(lesson.strategyId).toBe('momentum-breakout');
    expect(r.applied).toBe(false);
    expect(JSON.stringify(await getPortfolioSettings(portfolioId))).toBe(before);
    expect((await query(`SELECT 1 FROM calibration_activations`)).rows).toHaveLength(0);
    expect((await query(`SELECT 1 FROM calibration_versions WHERE status = 'PROMOTED'`)).rows).toHaveLength(0);
  });

  it('says calibration was skipped instead of substituting backfill when true snapshots are insufficient', async () => {
    await query(`DELETE FROM daily_reports`);
    // The previous run consumed every true snapshot; only backfill would be "new"
    const r = (await reports.generateDailyReport(portfolioId, { reportDate, now, force: true })).report;
    const note = r.lessons.find((l) => l.param === 'all')!;
    expect(note.status).toBe('skipped');
    expect(note.reason).toMatch(/^Calibration skipped: Insufficient TRUE_ENTRY_SNAPSHOT observations/);
    expect(r.lessons.some((l) => l.param === 'minPriceChange5mPct')).toBe(false);
  });

  it('only runs on schedule after the report time', async () => {
    await query(`DELETE FROM daily_reports`);
    const tz = process.env.REPORT_TIMEZONE ?? 'Asia/Dubai';
    const local = reports.localDateTime(now, tz);
    const { env } = await import('../../src/config/env.js');
    const due = reports.isReportDue(now, tz, env.REPORT_TIME);
    await reports.runDailyReportIfDue(portfolioId, now);
    const { rows } = await query<{ report_date: string }>(
      `SELECT report_date::text AS report_date FROM daily_reports`,
    );
    expect(rows.length).toBe(due ? 1 : 0);
    if (due) expect(rows[0]!.report_date).toBe(local.date);
  });
});
