import type {
  AnalyticsSummary,
  BotEventData,
  BotStatusInfo,
  EquityPoint,
  PositionData,
  ScannerRow,
  StrategyLabStats,
} from '@memebot/shared';
import { SCORE_DISCLAIMER } from '@memebot/shared';
import { query } from '../db/client.js';
import { dataMode, env } from '../config/env.js';
import { getPortfolio } from './portfolio-service.js';
import { getRuntimeBotStats } from '../jobs/runners.js';
import { MomentumStrategyV1, riskLabelFromScore } from '../engines/strategy/momentum-v1.js';
import { safeDiv } from '../utils/helpers.js';

const strategy = new MomentumStrategyV1();

export async function getBotStatus(portfolioId: string): Promise<BotStatusInfo> {
  const p = await getPortfolio(portfolioId);
  const stats = getRuntimeBotStats();
  const tradesToday = await query<{ c: string }>(
    `SELECT COUNT(*)::text AS c FROM paper_orders
     WHERE portfolio_id = $1 AND created_at >= date_trunc('day', NOW()) AND status IN ('FILLED','PARTIAL')`,
    [portfolioId],
  );
  return {
    status: p?.botStatus ?? 'PAUSED',
    dataMode,
    lastScanAt: stats.lastScanAt?.toISOString() ?? null,
    tokensScanned: stats.tokensScanned,
    signalsGenerated: stats.signalsGenerated,
    tradesToday: Number(tradesToday.rows[0]?.c ?? 0),
    currentStrategy: `${strategy.name} ${strategy.version}`,
    riskState: p?.riskState ?? 'OK',
    lastError: null,
  };
}

