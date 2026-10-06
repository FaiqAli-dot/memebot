import type {
  AnalyticsSummary,
  BotEventData,
  BotStatusInfo,
  EquityPoint,
  LivePositionData,
  PortfolioLane,
  PositionData,
  ScannerRow,
  StrategyLabStats,
} from '@memebot/shared';
import { eventStrategyId, portfolioLane, signalLane, signalPortfolioSql } from './lanes.js';
import { OLDER_TOKEN_RESEARCH_PORTFOLIO_ID, RESEARCH_PORTFOLIO_ID, SCORE_DISCLAIMER } from '@memebot/shared';
import { query } from '../db/client.js';
import { dataMode, env, realismProfile } from '../config/env.js';
import { getPortfolio } from './portfolio-service.js';
import { getRuntimeBotStats } from '../jobs/runners.js';
import { MomentumStrategyV1, riskLabelFromScore } from '../engines/strategy/momentum-v1.js';
import { safeDiv } from '../utils/helpers.js';
import {
  theoreticalStopPrice,
  theoreticalTakeProfitPrice,
} from '../engines/paper/exits.js';
import { PAPER_ONLY_DISCLAIMER } from '@memebot/shared';
import { isKillSwitchActive } from '../monitoring/kill-switch.js';

const strategy = new MomentumStrategyV1();

