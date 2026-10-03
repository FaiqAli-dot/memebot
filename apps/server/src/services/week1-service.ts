/**
 * Week-1 daily observability: one read-only snapshot of trading, performance, execution,
 * risk, per-strategy and learning state for the production paper portfolio.
 */
import type { Week1Overview, Week1PerformanceStats, Week1StrategyRow } from '@memebot/shared';
import { query } from '../db/client.js';
import { dataMode, env } from '../config/env.js';
import { getPortfolio } from './portfolio-service.js';
import { getLearningStatus } from '../learning/status-service.js';
import { learningModeInfo } from '../learning/mode.js';
import { wilson } from '../learning/stats.js';

const num = (v: unknown) => (v == null ? 0 : Number(v));
const numOrNull = (v: unknown) => (v == null ? null : Number(v));

interface ClosedRow {
  net_pnl_usd: string;
  opened_at: Date;
  closed_at: Date;
}

export function performanceStats(rows: Array<{ netPnlUsd: number; holdSec: number }>): Week1PerformanceStats {
  const wins = rows.filter((r) => r.netPnlUsd > 0);
  const losses = rows.filter((r) => r.netPnlUsd <= 0);
  const grossWin = wins.reduce((a, r) => a + r.netPnlUsd, 0);
  const grossLoss = -losses.reduce((a, r) => a + r.netPnlUsd, 0);
  const ci = rows.length ? wilson(wins.length, rows.length) : null;
  return {
    closedTrades: rows.length,
    wins: wins.length,
    losses: losses.length,
    winRatePct: rows.length ? (wins.length / rows.length) * 100 : null,
    winRateCI: ci ? { low: ci.low * 100, high: ci.high * 100 } : null,
    realizedPnlUsd: rows.reduce((a, r) => a + r.netPnlUsd, 0),
    avgWinUsd: wins.length ? grossWin / wins.length : null,
    avgLossUsd: losses.length ? -grossLoss / losses.length : null,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
    avgHoldSec: rows.length ? rows.reduce((a, r) => a + r.holdSec, 0) / rows.length : null,
  };
}

const toPerf = (rows: ClosedRow[]) =>
  performanceStats(
    rows.map((r) => ({
      netPnlUsd: Number(r.net_pnl_usd),
      holdSec: Math.max(0, (r.closed_at.getTime() - r.opened_at.getTime()) / 1000),
    })),
  );

const SIZE_BUCKETS: Array<[string, number]> = [
  ['< $2', 2],
  ['$2–5', 5],
  ['$5–10', 10],
  ['$10–25', 25],
  ['≥ $25', Infinity],
];