export async function getScannerRows(opts: {
  sort: string;
  order: 'asc' | 'desc';
  filter: string;
  minLiquidity?: number;
  limit: number;
}): Promise<ScannerRow[]> {
  const { rows } = await query<{
    id: string;
    address: string;
    symbol: string;
    name: string;
    chain: string;
    created_at_onchain: Date | null;
    discovered_at: Date;
    watchlisted: boolean;
    price_usd: string | null;
    market_cap_usd: string | null;
    liquidity_usd: string | null;
    volume_5m_usd: string | null;
    volume_1h_usd: string | null;
    buy_volume_5m_usd: string | null;
    sell_volume_5m_usd: string | null;
    price_change_5m_pct: string | null;
    observed_at: Date | null;
    holder_count: number | null;
    top_holder_pct: string | null;
    signal_side: string | null;
    overall_score: string | null;
  }>(
    `SELECT t.id, t.address, t.symbol, t.name, t.chain, t.created_at_onchain, t.discovered_at, t.watchlisted,
      m.price_usd, m.market_cap_usd, m.liquidity_usd, m.volume_5m_usd, m.volume_1h_usd,
      m.buy_volume_5m_usd, m.sell_volume_5m_usd, m.price_change_5m_pct, m.observed_at,
      h.holder_count, h.top_holder_pct,
      s.side AS signal_side, s.overall_score
     FROM tokens t
     LEFT JOIN LATERAL (
       SELECT * FROM market_snapshots ms WHERE ms.token_id = t.id ORDER BY ms.observed_at DESC LIMIT 1
     ) m ON TRUE
     LEFT JOIN LATERAL (
       SELECT * FROM holder_snapshots hs WHERE hs.token_id = t.id ORDER BY hs.observed_at DESC LIMIT 1
     ) h ON TRUE
     LEFT JOIN LATERAL (
       SELECT side, overall_score FROM signals sg WHERE sg.token_id = t.id ORDER BY sg.created_at DESC LIMIT 1
     ) s ON TRUE
     WHERE t.data_mode = $1
     LIMIT 200`,
    [dataMode],
  );

  let mapped: ScannerRow[] = rows.map((r) => {
    const volume5m = Number(r.volume_5m_usd ?? 0);
    const volume1h = Number(r.volume_1h_usd ?? 0);
    const buy = Number(r.buy_volume_5m_usd ?? 0);
    const sell = Number(r.sell_volume_5m_usd ?? 0);
    const liquidity = Number(r.liquidity_usd ?? 0);
    const priceChange = Number(r.price_change_5m_pct ?? 0);
    const topHolder = r.top_holder_pct != null ? Number(r.top_holder_pct) : null;
    const accel = volume1h > 0 ? (volume5m * 12) / volume1h : 0;
    const ageMinutes =
      r.created_at_onchain != null
        ? (Date.now() - r.created_at_onchain.getTime()) / 60_000
        : (Date.now() - r.discovered_at.getTime()) / 60_000;

    const scores = strategy.score(
      {
        tokenId: r.id,
        address: r.address,
        symbol: r.symbol,
        chain: r.chain,
        ageMinutes,
        priceUsd: Number(r.price_usd ?? 0),
        liquidityUsd: liquidity,
        volume5mUsd: volume5m,
        volume1hUsd: volume1h,
        buyVolume5mUsd: buy,
        sellVolume5mUsd: sell,
        txCount5m: 0,
        priceChange5mPct: priceChange,
        priceChange1hPct: 0,
        holderCount: r.holder_count,
        topHolderPct: topHolder,
        observedAt: r.observed_at ?? new Date(),
        priorVolume5mUsd: null,
      },
      {
        minVolume5mUsd: 0,
        minVolumeAcceleration: 0,
        minPriceChange5mPct: 0,
        minBuySellRatio: 0,
        minLiquidityUsd: 0,
        minActivityTx5m: 0,
        minTokenAgeMinutes: 0,
        maxTokenAgeMinutes: 1e9,
        minOverallScore: 0,
        maxTopHolderPct: 100,
      },
    );

    return {
      tokenId: r.id,
      address: r.address,
      symbol: r.symbol,
      name: r.name,
      chain: r.chain,
      ageMinutes,
      priceUsd: Number(r.price_usd ?? 0),
      marketCapUsd: r.market_cap_usd != null ? Number(r.market_cap_usd) : null,
      liquidityUsd: liquidity,
      volume5mUsd: volume5m,
      volume1hUsd: volume1h,
      volumeAcceleration: accel,
      buyVolume5mUsd: buy,
      sellVolume5mUsd: sell,
      buySellRatio: sell > 0 ? buy / sell : null,
      holderCount: r.holder_count,
      topHolderConcentration: topHolder,
      priceChange5mPct: priceChange,
      momentumScore: scores.momentum,
      riskScore: scores.risk,
      riskLabel: riskLabelFromScore(scores.risk, topHolder, liquidity),
      signal: r.signal_side,
      overallScore: r.overall_score != null ? Number(r.overall_score) : scores.overall,
      lastUpdated: (r.observed_at ?? r.discovered_at).toISOString(),
      dataMode,
    };
  });

  // Filters
  mapped = mapped.filter((row) => {
    if (opts.minLiquidity != null && row.liquidityUsd < opts.minLiquidity) return false;
    switch (opts.filter) {
      case 'new_launches':
        return (row.ageMinutes ?? 9999) < 60;
      case 'high_volume':
        return row.volume5mUsd >= 3000;
      case 'high_momentum':
        return row.momentumScore >= 60;
      case 'min_liquidity':
        return row.liquidityUsd >= (opts.minLiquidity ?? 5000);
      case 'low_holder_concentration':
        return row.topHolderConcentration != null && row.topHolderConcentration < 20;
      case 'accelerating':
        return row.volumeAcceleration >= 1.3;
      case 'high_risk':
        return row.riskLabel === 'HIGH' || row.riskLabel === 'EXTREME';
      case 'watchlist':
        return rows.find((r) => r.id === row.tokenId)?.watchlisted === true;
      default:
        return true;
    }
  });

  const dir = opts.order === 'asc' ? 1 : -1;
  mapped.sort((a, b) => {
    const av =
      opts.sort === 'age'
        ? a.ageMinutes ?? 0
        : opts.sort === 'volume5m'
          ? a.volume5mUsd
          : opts.sort === 'momentum'
            ? a.momentumScore
            : opts.sort === 'liquidity'
              ? a.liquidityUsd
              : opts.sort === 'risk'
                ? a.riskScore
                : opts.sort === 'score'
                  ? a.overallScore ?? 0
                  : new Date(a.lastUpdated).getTime();
    const bv =
      opts.sort === 'age'
        ? b.ageMinutes ?? 0
        : opts.sort === 'volume5m'
          ? b.volume5mUsd
          : opts.sort === 'momentum'
            ? b.momentumScore
            : opts.sort === 'liquidity'
              ? b.liquidityUsd
              : opts.sort === 'risk'
                ? b.riskScore
                : opts.sort === 'score'
                  ? b.overallScore ?? 0
                  : new Date(b.lastUpdated).getTime();
    return (av - bv) * dir;
  });

  return mapped.slice(0, opts.limit);
}

