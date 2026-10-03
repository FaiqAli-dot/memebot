import type { StrategyInputs } from '@memebot/shared';
import { query } from '../db/client.js';
import { dataMode } from '../config/env.js';
import type { ObservationQuality } from './observations.js';

/** Completed-trade observation as consumed by health checks and calibration. */
export interface ObservationRecord {
  seq: number;
  positionId: string;
  tokenId: string;
  symbol: string | null;
  portfolioType: 'PRODUCTION' | 'RESEARCH';
  quality: ObservationQuality;
  strategyId: string;
  entryAt: Date;
  exitAt: Date;
  entryPriceUsd: number;
  exitPriceUsd: number | null;
  positionSizeUsd: number;
  requestedSizeUsd: number | null;
  predictedEv: number | null;
  predictedWinProbability: number | null;
  dataConfidence: string | null;
  riskTier: string | null;
  marketRegime: string | null;
  liquidityBucket: string | null;
  maxPlannedLossUsd: number | null;
  estimatedCostRate: number | null;
  estimatedSlippageRate: number | null;
  estimatedImpactRate: number | null;
  actualCostUsd: number | null;
  actualCostRate: number | null;
  actualSlippageRate: number | null;
  actualImpactRate: number | null;
  netPnlUsd: number;
  grossPnlUsd: number;
  netReturn: number;
  win: boolean;
  mfePct: number | null;
  maePct: number | null;
  exitReason: string | null;
  quoteAgeMs: number | null;
  entryLiquidityUsd: number | null;
  entryVolume5mUsd: number | null;
  strategyInputs: StrategyInputs | null;
}

const n = (v: unknown): number | null => (v == null ? null : Number.isFinite(Number(v)) ? Number(v) : null);

function map(r: Record<string, unknown>): ObservationRecord {
  const f = (r.entry_features ?? {}) as Record<string, unknown>;
  return {
    seq: Number(r.seq),
    positionId: String(r.position_id),
    tokenId: String(r.token_id),
    symbol: (r.symbol as string | null) ?? null,
    portfolioType: r.portfolio_type as ObservationRecord['portfolioType'],
    quality: r.observation_quality as ObservationQuality,
    strategyId: String(r.strategy_id),
    entryAt: new Date(r.entry_at as Date),
    exitAt: new Date(r.exit_at as Date),
    entryPriceUsd: Number(r.entry_price_usd),
    exitPriceUsd: n(r.exit_price_usd),
    positionSizeUsd: Number(r.position_size_usd),
    requestedSizeUsd: n(r.requested_size_usd),
    predictedEv: n(r.predicted_ev),
    predictedWinProbability: n(r.predicted_win_probability),
    dataConfidence: (r.data_confidence as string | null) ?? null,
    riskTier: (r.risk_tier as string | null) ?? null,
    marketRegime: (r.market_regime as string | null) ?? null,
    liquidityBucket: (r.liquidity_bucket as string | null) ?? null,
    maxPlannedLossUsd: n(r.max_planned_loss_usd),
    estimatedCostRate: n(r.estimated_cost_rate),
    estimatedSlippageRate: n(r.estimated_slippage_rate),
    estimatedImpactRate: n(r.estimated_impact_rate),
    actualCostUsd: n(r.actual_cost_usd),
    actualCostRate: n(r.actual_cost_rate),
    actualSlippageRate: n(r.actual_slippage_rate),
    actualImpactRate: n(r.actual_impact_rate),
    netPnlUsd: Number(r.net_pnl_usd),
    grossPnlUsd: Number(r.gross_pnl_usd),
    netReturn: Number(r.net_return),
    win: Boolean(r.win),
    mfePct: n(r.mfe_pct),
    maePct: n(r.mae_pct),
    exitReason: (r.exit_reason as string | null) ?? null,
    quoteAgeMs: n(f.quoteAgeMs),
    entryLiquidityUsd: n(f.liquidityUsd),
    entryVolume5mUsd: n(f.volume5mUsd),
    strategyInputs: (f.strategyInputs as StrategyInputs | null | undefined) ?? null,
  };
}

/** Observations in sequence order (oldest first). Only completed trades exist in this table. */
export async function loadObservations(opts: {
  portfolioType?: 'PRODUCTION' | 'RESEARCH';
  /** e.g. 'TRUE_ENTRY_SNAPSHOT' for calibration-grade evidence only */
  quality?: ObservationQuality;
  afterSeq?: number;
  exitAfter?: Date;
  limit?: number;
} = {}): Promise<ObservationRecord[]> {
  const { rows } = await query(
    `SELECT * FROM (
       SELECT * FROM trade_observations
       WHERE data_mode = $1
         AND ($2::text IS NULL OR portfolio_type = $2)
         AND ($5::text IS NULL OR observation_quality = $5)
         AND ($6::timestamptz IS NULL OR exit_at > $6)
         AND seq > $3
       ORDER BY seq DESC
       LIMIT $4
     ) t ORDER BY seq ASC`,
    [
      dataMode,
      opts.portfolioType ?? null,
      opts.afterSeq ?? 0,
      opts.limit ?? 5000,
      opts.quality ?? null,
      opts.exitAfter ?? null,
    ],
  );
  return rows.map(map);
}
