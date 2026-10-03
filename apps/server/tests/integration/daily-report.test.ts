import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { config as loadEnv } from 'dotenv';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(__dirname, '../../../../.env') });

process.env.DATA_MODE = 'demo';
process.env.LEARNING_ENABLED = 'true';
process.env.LEARNING_MIN_TRADES = '20';
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
      TRUNCATE daily_reports, paper_fills, fee_records, paper_orders, positions, portfolio_snapshots,
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

    // 10 losers just above the 1.5% momentum limit, 12 winners well above it.
    const seed = [
      ...Array.from({ length: 10 }, () => ({ change: 1.55, pnl: -0.4, reason: 'stop_loss' })),
      ...Array.from({ length: 12 }, () => ({ change: 6, pnl: 0.6, reason: 'take_profit' })),
    ];
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
      await query(
        `INSERT INTO positions (
           portfolio_id, token_id, entry_signal_id, status, quantity, entry_price_usd,
           current_price_usd, cost_basis_usd, current_value_usd, realized_pnl_usd, net_pnl_usd,
           gross_pnl_usd, stop_loss_pct, take_profit_pct, highest_price_usd, entry_costs,
           exit_costs, close_reason, opened_at, closed_at, data_mode
         ) VALUES ($1,$2,$3,'CLOSED',0,1,1,5,0,$4,$4,$4,0.08,0.2,1.05,$5,$5,$6,$7,$8,'demo')`,
        [
          portfolioId,
          tokenId,
          rows[0]!.id,
          t.pnl,
          JSON.stringify({ totalCostUsd: 0.05 }),
          t.reason,
          new Date(closedAt.getTime() - 120_000),
          closedAt,
        ],
      );
    }
  }, 60_000);

  afterAll(async () => {
    await closePool();
  });

  it('generates a report, applies guarded lessons and is idempotent', async () => {
    const before = await getPortfolioSettings(portfolioId);
    expect(before.strategyParams.minPriceChange5mPct).toBe(1.5);

    const first = await reports.generateDailyReport(portfolioId, { reportDate, now });
    expect(first.created).toBe(true);
    expect(first.report.summary.tradeCount).toBe(22);
    expect(first.report.importantTrades.length).toBeGreaterThan(0);

    const lesson = first.report.lessons.find((l) => l.param === 'minPriceChange5mPct');
    expect(lesson?.status).toBe('applied');
    expect(lesson?.to).toBeCloseTo(1.65, 5);
    expect(first.report.applied).toBe(true);

    const after = await getPortfolioSettings(portfolioId);
    expect(after.strategyParams.minPriceChange5mPct).toBeCloseTo(1.65, 5);

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
    expect((await getPortfolioSettings(portfolioId)).strategyParams.minPriceChange5mPct).toBe(1.5);

    await expect(reports.rollbackReport(listed!.id)).rejects.toMatchObject({ status: 409 });

    const regenerated = await reports.generateDailyReport(portfolioId, { reportDate, now, force: true });
    expect(regenerated.created).toBe(true);
    expect(regenerated.report.id).not.toBe(listed!.id);
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