export async function getBotStatus(portfolioId: string): Promise<BotStatusInfo> {
  const p = await getPortfolio(portfolioId);
  const stats = getRuntimeBotStats();

  const scan = await query<{ last: Date | null; scanned: string }>(
    `SELECT MAX(discovered_at) AS last, COUNT(*)::text AS scanned FROM tokens WHERE data_mode = $1`,
    [dataMode],
  );
  const signals = await query<{ c: string }>(
    `SELECT COUNT(*)::text AS c FROM signals WHERE data_mode = $1`,
    [dataMode],
  );
  const lastMarket = await query<{ last: Date | null }>(
    `SELECT MAX(observed_at) AS last FROM market_snapshots WHERE data_mode = $1`,
    [dataMode],
  );

  const tradesToday = await query<{ c: string }>(
    `SELECT COUNT(*)::text AS c FROM paper_orders
     WHERE portfolio_id = $1 AND created_at >= date_trunc('day', NOW()) AND status IN ('FILLED','PARTIAL')`,
    [portfolioId],
  );

  const lastScanAt =
    stats.lastScanAt?.toISOString() ??
    lastMarket.rows[0]?.last?.toISOString() ??
    scan.rows[0]?.last?.toISOString() ??
    null;

  const killSwitchActive = await isKillSwitchActive(portfolioId);

  return {
    status: p?.botStatus ?? 'PAUSED',
    dataMode,
    lastScanAt,
    tokensScanned: Math.max(stats.tokensScanned, Number(scan.rows[0]?.scanned ?? 0)),
    signalsGenerated: Math.max(stats.signalsGenerated, Number(signals.rows[0]?.c ?? 0)),
    tradesToday: Number(tradesToday.rows[0]?.c ?? 0),
    currentStrategy: 'multi-strategy framework-v1',
    riskState: p?.riskState ?? 'NORMAL',
    lastError: null,
    killSwitchActive,
    tradingMode: 'PAPER',
    realismProfile,
    marketRegime: stats.latestRegime ?? null,
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
    signal_lane: string | null;
    signal_target_portfolio_id: string | null;
    signal_strategy: string | null;
  }>(
    `SELECT t.id, t.address, t.symbol, t.name, t.chain, t.created_at_onchain, t.discovered_at, t.watchlisted,
      m.price_usd, m.market_cap_usd, m.liquidity_usd, m.volume_5m_usd, m.volume_1h_usd,
      m.buy_volume_5m_usd, m.sell_volume_5m_usd, m.price_change_5m_pct, m.observed_at,
      h.holder_count, h.top_holder_pct,
      s.side AS signal_side, s.overall_score, s.lane AS signal_lane,
      s.target_portfolio_id AS signal_target_portfolio_id, s.strategy_name AS signal_strategy
     FROM tokens t
     LEFT JOIN LATERAL (
       SELECT * FROM market_snapshots ms WHERE ms.token_id = t.id ORDER BY ms.observed_at DESC LIMIT 1
     ) m ON TRUE
     LEFT JOIN LATERAL (
       SELECT * FROM holder_snapshots hs WHERE hs.token_id = t.id ORDER BY hs.observed_at DESC LIMIT 1
     ) h ON TRUE
     LEFT JOIN LATERAL (
       SELECT side, overall_score, lane, target_portfolio_id, strategy_name
       FROM signals sg WHERE sg.token_id = t.id ORDER BY sg.created_at DESC LIMIT 1
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
      signalLane: r.signal_side ? signalLane(r.signal_lane, r.signal_target_portfolio_id) : null,
      signalStrategyId: r.signal_strategy,
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

function portfolioIdList(portfolioIds: string | string[]): string[] {
  return Array.isArray(portfolioIds) ? portfolioIds : [portfolioIds];
}

export async function getPositions(
  portfolioIds: string | string[],
  status?: 'OPEN' | 'CLOSED',
): Promise<PositionData[]> {
  const params: unknown[] = [portfolioIdList(portfolioIds)];
  let sql = `
    SELECT p.*, t.symbol, t.name, t.address, t.chain
    FROM positions p
    JOIN tokens t ON t.id = p.token_id
    WHERE p.portfolio_id = ANY($1::uuid[])`;
  if (status) {
    params.push(status);
    sql += ` AND p.status = $2`;
  }
  sql += ` ORDER BY p.opened_at DESC LIMIT 100`;

  const { rows } = await query(sql, params);
  return rows.map((r) => mapPosition(r));
}

export async function getLivePositions(portfolioIds: string | string[]): Promise<LivePositionData[]> {
  const positions = await getPositions(portfolioIds, 'OPEN');
  return Promise.all(
    positions.map(async (p) => {
      const { rows } = await query<{ observed_at: Date; price_usd: string }>(
        `SELECT observed_at, price_usd FROM (
           SELECT observed_at, price_usd FROM market_snapshots
           WHERE token_id = $1 AND observed_at >= $2::timestamptz - INTERVAL '5 minutes'
           ORDER BY observed_at DESC LIMIT 500
         ) recent ORDER BY observed_at ASC`,
        [p.tokenId, p.openedAt],
      );
      return {
        ...p,
        history: rows.map((r) => ({
          t: new Date(r.observed_at).toISOString(),
          price: Number(r.price_usd),
        })),
        stopLossPriceUsd: theoreticalStopPrice(p.entryPriceUsd, p.stopLossPct),
        takeProfitPriceUsd: theoreticalTakeProfitPrice(p.entryPriceUsd, p.takeProfitPct),
        trailingStopPriceUsd:
          p.trailingStopPct != null ? p.highestPriceUsd * (1 - p.trailingStopPct) : null,
      };
    }),
  );
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
    lane: portfolioLane(String(r.portfolio_id)),
    strategyId: (r.strategy_key as string | null) ?? null,
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

function withOrderLane<T extends Record<string, unknown>>(rows: T[]): Array<T & { lane: PortfolioLane | null }> {
  return rows.map((r) => ({ ...r, lane: portfolioLane(r.portfolio_id as string | null) }));
}

export async function getTrades(portfolioIds: string | string[]) {
  const { rows } = await query(
    `SELECT o.*, t.symbol, t.address, t.chain,
            COALESCE(p.strategy_key, s.strategy_name) AS strategy_id
     FROM paper_orders o
     JOIN tokens t ON t.id = o.token_id
     LEFT JOIN positions p ON p.id = o.position_id
     LEFT JOIN signals s ON s.id = o.signal_id
     WHERE o.portfolio_id = ANY($1::uuid[]) AND o.status <> 'FAILED'
     ORDER BY o.created_at DESC
     LIMIT 100`,
    [portfolioIdList(portfolioIds)],
  );
  return withOrderLane(rows);
}

export interface TradeExtreme {
  positionId: string;
  tokenId: string;
  symbol: string | null;
  lane: PortfolioLane | null;
  strategyId: string | null;
  netPnlUsd: number;
  netPnlPct: number | null;
  closeReason: string | null;
  entryPriceUsd: number;
  exitPriceUsd: number | null;
  openedAt: string;
  closedAt: string | null;
  exitOrderId: string | null;
}

/** Top closed positions by net P/L in each direction (winners > 0, losers < 0). */
export async function getTradeExtremes(portfolioIds: string | string[], limit = 5) {
  const select = (order: 'DESC' | 'ASC', sign: '>' | '<') =>
    query<{
      id: string;
      token_id: string;
      symbol: string | null;
      portfolio_id: string;
      strategy_id: string | null;
      net_pnl_usd: string;
      cost_basis_usd: string;
      close_reason: string | null;
      entry_price_usd: string;
      exit_price_usd: string | null;
      opened_at: Date;
      closed_at: Date | null;
      exit_order_id: string | null;
    }>(
      `SELECT p.id, p.token_id, t.symbol, p.portfolio_id,
              COALESCE(p.strategy_key, s.strategy_name) AS strategy_id,
              p.net_pnl_usd, p.cost_basis_usd, p.close_reason, p.entry_price_usd,
              e.executed_price_usd AS exit_price_usd, p.opened_at, p.closed_at, p.exit_order_id
       FROM positions p
       JOIN tokens t ON t.id = p.token_id
       LEFT JOIN signals s ON s.id = p.entry_signal_id
       LEFT JOIN paper_orders e ON e.id = p.exit_order_id
       WHERE p.portfolio_id = ANY($1::uuid[]) AND p.status = 'CLOSED' AND p.net_pnl_usd ${sign} 0
       ORDER BY p.net_pnl_usd ${order}
       LIMIT $2`,
      [portfolioIdList(portfolioIds), limit],
    );
  const toExtreme = (r: Awaited<ReturnType<typeof select>>['rows'][number]): TradeExtreme => {
    const basis = Number(r.cost_basis_usd);
    const net = Number(r.net_pnl_usd);
    return {
      positionId: r.id,
      tokenId: r.token_id,
      symbol: r.symbol,
      lane: portfolioLane(r.portfolio_id),
      strategyId: r.strategy_id,
      netPnlUsd: net,
      netPnlPct: basis > 0 ? (net / basis) * 100 : null,
      closeReason: r.close_reason,
      entryPriceUsd: Number(r.entry_price_usd),
      exitPriceUsd: r.exit_price_usd != null ? Number(r.exit_price_usd) : null,
      openedAt: r.opened_at.toISOString(),
      closedAt: r.closed_at?.toISOString() ?? null,
      exitOrderId: r.exit_order_id,
    };
  };
  const [winners, losers] = await Promise.all([select('DESC', '>'), select('ASC', '<')]);
  return { winners: winners.rows.map(toExtreme), losers: losers.rows.map(toExtreme) };
}

/**
 * Failed orders, one row per position + failure reason (retries are counted, not repeated),
 * with how the position eventually ended: filled exit, closed at $0, or still open.
 */
export async function getFailedOrders(portfolioIds: string | string[]) {
  const { rows } = await query(
    `SELECT o.id, o.portfolio_id, p.strategy_key AS strategy_id,
            o.side, o.failure_reason, o.attempt_count, o.created_at AS first_attempt_at,
            COALESCE(o.last_attempt_at, o.created_at) AS last_attempt_at,
            o.requested_price_usd, o.requested_amount_usd, o.network_fee_usd, o.priority_fee_usd,
            o.total_cost_usd, t.symbol,
            p.id AS position_id, p.status AS position_status, p.close_reason, p.closed_at,
            p.net_pnl_usd, p.gross_pnl_usd,
            e.id AS exit_order_id, e.status AS exit_status, e.executed_price_usd AS exit_price_usd,
            e.filled_amount_usd AS exit_filled_usd, e.total_cost_usd AS exit_cost_usd
     FROM paper_orders o
     JOIN tokens t ON t.id = o.token_id
     LEFT JOIN positions p ON p.id = o.position_id
     LEFT JOIN paper_orders e ON e.id = p.exit_order_id
     WHERE o.portfolio_id = ANY($1::uuid[]) AND o.status = 'FAILED'
     ORDER BY COALESCE(o.last_attempt_at, o.created_at) DESC
     LIMIT 100`,
    [portfolioIdList(portfolioIds)],
  );
  return withOrderLane(rows);
}

export async function getTradeDetail(portfolioIds: string | string[], orderId: string) {
  const { rows } = await query(
    `SELECT o.*, t.symbol, t.name, t.address, t.chain,
       s.created_at AS signal_at, s.explanation, s.market_state, s.overall_score,
       s.momentum_score, s.liquidity_score, s.volume_score, s.holder_score, s.risk_score, s.risk_label,
       COALESCE(p.strategy_key, s.strategy_name) AS strategy_id
     FROM paper_orders o
     JOIN tokens t ON t.id = o.token_id
     LEFT JOIN signals s ON s.id = o.signal_id
     LEFT JOIN positions p ON p.id = o.position_id
     WHERE o.portfolio_id = ANY($1::uuid[]) AND o.id = $2`,
    [portfolioIdList(portfolioIds), orderId],
  );
  const order = rows[0] ? withOrderLane(rows)[0] : undefined;
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
  portfolioIds: string | string[],
  opts: { q?: string; level?: string; category?: string; limit: number },
): Promise<BotEventData[]> {
  const clauses = [`(e.portfolio_id = ANY($1::uuid[]) OR e.portfolio_id IS NULL)`, `e.data_mode = $2`];
  const params: unknown[] = [portfolioIdList(portfolioIds), dataMode];
  if (opts.level) {
    params.push(opts.level);
    clauses.push(`e.level = $${params.length}`);
  }
  if (opts.category) {
    params.push(opts.category);
    clauses.push(`e.category = $${params.length}`);
  }
  if (opts.q) {
    params.push(`%${opts.q}%`);
    clauses.push(`e.message ILIKE $${params.length}`);
  }
  params.push(opts.limit);
  const { rows } = await query(
    `SELECT e.*, s.strategy_name AS signal_strategy
     FROM bot_events e
     LEFT JOIN signals s ON s.id = CASE
       WHEN e.details->>'signalId' ~ '^[0-9a-fA-F-]{36}$' THEN (e.details->>'signalId')::uuid
     END
     WHERE ${clauses.join(' AND ')}
     ORDER BY e.created_at DESC LIMIT $${params.length}`,
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
    lane: portfolioLane(r.portfolio_id),
    strategyId: r.signal_strategy ?? eventStrategyId(r.details),
  }));
}

/** Latest BUY signals for the given portfolios, with the routed portfolio's latest execution attempt. */
export async function getRecentSignals(portfolioIds: string | string[], limit: number) {
  const { rows } = await query<{
    id: string;
    token_id: string;
    symbol: string | null;
    strategy_id: string;
    lane: string;
    portfolio_id: string | null;
    expected_value: string | null;
    overall_score: string | null;
    confidence: string | null;
    created_at: Date;
    attempt_status: string | null;
    attempt_reason: string | null;
    order_status: string | null;
    order_reason: string | null;
    risk_decision: string | null;
    risk_reason: string | null;
    risk_exec_status: string | null;
    risk_exec_reason: string | null;
    position_open: boolean;
    trades_before: string;
  }>(
    `WITH base AS (
       SELECT s.id, s.token_id, t.symbol, s.strategy_name AS strategy_id, s.lane,
              ${signalPortfolioSql('s', '$2', '$3')} AS portfolio_id,
              s.expected_value, s.overall_score, s.confidence, s.created_at
       FROM signals s
       LEFT JOIN tokens t ON t.id = s.token_id
       WHERE s.data_mode = $1 AND s.side = 'BUY'
         AND ${signalPortfolioSql('s', '$2', '$3')} = ANY($4::uuid[])
       ORDER BY s.created_at DESC
       LIMIT $5
     )
     SELECT b.*,
            a.status AS attempt_status, a.status_reason AS attempt_reason,
            o.status AS order_status, o.failure_reason AS order_reason,
            rd.decision AS risk_decision, rd.rejection_reason AS risk_reason,
            rd.execution_status AS risk_exec_status, rd.execution_reason AS risk_exec_reason,
            EXISTS (
              SELECT 1 FROM positions p
              WHERE p.portfolio_id = b.portfolio_id AND p.token_id = b.token_id
                AND p.opened_at <= b.created_at AND (p.closed_at IS NULL OR p.closed_at > b.created_at)
            ) AS position_open,
            (SELECT COUNT(*) FROM positions p
             WHERE p.portfolio_id = b.portfolio_id
               AND p.opened_at >= date_trunc('day', b.created_at) AND p.opened_at < b.created_at
            )::text AS trades_before
     FROM base b
     LEFT JOIN LATERAL (
       SELECT status, status_reason FROM signal_execution_attempts sea
       WHERE sea.signal_id = b.id ORDER BY sea.last_attempt_at DESC LIMIT 1
     ) a ON TRUE
     LEFT JOIN LATERAL (
       SELECT status, failure_reason FROM paper_orders po
       WHERE po.signal_id = b.id ORDER BY po.created_at DESC LIMIT 1
     ) o ON TRUE
     LEFT JOIN LATERAL (
       SELECT decision, rejection_reason, execution_status, execution_reason FROM risk_decisions r
       WHERE r.signal_id = b.id ORDER BY r.evaluated_at DESC LIMIT 1
     ) rd ON TRUE
     ORDER BY b.created_at DESC`,
    [dataMode, env.DEFAULT_PORTFOLIO_ID, RESEARCH_PORTFOLIO_ID, portfolioIdList(portfolioIds), limit],
  );
  return rows.map((r) => {
    const outcome = signalOutcome(r);
    return {
      id: r.id,
      tokenId: r.token_id,
      symbol: r.symbol,
      strategyId: r.strategy_id,
      lane: portfolioLane(r.portfolio_id),
      expectedValue: r.expected_value != null ? Number(r.expected_value) : null,
      overallScore: r.overall_score != null ? Number(r.overall_score) : null,
      confidence: r.confidence,
      createdAt: r.created_at.toISOString(),
      executionStatus: outcome.status,
      executionReason: outcome.reason,
    };
  });
}

/** Signals are only picked up by a lane for this long after creation (see executeLane). */
const SIGNAL_PICKUP_WINDOW_MS = 10 * 60_000;

function researchDailyCapFor(portfolioId: string | null): number | null {
  if (portfolioId === RESEARCH_PORTFOLIO_ID) return env.RESEARCH_MAX_TRADES_PER_DAY;
  if (portfolioId === OLDER_TOKEN_RESEARCH_PORTFOLIO_ID) return env.OLDER_TOKEN_RESEARCH_MAX_TRADES_PER_DAY;
  return null;
}

/** Best available explanation of what happened to a signal, from the most to the least specific record. */
function signalOutcome(r: {
  portfolio_id: string | null;
  created_at: Date;
  attempt_status: string | null;
  attempt_reason: string | null;
  order_status: string | null;
  order_reason: string | null;
  risk_decision: string | null;
  risk_reason: string | null;
  risk_exec_status: string | null;
  risk_exec_reason: string | null;
  position_open: boolean;
  trades_before: string;
}): { status: string; reason: string | null } {
  if (r.attempt_status) return { status: r.attempt_status, reason: r.attempt_reason };
  if (r.order_status === 'FAILED') return { status: 'EXECUTION_FAILED', reason: r.order_reason };
  if (r.order_status) return { status: 'EXECUTED', reason: null };
  if (r.risk_decision === 'REJECTED') return { status: 'RISK_REJECTED', reason: r.risk_reason };
  if (r.risk_decision) {
    return { status: r.risk_exec_status ?? r.risk_decision, reason: r.risk_exec_reason ?? r.risk_reason };
  }
  if (r.position_open) return { status: 'SKIPPED', reason: 'position_already_open_on_token' };
  const cap = researchDailyCapFor(r.portfolio_id);
  if (cap != null && Number(r.trades_before) >= cap) {
    return { status: 'SKIPPED', reason: `research_daily_cap_reached (${cap}/day)` };
  }
  if (Date.now() - r.created_at.getTime() > SIGNAL_PICKUP_WINDOW_MS) {
    return { status: 'EXPIRED', reason: 'not_picked_up_within_10m' };
  }
  return { status: 'PENDING', reason: null };
}

/** Older-token research portfolio only — never mixed with production stats. */
export async function getOlderTokenResearchSummary() {
  const id = OLDER_TOKEN_RESEARCH_PORTFOLIO_ID;
  const [portfolio, byStrategy, signals, candidates, recentCandidates] = await Promise.all([
    getPortfolio(id),
    query<{ strategy_id: string; open: string; closed: string; wins: string; net_pnl: string; today: string }>(
      `SELECT COALESCE(strategy_key, '-') AS strategy_id,
              COUNT(*) FILTER (WHERE status = 'OPEN')::text AS open,
              COUNT(*) FILTER (WHERE status = 'CLOSED')::text AS closed,
              COUNT(*) FILTER (WHERE status = 'CLOSED' AND net_pnl_usd > 0)::text AS wins,
              COALESCE(SUM(net_pnl_usd) FILTER (WHERE status = 'CLOSED'), 0)::text AS net_pnl,
              COUNT(*) FILTER (WHERE opened_at >= date_trunc('day', NOW()))::text AS today
       FROM positions WHERE portfolio_id = $1
       GROUP BY 1 ORDER BY 1`,
      [id],
    ),
    query<{ strategy_id: string; n: string }>(
      `SELECT strategy_name AS strategy_id, COUNT(*)::text AS n
       FROM signals
       WHERE target_portfolio_id = $1 AND data_mode = $2 AND created_at > NOW() - INTERVAL '60 minutes'
       GROUP BY 1 ORDER BY 1`,
      [id, dataMode],
    ),
    query<{ strategy_id: string; reason: string; n: string }>(
      `SELECT strategy_id, COALESCE(features->>'rejectionReason', 'signal_emitted') AS reason, COUNT(*)::text AS n
       FROM opportunities
       WHERE decision IN ('OLDER_RESEARCH_SIGNAL', 'OLDER_RESEARCH_REJECTED')
         AND observed_at > NOW() - INTERVAL '24 hours'
       GROUP BY 1, 2 ORDER BY 3 DESC`,
    ),
    query<{
      observed_at: Date;
      strategy_id: string;
      token_id: string;
      symbol: string | null;
      decision: string;
      reason: string | null;
      cost_rate: string | null;
      liquidity_usd: string | null;
    }>(
      `SELECT o.observed_at, o.strategy_id, o.token_id, t.symbol, o.decision,
              o.features->>'rejectionReason' AS reason, o.execution_cost_rate::text AS cost_rate,
              o.liquidity_usd::text AS liquidity_usd
       FROM opportunities o LEFT JOIN tokens t ON t.id = o.token_id
       WHERE o.decision IN ('OLDER_RESEARCH_SIGNAL', 'OLDER_RESEARCH_REJECTED')
       ORDER BY o.observed_at DESC LIMIT 8`,
    ),
  ]);
  return {
    enabled: env.OLDER_TOKEN_RESEARCH_ENABLED,
    maxTradesPerDay: env.OLDER_TOKEN_RESEARCH_MAX_TRADES_PER_DAY,
    maxRoundTripCostPct: env.OLDER_TOKEN_RESEARCH_MAX_ROUND_TRIP_COST_PCT,
    candidatesLast24h: candidates.rows.map((r) => ({
      strategyId: r.strategy_id,
      reason: r.reason,
      count: Number(r.n),
    })),
    recentCandidates: recentCandidates.rows.map((r) => ({
      observedAt: r.observed_at.toISOString(),
      strategyId: r.strategy_id,
      tokenId: r.token_id,
      symbol: r.symbol,
      signalled: r.decision === 'OLDER_RESEARCH_SIGNAL',
      reason: r.reason,
      costRate: r.cost_rate != null ? Number(r.cost_rate) : null,
      liquidityUsd: r.liquidity_usd != null ? Number(r.liquidity_usd) : null,
    })),
    portfolio,
    strategies: byStrategy.rows.map((r) => ({
      strategyId: r.strategy_id,
      open: Number(r.open),
      closed: Number(r.closed),
      wins: Number(r.wins),
      netPnlUsd: Number(r.net_pnl),
      openedToday: Number(r.today),
    })),
    signalsLastHour: signals.rows.map((r) => ({ strategyId: r.strategy_id, count: Number(r.n) })),
  };
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
  const safety = await query(
    `SELECT score, safety_class, blocked, reasons, assessed_at, version
     FROM safety_assessments WHERE token_id = $1 ORDER BY assessed_at DESC LIMIT 5`,
    [tokenId],
  );
  const phases = await query(
    `SELECT phase, reasons, observed_at FROM token_phases WHERE token_id = $1 ORDER BY observed_at ASC LIMIT 100`,
    [tokenId],
  );
  const events = await query(
    `SELECT event_type, payload, observed_at, source FROM market_events
     WHERE token_id = $1 ORDER BY observed_at ASC LIMIT 200`,
    [tokenId],
  );
  const trades = await query(
    `SELECT side, amount_usd, price_usd, observed_at, source, confidence
     FROM trade_events WHERE token_id = $1 ORDER BY observed_at DESC LIMIT 100`,
    [tokenId],
  );

  return {
    token: token.rows[0],
    marketHistory: markets.rows,
    holders: holders.rows[0] ?? null,
    signal: signal.rows[0]
      ? {
          ...signal.rows[0],
          portfolio_lane: signalLane(signal.rows[0].lane, signal.rows[0].target_portfolio_id),
          scoreDisclaimer: SCORE_DISCLAIMER,
        }
      : null,
    safety: safety.rows,
    phases: phases.rows,
    timeline: events.rows,
    tradeEvents: trades.rows,
    scoreDisclaimer: SCORE_DISCLAIMER,
  };
}

export async function getShadowTrades(portfolioId: string, limit = 100) {
  const { rows } = await query(
    `SELECT s.*, t.symbol, t.address
     FROM shadow_trades s
     JOIN tokens t ON t.id = s.token_id
     WHERE s.portfolio_id = $1
     ORDER BY s.opened_at DESC
     LIMIT $2`,
    [portfolioId, limit],
  );
  return rows;
}

export async function getMissedOpportunities(portfolioId: string, limit = 100) {
  const { rows } = await query(
    `SELECT m.*, t.symbol
     FROM missed_opportunities m
     JOIN tokens t ON t.id = m.token_id
     WHERE m.portfolio_id = $1
     ORDER BY m.observed_at DESC
     LIMIT $2`,
    [portfolioId, limit],
  );
  return rows;
}

export async function getRegimeHistory(limit = 50) {
  const { rows } = await query(
    `SELECT regime, payload, observed_at FROM regime_snapshots
     WHERE data_mode = $1 ORDER BY observed_at DESC LIMIT $2`,
    [dataMode, limit],
  );
  return rows;
}

export async function getSystemHealth() {
  const { rows } = await query(
    `SELECT component, status, metrics, observed_at FROM system_health
     ORDER BY observed_at DESC LIMIT 20`,
  );
  return {
    paperTradingOnly: true,
    tradingMode: 'PAPER',
    realExecutionEnabled: false,
    walletSigningEnabled: false,
    dataMode,
    realismProfile,
    recent: rows,
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
    paperOnlyDisclaimer: PAPER_ONLY_DISCLAIMER,
    tradingMode: 'PAPER',
    realExecutionEnabled: false,
    walletSigningEnabled: false,
    realismProfile,
  };
}