export async function getPositions(portfolioId: string, status?: 'OPEN' | 'CLOSED'): Promise<PositionData[]> {
  const params: unknown[] = [portfolioId];
  let sql = `
    SELECT p.*, t.symbol, t.name, t.address, t.chain
    FROM positions p
    JOIN tokens t ON t.id = p.token_id
    WHERE p.portfolio_id = $1`;
  if (status) {
    params.push(status);
    sql += ` AND p.status = $2`;
  }
  sql += ` ORDER BY p.opened_at DESC LIMIT 100`;

  const { rows } = await query(sql, params);
  return rows.map((r) => mapPosition(r));
}

function mapPosition(r: Record<string, unknown>): PositionData {
  const entryCosts = (r.entry_costs ?? {}) as PositionData['entryCosts'];
  const qty = Number(r.quantity);
  const current = Number(r.current_price_usd);
  const costBasis = Number(r.cost_basis_usd);
  const unrealized = Number(r.unrealized_pnl_usd);
  return {
    id: String(r.id),
    portfolioId: String(r.portfolio_id),
    tokenId: String(r.token_id),
    status: r.status as PositionData['status'],
    quantity: qty,
    entryPriceUsd: Number(r.entry_price_usd),
    currentPriceUsd: current,
    costBasisUsd: costBasis,
    currentValueUsd: Number(r.current_value_usd),
    unrealizedPnlUsd: unrealized,
    unrealizedPnlPct: costBasis > 0 ? (unrealized / costBasis) * 100 : 0,
    realizedPnlUsd: Number(r.realized_pnl_usd),
    stopLossPct: Number(r.stop_loss_pct),
    takeProfitPct: Number(r.take_profit_pct),
    trailingStopPct: r.trailing_stop_pct != null ? Number(r.trailing_stop_pct) : null,
    highestPriceUsd: Number(r.highest_price_usd),
    entryCosts,
    exitCosts: (r.exit_costs as PositionData['exitCosts']) ?? null,
    openedAt: new Date(r.opened_at as Date).toISOString(),
    closedAt: r.closed_at ? new Date(r.closed_at as Date).toISOString() : null,
    closeReason: (r.close_reason as string) ?? null,
    dataMode: r.data_mode as PositionData['dataMode'],
    token: {
      id: String(r.token_id),
      chain: String(r.chain),
      address: String(r.address),
      symbol: String(r.symbol),
      name: String(r.name),
      decimals: 9,
      createdAt: null,
      discoveredAt: new Date().toISOString(),
      dataMode: r.data_mode as PositionData['dataMode'],
      metadata: {},
    },
  };
}