export async function getWeek1Overview(windowHours = 24, now = new Date()): Promise<Week1Overview> {
  const portfolioId = env.DEFAULT_PORTFOLIO_ID;
  const since = new Date(now.getTime() - windowHours * 3600_000);
  const p = [dataMode, since] as const;

  const [tokens, signals, positions, closedAll, costs, risk, sizes, stratSignals, stratTrades, checks, portfolio, learning] =
    await Promise.all([
      query<{ discovered: string; tracked: string; eligible: string }>(
        `SELECT COUNT(*) FILTER (WHERE discovered_at > $2) AS discovered,
                COUNT(*) FILTER (WHERE lifecycle_state IN ('TRACKING','ACTIVE')) AS tracked,
                COUNT(*) FILTER (WHERE trading_eligibility = 'TRADING_ELIGIBLE' AND lifecycle_state <> 'ARCHIVED') AS eligible
         FROM tokens WHERE data_mode = $1`,
        [...p],
      ),
      query<{ lane: string | null; n: string }>(
        `SELECT lane, COUNT(*) AS n FROM signals WHERE data_mode = $1 AND created_at > $2 AND side = 'BUY' GROUP BY lane`,
        [...p],
      ),
      query<{ opened: string; closed: string; open_now: string; unrealized: string; exposure: string; planned: string | null; worst: string | null }>(
        `SELECT COUNT(*) FILTER (WHERE opened_at > $2) AS opened,
                COUNT(*) FILTER (WHERE status = 'CLOSED' AND closed_at > $2) AS closed,
                COUNT(*) FILTER (WHERE status = 'OPEN') AS open_now,
                COALESCE(SUM(unrealized_pnl_usd) FILTER (WHERE status = 'OPEN'), 0) AS unrealized,
                COALESCE(SUM(cost_basis_usd) FILTER (WHERE status = 'OPEN'), 0) AS exposure,
                MAX(max_planned_loss_usd) FILTER (WHERE opened_at > $2 OR status = 'OPEN') AS planned,
                MIN(net_pnl_usd) FILTER (WHERE status = 'CLOSED' AND closed_at > $2) AS worst
         FROM positions WHERE portfolio_id = $3 AND data_mode = $1`,
        [...p, portfolioId],
      ),
      query<ClosedRow>(
        `SELECT net_pnl_usd, opened_at, closed_at FROM positions
         WHERE portfolio_id = $2 AND data_mode = $1 AND status = 'CLOSED' AND closed_at IS NOT NULL`,
        [dataMode, portfolioId],
      ),
      query<{ fees: string; network: string; slippage: string; impact: string; total: string; slip_rate: string | null; impact_rate: string | null }>(
        `WITH legs AS (
           SELECT entry_costs AS c FROM positions WHERE portfolio_id = $3 AND data_mode = $1 AND opened_at > $2
           UNION ALL
           SELECT exit_costs FROM positions WHERE portfolio_id = $3 AND data_mode = $1 AND status = 'CLOSED' AND closed_at > $2
         )
         SELECT COALESCE(SUM((c->>'dexFeeUsd')::numeric), 0) AS fees,
                COALESCE(SUM((c->>'networkFeeUsd')::numeric), 0) AS network,
                COALESCE(SUM((c->>'slippageCostUsd')::numeric), 0) AS slippage,
                COALESCE(SUM((c->>'priceImpactCostUsd')::numeric), 0) AS impact,
                COALESCE(SUM((c->>'totalCostUsd')::numeric), 0) AS total,
                (SELECT AVG(actual_slippage_rate) FROM trade_observations
                  WHERE data_mode = $1 AND portfolio_type = 'PRODUCTION' AND exit_at > $2) AS slip_rate,
                (SELECT AVG(actual_impact_rate) FROM trade_observations
                  WHERE data_mode = $1 AND portfolio_type = 'PRODUCTION' AND exit_at > $2) AS impact_rate
         FROM legs WHERE c IS NOT NULL`,
        [...p, portfolioId],
      ),
      query<{ reason: string | null; n: string }>(
        `SELECT rejection_reason AS reason, COUNT(*) AS n FROM risk_decisions
         WHERE portfolio_id = $3 AND data_mode = $1 AND decision = 'REJECTED' AND evaluated_at > $2
         GROUP BY 1 ORDER BY 2 DESC`,
        [...p, portfolioId],
      ),
      query<{ size: string }>(
        `SELECT cost_basis_usd AS size FROM positions WHERE portfolio_id = $3 AND data_mode = $1 AND opened_at > $2`,
        [...p, portfolioId],
      ),
      query<{ strategy: string; n: string }>(
        `SELECT strategy_name AS strategy, COUNT(*) AS n FROM signals
         WHERE data_mode = $1 AND created_at > $2 AND side = 'BUY' AND lane = 'PRODUCTION' GROUP BY 1`,
        [...p],
      ),
      query<{ strategy: string; opened: string; closed: string; wins: string; pnl: string; avg_ev: string | null; avg_size: string | null }>(
        `SELECT COALESCE(strategy_key, 'unknown') AS strategy,
                COUNT(*) FILTER (WHERE opened_at > $2) AS opened,
                COUNT(*) FILTER (WHERE status = 'CLOSED' AND closed_at > $2) AS closed,
                COUNT(*) FILTER (WHERE status = 'CLOSED' AND closed_at > $2 AND net_pnl_usd > 0) AS wins,
                COALESCE(SUM(net_pnl_usd) FILTER (WHERE status = 'CLOSED' AND closed_at > $2), 0) AS pnl,
                AVG(expected_net_value) FILTER (WHERE opened_at > $2) AS avg_ev,
                AVG(cost_basis_usd) FILTER (WHERE opened_at > $2) AS avg_size
         FROM positions WHERE portfolio_id = $3 AND data_mode = $1 AND (opened_at > $2 OR closed_at > $2)
         GROUP BY 1`,
        [...p, portfolioId],
      ),
      query<{ checks: string; warnings: string; critical: string }>(
        `SELECT COUNT(*) AS checks, COALESCE(SUM(warning_count), 0) AS warnings, COALESCE(SUM(critical_count), 0) AS critical
         FROM learning_health_checks WHERE data_mode = $1 AND created_at > $2`,
        [...p],
      ),
      getPortfolio(portfolioId),
      getLearningStatus(now),
    ]);

  const lanes = Object.fromEntries(signals.rows.map((r) => [r.lane ?? 'UNKNOWN', Number(r.n)]));
  const pos = positions.rows[0]!;
  const closedRows = closedAll.rows;
  const c = costs.rows[0];
  const equity = portfolio?.equityUsd ?? env.INITIAL_BALANCE_USD;

  const sizeCounts = SIZE_BUCKETS.map(([bucket]) => ({ bucket, count: 0 }));
  for (const r of sizes.rows) {
    const i = SIZE_BUCKETS.findIndex(([, max]) => Number(r.size) < max);
    sizeCounts[i]!.count++;
  }

  const sigBy = new Map(stratSignals.rows.map((r) => [r.strategy, Number(r.n)]));
  const tradeBy = new Map(stratTrades.rows.map((r) => [r.strategy, r]));
  const strategies: Week1StrategyRow[] = [...new Set([...sigBy.keys(), ...tradeBy.keys()])].sort().map((id) => {
    const t = tradeBy.get(id);
    const closed = num(t?.closed);
    const wins = num(t?.wins);
    return {
      strategyId: id,
      signals: sigBy.get(id) ?? 0,
      trades: num(t?.opened),
      closed,
      wins,
      losses: closed - wins,
      winRatePct: closed ? (wins / closed) * 100 : null,
      avgPredictedEv: numOrNull(t?.avg_ev),
      realizedPnlUsd: num(t?.pnl),
      avgPositionSizeUsd: numOrNull(t?.avg_size),
    };
  });

  const window = toPerf(closedRows.filter((r) => r.closed_at > since));
  const q = learning.observation.quality;
  return {
    generatedAt: now.toISOString(),
    windowHours,
    mode: learningModeInfo(),
    trading: {
      tokensDiscovered: num(tokens.rows[0]?.discovered),
      tokensTracked: num(tokens.rows[0]?.tracked),
      tokensEligible: num(tokens.rows[0]?.eligible),
      signals: Object.values(lanes).reduce((a, b) => a + b, 0),
      productionSignals: lanes.PRODUCTION ?? 0,
      researchSignals: lanes.RESEARCH ?? 0,
      tradesOpened: num(pos.opened),
      tradesClosed: num(pos.closed),
      openPositions: num(pos.open_now),
    },
    performance: {
      window,
      allTime: toPerf(closedRows),
      unrealizedPnlUsd: num(pos.unrealized),
      sampleNote: `${closedRows.length} closed production trades so far — far too few to judge profitability; intervals show the uncertainty.`,
    },
    execution: {
      avgSlippageRate: numOrNull(c?.slip_rate),
      avgPriceImpactRate: numOrNull(c?.impact_rate),
      feesUsd: num(c?.fees),
      networkCostsUsd: num(c?.network),
      slippageCostsUsd: num(c?.slippage),
      priceImpactCostsUsd: num(c?.impact),
      totalTradingCostsUsd: num(c?.total),
    },
    risk: {
      maxPortfolioExposureUsd: equity * env.MAX_PORTFOLIO_EXPOSURE_PCT,
      currentExposureUsd: num(pos.exposure),
      largestPlannedLossUsd: numOrNull(pos.planned),
      largestRealizedLossUsd: pos.worst != null && Number(pos.worst) < 0 ? Number(pos.worst) : null,
      riskRejections: risk.rows.reduce((a, r) => a + Number(r.n), 0),
      rejectionsByReason: risk.rows.map((r) => ({ key: r.reason ?? 'unknown', count: Number(r.n) })),
      positionSizeDistribution: sizeCounts,
    },
    strategies,
    learning: {
      observations: learning.observation.completed,
      trueEntrySnapshots: q.trueEntrySnapshots,
      partialEntrySnapshots: q.partialEntrySnapshots,
      signalBackfills: q.signalBackfills,
      research: q.research,
      calibrationEligible: q.calibrationEligible,
      healthChecksWindow: num(checks.rows[0]?.checks),
      warningsWindow: num(checks.rows[0]?.warnings),
      criticalWindow: num(checks.rows[0]?.critical),
      calibrationStatus: learning.calibration.gate.decision,
      calibrationReason: learning.calibration.gate.reason,
      lastCalibrationAt: learning.calibration.lastPerformedAt,
      nextEligibleAt: learning.calibration.nextEligibleAt,
      versionCounts: learning.calibration.versionCounts,
    },
  };
}
