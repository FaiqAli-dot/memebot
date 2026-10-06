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
type Queries = typeof import('../../src/services/query-service.js');
type Lanes = typeof import('../../src/services/lanes.js');
type Tokens = typeof import('../../src/services/token-service.js');

const PRODUCTION = '00000000-0000-4000-8000-000000000001';
const EXPLORATION = '00000000-0000-4000-8000-000000000002';
const OLDER = '00000000-0000-4000-8000-000000000003';

describe('integration: experiment lane metadata in dashboard APIs', () => {
  let db: Db;
  let q: Queries;
  let lanes: Lanes;
  let tokens: Tokens;
  let seq = 0;

  async function token(prefix: string): Promise<string> {
    seq++;
    return (await tokens.upsertDiscoveredToken({
      chain: 'solana',
      address: `${prefix}${String(seq).padStart(6, '0')}${'7'.repeat(40)}`.slice(0, 44),
      symbol: `${prefix.toUpperCase()}${seq}`,
      name: `Lane ${seq}`,
      decimals: 9,
      createdAt: null,
    }))!;
  }

  async function signal(tokenId: string, strategy: string, lane: string, target: string | null): Promise<string> {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO signals (token_id, strategy_name, strategy_version, side, risk_label, data_mode, lane, target_portfolio_id)
       VALUES ($1, $2, 'v1', 'BUY', 'MODERATE', 'demo', $3, $4) RETURNING id`,
      [tokenId, strategy, lane, target],
    );
    return rows[0]!.id;
  }

  /** A closed position with its BUY order, so trades and analytics see it. */
  async function closedTrade(portfolioId: string, tokenId: string, strategy: string, signalId: string, netPnl: number) {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO positions (portfolio_id, token_id, status, quantity, entry_price_usd, current_price_usd,
         cost_basis_usd, current_value_usd, stop_loss_pct, take_profit_pct, highest_price_usd, data_mode,
         strategy_key, entry_signal_id, net_pnl_usd, gross_pnl_usd, realized_pnl_usd, opened_at, closed_at)
       VALUES ($1, $2, 'CLOSED', 1000, 0.001, 0.001, 1, 1, 0.1, 0.2, 0.001, 'demo',
         $3, $4, $5, $5, $5, NOW() - INTERVAL '10 minutes', NOW() - INTERVAL '5 minutes')
       RETURNING id`,
      [portfolioId, tokenId, strategy, signalId, netPnl],
    );
    await db.query(
      `INSERT INTO paper_orders (portfolio_id, token_id, signal_id, position_id, side, status,
         requested_price_usd, requested_amount_usd, execution_record, data_mode)
       VALUES ($1, $2, $3, $4, 'BUY', 'FILLED', 0.001, 1, '{}'::jsonb, 'demo')`,
      [portfolioId, tokenId, signalId, rows[0]!.id],
    );
  }

  beforeAll(async () => {
    db = await import('../../src/db/client.js');
    const { migrate } = await import('../../src/db/migrate.js');
    await migrate(process.env.DATABASE_URL);
    tokens = await import('../../src/services/token-service.js');
    q = await import('../../src/services/query-service.js');
    lanes = await import('../../src/services/lanes.js');
    const portfolios = await import('../../src/services/portfolio-service.js');
    await portfolios.ensureDefaultPortfolio();
    await portfolios.ensureResearchPortfolio();
    await portfolios.ensureOlderTokenResearchPortfolio();
  }, 60_000);

  beforeEach(async () => {
    await db.query(`TRUNCATE signal_execution_attempts, paper_fills, fee_records, paper_orders, positions,
                    signals, bot_events, tokens CASCADE`);
  });

  afterAll(async () => {
    await db.closePool();
  });

  async function seedAllLanes() {
    const prodToken = await token('Pr');
    const revivalToken = await token('Rv');
    const breakoutToken = await token('Bo');
    const exploreToken = await token('Ex');
    // Production and exploration signals predate target routing (NULL target), like older rows
    const prodSig = await signal(prodToken, 'early-volume-expansion', 'PRODUCTION', null);
    const revivalSig = await signal(revivalToken, 'older-revival', 'RESEARCH', OLDER);
    const breakoutSig = await signal(breakoutToken, 'older-breakout', 'RESEARCH', OLDER);
    const exploreSig = await signal(exploreToken, 'liquidity-expansion', 'RESEARCH', null);
    await closedTrade(PRODUCTION, prodToken, 'early-volume-expansion', prodSig, -0.5);
    await closedTrade(OLDER, revivalToken, 'older-revival', revivalSig, 2);
    await closedTrade(OLDER, breakoutToken, 'older-breakout', breakoutSig, 1);
    await closedTrade(EXPLORATION, exploreToken, 'liquidity-expansion', exploreSig, 0.25);
    return { prodToken, revivalToken, breakoutToken, exploreToken, revivalSig };
  }

  it('resolves lanes from the portfolio, and untargeted signals from their lane', () => {
    expect(lanes.portfolioLane(PRODUCTION)).toBe('PRODUCTION');
    expect(lanes.portfolioLane(OLDER)).toBe('OLDER_TOKEN_RESEARCH');
    expect(lanes.portfolioLane(EXPLORATION)).toBe('EXPLORATION_RESEARCH');
    expect(lanes.portfolioLane(null)).toBeNull();
    expect(lanes.signalLane('RESEARCH', OLDER)).toBe('OLDER_TOKEN_RESEARCH');
    expect(lanes.signalLane('PRODUCTION', null)).toBe('PRODUCTION');
    expect(lanes.signalLane('RESEARCH', null)).toBe('EXPLORATION_RESEARCH');
    expect(lanes.parsePortfolioScope(undefined)).toBe('production');
    expect(lanes.parsePortfolioScope('nonsense')).toBe('production');
    expect(lanes.scopePortfolioIds('production')).toEqual([PRODUCTION]);
  });

  it('positions default to production and tag every lane when asked for all', async () => {
    await seedAllLanes();
    const prod = await q.getPositions(lanes.scopePortfolioIds('production'));
    expect(prod.map((p) => [p.lane, p.strategyId])).toEqual([['PRODUCTION', 'early-volume-expansion']]);

    const all = await q.getPositions(lanes.scopePortfolioIds('all'));
    expect(all.map((p) => `${p.lane}:${p.strategyId}`).sort()).toEqual([
      'EXPLORATION_RESEARCH:liquidity-expansion',
      'OLDER_TOKEN_RESEARCH:older-breakout',
      'OLDER_TOKEN_RESEARCH:older-revival',
      'PRODUCTION:early-volume-expansion',
    ]);

    const older = await q.getPositions(lanes.scopePortfolioIds('older-research'));
    expect(older.every((p) => p.lane === 'OLDER_TOKEN_RESEARCH')).toBe(true);
    expect(older).toHaveLength(2);
  });

  it('trades and recent signals carry lane and strategy', async () => {
    await seedAllLanes();
    const trades = await q.getTrades(lanes.scopePortfolioIds('all'));
    expect(trades.map((t) => `${t.lane}:${t.strategy_id}`).sort()).toEqual([
      'EXPLORATION_RESEARCH:liquidity-expansion',
      'OLDER_TOKEN_RESEARCH:older-breakout',
      'OLDER_TOKEN_RESEARCH:older-revival',
      'PRODUCTION:early-volume-expansion',
    ]);
    expect((await q.getTrades(lanes.scopePortfolioIds('production'))).map((t) => t.lane)).toEqual(['PRODUCTION']);

    const signals = await q.getRecentSignals(lanes.scopePortfolioIds('all'), 20);
    expect(signals.map((s) => `${s.lane}:${s.strategyId}`).sort()).toEqual([
      'EXPLORATION_RESEARCH:liquidity-expansion',
      'OLDER_TOKEN_RESEARCH:older-breakout',
      'OLDER_TOKEN_RESEARCH:older-revival',
      'PRODUCTION:early-volume-expansion',
    ]);
    const olderSignals = await q.getRecentSignals(lanes.scopePortfolioIds('older-research'), 20);
    expect(olderSignals.map((s) => s.strategyId).sort()).toEqual(['older-breakout', 'older-revival']);
  });

  it('keeps production analytics and older-token research stats separate', async () => {
    await seedAllLanes();
    const analytics = await q.getAnalytics(PRODUCTION);
    expect(analytics.totalTrades).toBe(1);
    expect(analytics.netProfitUsd).toBeCloseTo(-0.5);

    const research = await q.getOlderTokenResearchSummary();
    expect(research.strategies.map((s) => [s.strategyId, s.closed, s.netPnlUsd])).toEqual([
      ['older-breakout', 1, 1],
      ['older-revival', 1, 2],
    ]);
    expect(research.signalsLastHour.map((s) => s.strategyId)).toEqual(['older-breakout', 'older-revival']);
  });

  it('tags bot events with their portfolio lane and the linked signal strategy', async () => {
    const { revivalToken, revivalSig } = await seedAllLanes();
    await db.query(
      `INSERT INTO bot_events (portfolio_id, level, category, message, details, data_mode)
       VALUES ($1, 'info', 'signal', 'Older-token research signal', $2, 'demo'),
              ($3, 'info', 'execution', 'Paper BUY executed', '{}'::jsonb, 'demo')`,
      [OLDER, JSON.stringify({ signalId: revivalSig, tokenId: revivalToken }), PRODUCTION],
    );
    const all = await q.getBotEvents(lanes.scopePortfolioIds('all'), { limit: 10 });
    const older = all.find((e) => e.category === 'signal');
    expect(older?.lane).toBe('OLDER_TOKEN_RESEARCH');
    expect(older?.strategyId).toBe('older-revival');
    expect(all.find((e) => e.category === 'execution')?.lane).toBe('PRODUCTION');

    const prodOnly = await q.getBotEvents(lanes.scopePortfolioIds('production'), { limit: 10 });
    expect(prodOnly.some((e) => e.lane === 'OLDER_TOKEN_RESEARCH')).toBe(false);
  });
});