export async function getTrades(portfolioId: string) {
  const { rows } = await query(
    `SELECT o.*, t.symbol, t.address, t.chain
     FROM paper_orders o
     JOIN tokens t ON t.id = o.token_id
     WHERE o.portfolio_id = $1
     ORDER BY o.created_at DESC
     LIMIT 100`,
    [portfolioId],
  );
  return rows;
}

export async function getTradeDetail(portfolioId: string, orderId: string) {
  const { rows } = await query(
    `SELECT o.*, t.symbol, t.name, t.address, t.chain,
       s.created_at AS signal_at, s.explanation, s.market_state, s.overall_score,
       s.momentum_score, s.liquidity_score, s.volume_score, s.holder_score, s.risk_score, s.risk_label
     FROM paper_orders o
     JOIN tokens t ON t.id = o.token_id
     LEFT JOIN signals s ON s.id = o.signal_id
     WHERE o.portfolio_id = $1 AND o.id = $2`,
    [portfolioId, orderId],
  );
  const order = rows[0];
  if (!order) return null;

  let position = null;
  if (order.position_id) {
    const pos = await query(`SELECT * FROM positions WHERE id = $1`, [order.position_id]);
    position = pos.rows[0] ?? null;
  }

  return {
    order,
    position,
    scoreDisclaimer: SCORE_DISCLAIMER,
  };
}

export async function getEquityHistory(portfolioId: string): Promise<EquityPoint[]> {
  const { rows } = await query<{
    observed_at: Date;
    equity_usd: string;
    cash_usd: string;
    invested_value_usd: string;
    unrealized_pnl_usd: string;
    realized_pnl_usd: string;
  }>(
    `SELECT observed_at, equity_usd, cash_usd, invested_value_usd, unrealized_pnl_usd, realized_pnl_usd
     FROM portfolio_snapshots
     WHERE portfolio_id = $1
     ORDER BY observed_at ASC`,
    [portfolioId],
  );
  return rows.map((r) => ({
    observedAt: r.observed_at.toISOString(),
    equityUsd: Number(r.equity_usd),
    cashUsd: Number(r.cash_usd),
    investedValueUsd: Number(r.invested_value_usd),
    unrealizedPnlUsd: Number(r.unrealized_pnl_usd),
    realizedPnlUsd: Number(r.realized_pnl_usd),
  }));
}

export async function getBotEvents(
  portfolioId: string,
  opts: { q?: string; level?: string; category?: string; limit: number },
): Promise<BotEventData[]> {
  const clauses = [`(portfolio_id = $1 OR portfolio_id IS NULL)`, `data_mode = $2`];
  const params: unknown[] = [portfolioId, dataMode];
  if (opts.level) {
    params.push(opts.level);
    clauses.push(`level = $${params.length}`);
  }
  if (opts.category) {
    params.push(opts.category);
    clauses.push(`category = $${params.length}`);
  }
  if (opts.q) {
    params.push(`%${opts.q}%`);
    clauses.push(`message ILIKE $${params.length}`);
  }
  params.push(opts.limit);
  const { rows } = await query(
    `SELECT * FROM bot_events WHERE ${clauses.join(' AND ')}
     ORDER BY created_at DESC LIMIT $${params.length}`,
    params,
  );
  return rows.map((r) => ({
    id: r.id,
    portfolioId: r.portfolio_id,
    level: r.level,
    category: r.category,
    message: r.message,
    details: r.details ?? {},
    createdAt: new Date(r.created_at).toISOString(),
    dataMode: r.data_mode,
  }));
}

