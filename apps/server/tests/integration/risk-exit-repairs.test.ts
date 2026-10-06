import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { config as loadEnv } from 'dotenv';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(__dirname, '../../../../.env') });

process.env.DATA_MODE = 'demo';
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  'postgresql://memebot:memebot@localhost:5432/memebot_test';

type Db = typeof import('../../src/db/client.js');
type Portfolios = typeof import('../../src/services/portfolio-service.js');
type Tokens = typeof import('../../src/services/token-service.js');
type Queries = typeof import('../../src/services/query-service.js');
type Runners = typeof import('../../src/jobs/runners.js');

const PRODUCTION = '00000000-0000-4000-8000-000000000001';
const EXPLORATION = '00000000-0000-4000-8000-000000000002';

describe('integration: risk re-check, dead-position exits, bad ticks, signal outcomes', () => {
  let db: Db;
  let portfolios: Portfolios;
  let tokens: Tokens;
  let q: Queries;
  let runners: Runners;
  let seq = 0;

  async function token(): Promise<string> {
    seq++;
    return (await tokens.upsertDiscoveredToken({
      chain: 'solana',
      address: `Rx${String(seq).padStart(6, '0')}${'8'.repeat(40)}`.slice(0, 44),
      symbol: `RX${seq}`,
      name: `Repair ${seq}`,
      decimals: 9,
      createdAt: null,
    }))!;
  }

  async function openPosition(
    portfolioId: string,
    tokenId: string,
    opts: { openedMinutesAgo: number; priceUsd?: number },
  ): Promise<string> {
    const price = opts.priceUsd ?? 0.001;
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO positions (portfolio_id, token_id, status, quantity, entry_price_usd, current_price_usd,
         cost_basis_usd, current_value_usd, stop_loss_pct, take_profit_pct, highest_price_usd, data_mode,
         strategy_key, opened_at)
       VALUES ($1, $2, 'OPEN', 1000, $3, $3, 1, 1, 0.5, 5, $3, 'demo', 'early-volume-expansion',
         NOW() - make_interval(mins => $4))
       RETURNING id`,
      [portfolioId, tokenId, price, opts.openedMinutesAgo],
    );
    return rows[0]!.id;
  }

  function quote(over: Record<string, unknown> = {}) {
    return {
      chain: 'solana',
      address: '',
      priceUsd: 0.001,
      marketCapUsd: null,
      volume5mUsd: 1000,
      volume1hUsd: 5000,
      volume24hUsd: 20000,
      buyVolume5mUsd: 500,
      sellVolume5mUsd: 500,
      txCount5m: 20,
      priceChange5mPct: 0,
      priceChange1hPct: 0,
      liquidityUsd: 25000,
      liquidityStatus: 'KNOWN' as const,
      observedAt: new Date(),
      venue: 'demo-amm',
      ...over,
    };
  }

  beforeAll(async () => {
    db = await import('../../src/db/client.js');
    const { migrate } = await import('../../src/db/migrate.js');
    await migrate(process.env.DATABASE_URL);
    portfolios = await import('../../src/services/portfolio-service.js');
    tokens = await import('../../src/services/token-service.js');
    q = await import('../../src/services/query-service.js');
    runners = await import('../../src/jobs/runners.js');
    await portfolios.ensureDefaultPortfolio();
    await portfolios.ensureResearchPortfolio();
  }, 60_000);

  beforeEach(async () => {
    await db.query(`TRUNCATE signal_execution_attempts, risk_decisions, paper_fills, fee_records, paper_orders,
                    positions, signals, bot_events, market_snapshots, tokens CASCADE`);
    await db.query(
      `UPDATE user_portfolios SET cash_usd = 100, peak_equity_usd = 100, risk_state = 'NORMAL',
         kill_switch_active = FALSE WHERE id = ANY($1::uuid[])`,
      [[PRODUCTION, EXPLORATION]],
    );
  });

  afterAll(async () => {
    await db.closePool();
  });

  it('re-derives a drawdown halt from the new settings instead of staying halted', async () => {
    await openPosition(PRODUCTION, await token(), { openedMinutesAgo: 5 });
    // Equity 80 (79 cash + 1 open) vs peak 100 → 20% drawdown with a position open
    await db.query(`UPDATE user_portfolios SET cash_usd = 79, risk_state = 'HALTED' WHERE id = $1`, [PRODUCTION]);

    await portfolios.updatePortfolioSettings(PRODUCTION, { maxDrawdownPct: 0.15 });
    expect(await portfolios.reevaluateRiskState(PRODUCTION)).toBe('HALTED');

    await portfolios.updatePortfolioSettings(PRODUCTION, { maxDrawdownPct: 0.3 });
    expect(await portfolios.reevaluateRiskState(PRODUCTION)).toBe('RECOVERY');
    expect((await portfolios.getPortfolio(PRODUCTION))?.riskState).toBe('RECOVERY');
  });

  it('keeps the kill switch halt when settings change', async () => {
    await db.query(`UPDATE user_portfolios SET risk_state = 'HALTED', kill_switch_active = TRUE WHERE id = $1`, [
      PRODUCTION,
    ]);
    expect(await portfolios.reevaluateRiskState(PRODUCTION)).toBe('HALTED');
  });

  it('writes off a position past max hold whose market data went stale', async () => {
    const tokenId = await token();
    await tokens.insertMarketSnapshot(tokenId, quote({ observedAt: new Date(Date.now() - 60 * 60_000) }));
    const positionId = await openPosition(PRODUCTION, tokenId, { openedMinutesAgo: 120 });

    await runners.executeLane(PRODUCTION, 'PRODUCTION', 'PAUSED');

    const { rows } = await db.query<{ status: string; close_reason: string; current_value_usd: string }>(
      `SELECT status, close_reason, current_value_usd FROM positions WHERE id = $1`,
      [positionId],
    );
    expect(rows[0]).toMatchObject({ status: 'CLOSED', close_reason: 'emergency_no_market_data' });
    expect(Number(rows[0]!.current_value_usd)).toBe(0);
  });

  it('leaves a stale position inside max hold open', async () => {
    const tokenId = await token();
    await tokens.insertMarketSnapshot(tokenId, quote({ observedAt: new Date(Date.now() - 60 * 60_000) }));
    const positionId = await openPosition(PRODUCTION, tokenId, { openedMinutesAgo: 20 });

    await runners.executeLane(PRODUCTION, 'PRODUCTION', 'PAUSED');

    const { rows } = await db.query<{ status: string }>(`SELECT status FROM positions WHERE id = $1`, [positionId]);
    expect(rows[0]!.status).toBe('OPEN');
  });

  it('ignores a huge mark from a pool without known liquidity', async () => {
    const tokenId = await token();
    await tokens.insertMarketSnapshot(tokenId, quote({ priceUsd: 18, liquidityUsd: 0, liquidityStatus: 'UNKNOWN' }));
    const positionId = await openPosition(PRODUCTION, tokenId, { openedMinutesAgo: 5 });

    await runners.executeLane(PRODUCTION, 'PRODUCTION', 'PAUSED');

    const { rows } = await db.query<{ current_price_usd: string; highest_price_usd: string; status: string }>(
      `SELECT current_price_usd, highest_price_usd, status FROM positions WHERE id = $1`,
      [positionId],
    );
    expect(rows[0]!.status).toBe('OPEN');
    expect(Number(rows[0]!.current_price_usd)).toBeCloseTo(0.001, 9);
    expect(Number(rows[0]!.highest_price_usd)).toBeCloseTo(0.001, 9);
    expect((await portfolios.getPortfolio(PRODUCTION))!.equityUsd).toBeLessThan(200);
  });

  it('lists the biggest winners and losers with their close reason', async () => {
    const pnls: Array<[number, string]> = [
      [3, 'take_profit'],
      [1, 'trailing_stop'],
      [-2, 'stop_loss'],
      [-0.5, 'max_holding_time'],
      [0, 'max_holding_time'],
    ];
    for (const [pnl, reason] of pnls) {
      const id = await openPosition(PRODUCTION, await token(), { openedMinutesAgo: 30 });
      await db.query(
        `UPDATE positions SET status = 'CLOSED', closed_at = NOW(), net_pnl_usd = $2, close_reason = $3 WHERE id = $1`,
        [id, pnl, reason],
      );
    }
    const openId = await openPosition(EXPLORATION, await token(), { openedMinutesAgo: 30 });
    await db.query(`UPDATE positions SET status = 'CLOSED', closed_at = NOW(), net_pnl_usd = 9 WHERE id = $1`, [openId]);

    const { winners, losers } = await q.getTradeExtremes([PRODUCTION]);
    expect(winners.map((w) => [w.netPnlUsd, w.closeReason])).toEqual([
      [3, 'take_profit'],
      [1, 'trailing_stop'],
    ]);
    expect(losers.map((l) => [l.netPnlUsd, l.closeReason])).toEqual([
      [-2, 'stop_loss'],
      [-0.5, 'max_holding_time'],
    ]);
    expect(winners[0]!.lane).toBe('PRODUCTION');
  });

  it('explains why a research signal was not executed', async () => {
    const { env } = await import('../../src/config/env.js');
    for (let i = 0; i < env.RESEARCH_MAX_TRADES_PER_DAY; i++) {
      const id = await openPosition(EXPLORATION, await token(), { openedMinutesAgo: 1 });
      await db.query(`UPDATE positions SET opened_at = NOW() - INTERVAL '30 seconds' WHERE id = $1`, [id]);
    }
    const capped = await token();
    const expired = await token();
    await db.query(
      `INSERT INTO signals (token_id, strategy_name, strategy_version, side, risk_label, data_mode, lane, target_portfolio_id, created_at)
       VALUES ($1, 'liquidity-expansion', 'v1', 'BUY', 'MODERATE', 'demo', 'RESEARCH', $3, NOW()),
              ($2, 'liquidity-expansion', 'v1', 'BUY', 'MODERATE', 'demo', 'RESEARCH', $3, NOW() - INTERVAL '30 minutes')`,
      [capped, expired, EXPLORATION],
    );

    const signals = await q.getRecentSignals([EXPLORATION], 10);
    const byToken = new Map(signals.map((s) => [s.tokenId, s]));
    expect(byToken.get(capped)).toMatchObject({
      executionStatus: 'SKIPPED',
      executionReason: expect.stringContaining('research_daily_cap_reached'),
    });
    expect(byToken.get(expired)).toMatchObject({ executionStatus: 'EXPIRED' });
  });
});