export async function getAnalytics(portfolioId: string): Promise<AnalyticsSummary> {
  const { rows } = await query<{
    net_pnl: string;
    gross_pnl: string;
    holding_sec: string | null;
  }>(
    `SELECT net_pnl_usd AS net_pnl, gross_pnl_usd AS gross_pnl,
       EXTRACT(EPOCH FROM (closed_at - opened_at)) AS holding_sec
     FROM positions
     WHERE portfolio_id = $1 AND status = 'CLOSED'`,
    [portfolioId],
  );

  const pnls = rows.map((r) => Number(r.net_pnl));
  const grosses = rows.map((r) => Number(r.gross_pnl));
  const winners = pnls.filter((p) => p > 0);
  const losers = pnls.filter((p) => p <= 0);
  const grossProfit = winners.reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(losers.reduce((a, b) => a + b, 0));
  const netProfit = pnls.reduce((a, b) => a + b, 0);

  const fees = await query<{
    dex: string;
    network: string;
    priority: string;
    slippage: string;
    impact: string;
  }>(
    `SELECT
       COALESCE(SUM(CASE WHEN fee_type = 'dex' THEN amount_usd ELSE 0 END),0) AS dex,
       COALESCE(SUM(CASE WHEN fee_type = 'network' OR fee_type = 'network_failed_tx' THEN amount_usd ELSE 0 END),0) AS network,
       COALESCE(SUM(CASE WHEN fee_type = 'priority' THEN amount_usd ELSE 0 END),0) AS priority,
       COALESCE(SUM(CASE WHEN fee_type = 'slippage' THEN amount_usd ELSE 0 END),0) AS slippage,
       COALESCE(SUM(CASE WHEN fee_type = 'price_impact' THEN amount_usd ELSE 0 END),0) AS impact
     FROM fee_records WHERE portfolio_id = $1`,
    [portfolioId],
  );
  const f = fees.rows[0]!;
  const portfolio = await getPortfolio(portfolioId);

  const holdings = rows
    .map((r) => (r.holding_sec != null ? Number(r.holding_sec) : null))
    .filter((n): n is number => n != null);

  // Sharpe only with enough closed trades and equity samples
  let sharpe: number | null = null;
  if (pnls.length >= 5) {
    const mean = safeDiv(pnls.reduce((a, b) => a + b, 0), pnls.length, 0);
    const variance = safeDiv(
      pnls.reduce((a, b) => a + (b - mean) ** 2, 0),
      pnls.length,
      0,
    );
    const std = Math.sqrt(variance);
    sharpe = std > 0 ? mean / std : null;
  }

  const grossTradingPnl = grosses.reduce((a, b) => a + b, 0);

  return {
    totalTrades: pnls.length,
    winningTrades: winners.length,
    losingTrades: losers.length,
    winRate: pnls.length ? winners.length / pnls.length : null,
    grossProfitUsd: grossProfit,
    grossLossUsd: grossLoss,
    netProfitUsd: netProfit,
    totalFeesUsd: Number(f.dex),
    totalNetworkCostUsd: Number(f.network),
    totalPriorityFeeUsd: Number(f.priority),
    totalSlippageCostUsd: Number(f.slippage),
    totalPriceImpactCostUsd: Number(f.impact),
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : winners.length ? null : null,
    avgWinnerUsd: winners.length ? grossProfit / winners.length : null,
    avgLoserUsd: losers.length ? -grossLoss / losers.length : null,
    expectancyUsd: pnls.length ? netProfit / pnls.length : null,
    maxDrawdownPct: portfolio?.maxDrawdownPct ?? 0,
    sharpeRatio: sharpe,
    avgHoldingTimeSec: holdings.length
      ? holdings.reduce((a, b) => a + b, 0) / holdings.length
      : null,
    largestWinUsd: winners.length ? Math.max(...winners) : null,
    largestLossUsd: losers.length ? Math.min(...losers) : null,
    costWaterfall: {
      grossTradingPnlUsd: grossTradingPnl,
      dexFeesUsd: Number(f.dex),
      networkFeesUsd: Number(f.network),
      priorityFeesUsd: Number(f.priority),
      slippageUsd: Number(f.slippage),
      priceImpactUsd: Number(f.impact),
      netPnlUsd: netProfit,
    },
  };
}

export async function getStrategyLab(portfolioId: string): Promise<StrategyLabStats[]> {
  const { rows } = await query<{
    strategy_name: string;
    strategy_version: string;
    trades: string;
    wins: string;
    net: string;
    fees: string;
    slippage: string;
    avg_hold: string | null;
  }>(
    `SELECT
       COALESCE(s.strategy_name, 'Momentum Scanner v1') AS strategy_name,
       COALESCE(s.strategy_version, '1.0.0') AS strategy_version,
       COUNT(p.id)::text AS trades,
       COUNT(p.id) FILTER (WHERE p.net_pnl_usd > 0)::text AS wins,
       COALESCE(SUM(p.net_pnl_usd),0)::text AS net,
       COALESCE(SUM((p.entry_costs->>'dexFeeUsd')::numeric),0)::text AS fees,
       COALESCE(SUM((p.entry_costs->>'slippageCostUsd')::numeric),0)::text AS slippage,
       AVG(EXTRACT(EPOCH FROM (p.closed_at - p.opened_at)))::text AS avg_hold
     FROM positions p
     LEFT JOIN signals s ON s.id = p.entry_signal_id
     WHERE p.portfolio_id = $1 AND p.status = 'CLOSED'
     GROUP BY 1, 2`,
    [portfolioId],
  );

  if (rows.length === 0) {
    return [
      {
        strategyName: 'Momentum Scanner v1',
        strategyVersion: '1.0.0',
        trades: 0,
        winRate: null,
        netPnlUsd: 0,
        drawdownPct: 0,
        profitFactor: null,
        feesUsd: 0,
        slippageUsd: 0,
        avgTradeUsd: null,
        avgHoldingTimeSec: null,
      },
    ];
  }

  const portfolio = await getPortfolio(portfolioId);
  return rows.map((r) => {
    const trades = Number(r.trades);
    const wins = Number(r.wins);
    const net = Number(r.net);
    return {
      strategyName: r.strategy_name,
      strategyVersion: r.strategy_version,
      trades,
      winRate: trades ? wins / trades : null,
      netPnlUsd: net,
      drawdownPct: portfolio?.maxDrawdownPct ?? 0,
      profitFactor: null,
      feesUsd: Number(r.fees),
      slippageUsd: Number(r.slippage),
      avgTradeUsd: trades ? net / trades : null,
      avgHoldingTimeSec: r.avg_hold != null ? Number(r.avg_hold) : null,
    };
  });
}

export async function getTokenDetail(tokenId: string) {
  const token = await query(`SELECT * FROM tokens WHERE id = $1 AND data_mode = $2`, [
    tokenId,
    dataMode,
  ]);
  if (!token.rows[0]) return null;

  const markets = await query(
    `SELECT observed_at, price_usd, volume_5m_usd, liquidity_usd, market_cap_usd,
            buy_volume_5m_usd, sell_volume_5m_usd, price_change_5m_pct
     FROM market_snapshots WHERE token_id = $1 ORDER BY observed_at ASC LIMIT 500`,
    [tokenId],
  );
  const holders = await query(
    `SELECT * FROM holder_snapshots WHERE token_id = $1 ORDER BY observed_at DESC LIMIT 1`,
    [tokenId],
  );
  const signal = await query(
    `SELECT * FROM signals WHERE token_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [tokenId],
  );

  return {
    token: token.rows[0],
    marketHistory: markets.rows,
    holders: holders.rows[0] ?? null,
    signal: signal.rows[0]
      ? {
          ...signal.rows[0],
          scoreDisclaimer: SCORE_DISCLAIMER,
        }
      : null,
    scoreDisclaimer: SCORE_DISCLAIMER,
  };
}

export function meta() {
  return {
    name: 'MemeBot',
    subtitle: 'Meme Coin Paper Trading & Research',
    dataMode,
    defaultPortfolioId: env.DEFAULT_PORTFOLIO_ID,
    scoreDisclaimer: SCORE_DISCLAIMER,
    paperTradingOnly: true,
  };
}
