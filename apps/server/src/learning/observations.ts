/**
 * LEVEL 1 — per-trade observation.
 *
 * Every completed paper/research position becomes one immutable `trade_observations` row.
 * Input features come ONLY from data captured at or before entry (the position's
 * entry_snapshot, or for older positions the signal's market_state). Outcome values
 * (exit price, P&L, MFE/MAE) are stored in separate outcome columns and never mixed
 * into `entry_features`. Recording an observation never changes any model parameter.
 */
import type { StrategyInputs } from '@memebot/shared';
import { query } from '../db/client.js';
import { winProbabilityFromConfidence } from '../risk/expected-value.js';
import { strategyInputsFromMarketState } from '../engines/learning/analyze.js';
import { logger } from '../utils/logger.js';

export type SnapshotSource = 'ENTRY_SNAPSHOT' | 'SIGNAL_BACKFILL';

/**
 * TRUE_ENTRY_SNAPSHOT    — captured at execution with every core entry input: calibration-grade
 * PARTIAL_ENTRY_SNAPSHOT — captured at execution but missing a core input: descriptive only
 * SIGNAL_BACKFILL        — reconstructed later from the signal: descriptive only
 * Mirrored by the generated column `trade_observations.observation_quality` (migration 009).
 */
export type ObservationQuality = 'TRUE_ENTRY_SNAPSHOT' | 'PARTIAL_ENTRY_SNAPSHOT' | 'SIGNAL_BACKFILL';
export const CALIBRATION_GRADE_QUALITY: ObservationQuality = 'TRUE_ENTRY_SNAPSHOT';
export const CORE_ENTRY_FEATURES = ['observedAt', 'quoteAgeMs', 'liquidityUsd', 'priceChange5mPct', 'volume5mUsd'] as const;

export function observationQuality(source: SnapshotSource, features: Partial<EntryFeatures>): ObservationQuality {
  if (source !== 'ENTRY_SNAPSHOT') return 'SIGNAL_BACKFILL';
  return CORE_ENTRY_FEATURES.every((k) => features[k] != null) ? 'TRUE_ENTRY_SNAPSHOT' : 'PARTIAL_ENTRY_SNAPSHOT';
}

/** Outcome values: allowed only as labels in outcome columns, never as entry features. */
export const OUTCOME_FIELDS = [
  'exitPriceUsd',
  'exitAt',
  'closedAt',
  'currentPriceUsd',
  'highestPriceUsd',
  'netPnlUsd',
  'grossPnlUsd',
  'realizedPnlUsd',
  'netReturn',
  'win',
  'mfePct',
  'maePct',
  'mfeAt',
  'maeAt',
  'timeToMfeSec',
  'timeToMaeSec',
  'exitReason',
  'closeReason',
  'exitCosts',
] as const;

/** Drops any outcome field from entry features (top level and strategy inputs). */
export function sanitizeEntryFeatures(f: EntryFeatures): EntryFeatures {
  const strip = <T extends object>(o: T): T =>
    Object.fromEntries(Object.entries(o).filter(([k]) => !(OUTCOME_FIELDS as readonly string[]).includes(k))) as T;
  const out = strip(f);
  return { ...out, strategyInputs: f.strategyInputs ? strip(f.strategyInputs) : null };
}

/** Entry-time inputs. Every value here was known when the trade was opened. */
export interface EntryFeatures {
  observedAt: string | null;
  quoteAgeMs: number | null;
  signalAt: string | null;
  tokenAgeMinutes: number | null;
  liquidityUsd: number | null;
  liquidityStatus: string | null;
  volume5mUsd: number | null;
  volume1hUsd: number | null;
  volumeAcceleration: number | null;
  volumeAccelerationConfidence: string | null;
  buyVolume5mUsd: number | null;
  sellVolume5mUsd: number | null;
  buyCount5m: number | null;
  sellCount5m: number | null;
  txCount5m: number | null;
  uniqueBuyers: number | null;
  uniqueSellers: number | null;
  priceChange5mPct: number | null;
  priceChange1hPct: number | null;
  marketRegime: string | null;
  tokenPhase: string | null;
  dataConfidence: string | null;
  topHolderPct?: number | null;
  /** Exactly what the strategy compared against its thresholds at signal time */
  strategyInputs?: StrategyInputs | null;
  /** The strategy's thresholds in force when the signal was produced */
  strategyParamsAtEntry?: Record<string, number> | null;
}

export interface PositionForObservation {
  id: string;
  portfolio_id: string;
  portfolio_type: string;
  token_id: string;
  symbol: string | null;
  strategy_key: string | null;
  strategy_name: string | null;
  strategy_version: string | null;
  opened_at: Date;
  closed_at: Date;
  entry_price_usd: string | number;
  current_price_usd: string | number;
  cost_basis_usd: string | number;
  gross_pnl_usd: string | number;
  net_pnl_usd: string | number;
  entry_costs: Record<string, unknown> | null;
  exit_costs: Record<string, unknown> | null;
  close_reason: string | null;
  stop_loss_pct: string | number | null;
  take_profit_pct: string | number | null;
  trailing_stop_pct: string | number | null;
  mfe_pct: string | number | null;
  mae_pct: string | number | null;
  mfe_at: Date | null;
  mae_at: Date | null;
  risk_tier: string | null;
  requested_size_usd: string | number | null;
  max_planned_loss_usd: string | number | null;
  expected_net_value: string | number | null;
  market_regime: string | null;
  token_phase: string | null;
  journal: Record<string, unknown> | null;
  entry_snapshot: Record<string, unknown> | null;
  signal_market_state: Record<string, unknown> | null;
  signal_expected_value: Record<string, unknown> | null;
  signal_confidence: string | number | null;
  signal_overall_score: string | number | null;
  signal_data_confidence: string | null;
  signal_created_at: Date | null;
  risk_version: string | null;
  execution_model_version: string | null;
  safety_version: string | null;
  data_mode: string;
}

export interface TradeObservation {
  positionId: string;
  portfolioId: string;
  portfolioType: 'PRODUCTION' | 'RESEARCH';
  tokenId: string;
  symbol: string | null;
  strategyId: string;
  strategyVersion: string | null;
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
  expectedReturn: number | null;
  expectedLoss: number | null;
  maxPlannedLossUsd: number | null;
  estimatedCostUsd: number | null;
  estimatedCostRate: number | null;
  estimatedSlippageRate: number | null;
  estimatedImpactRate: number | null;
  stopLossPct: number | null;
  takeProfitPct: number | null;
  trailingStopPct: number | null;
  maxHoldSec: number | null;
  actualCostUsd: number | null;
  actualCostRate: number | null;
  actualSlippageRate: number | null;
  actualImpactRate: number | null;
  grossPnlUsd: number;
  netPnlUsd: number;
  netReturn: number;
  win: boolean;
  mfePct: number | null;
  maePct: number | null;
  timeToMfeSec: number | null;
  timeToMaeSec: number | null;
  exitReason: string | null;
  marketRegime: string | null;
  liquidityBucket: string | null;
  entryFeatures: EntryFeatures;
  snapshotSource: SnapshotSource;
  quality: ObservationQuality;
  modelVersions: Record<string, string | null>;
  dataMode: string;
}

const num = (v: unknown): number | null => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});

export function liquidityBucket(liquidityUsd: number | null): string | null {
  if (liquidityUsd == null) return null;
  if (liquidityUsd < 10_000) return 'LT_10K';
  if (liquidityUsd < 50_000) return '10K_50K';
  if (liquidityUsd < 250_000) return '50K_250K';
  return 'GTE_250K';
}

/** Entry snapshot written at execution time from the execution quote + the signal context. */
export function buildEntrySnapshot(opts: {
  signalMarketState: Record<string, unknown> | null;
  signalAt: Date | null;
  /** Overall score the winning strategy assigned at signal time */
  signalOverallScore?: number | null;
  market: {
    observed_at: Date;
    price_usd: number;
    liquidity_usd: number;
    liquidity_status: string;
    volume_5m_usd: number;
    volume_1h_usd: number;
    buy_volume_5m_usd: number;
    sell_volume_5m_usd: number;
    buys_5m: number | null;
    sells_5m: number | null;
    tx_count_5m: number;
    price_change_5m_pct: number;
    price_change_1h_pct: number;
  };
  quoteAgeMs: number;
  regime: string | null;
  dataConfidence: string | null;
  maxHoldSec: number | null;
}): Record<string, unknown> {
  const ms = obj(opts.signalMarketState);
  const accel = obj(ms.volumeAccel);
  const features: EntryFeatures = {
    observedAt: opts.market.observed_at.toISOString(),
    quoteAgeMs: Math.round(opts.quoteAgeMs),
    signalAt: opts.signalAt?.toISOString() ?? null,
    tokenAgeMinutes: num(ms.ageMinutes),
    liquidityUsd: opts.market.liquidity_usd,
    liquidityStatus: opts.market.liquidity_status,
    volume5mUsd: opts.market.volume_5m_usd,
    volume1hUsd: opts.market.volume_1h_usd,
    volumeAcceleration: num(accel.capped) ?? num(accel.raw),
    volumeAccelerationConfidence: str(accel.confidence),
    buyVolume5mUsd: opts.market.buy_volume_5m_usd,
    sellVolume5mUsd: opts.market.sell_volume_5m_usd,
    buyCount5m: opts.market.buys_5m,
    sellCount5m: opts.market.sells_5m,
    txCount5m: opts.market.tx_count_5m,
    uniqueBuyers: null,
    uniqueSellers: null,
    priceChange5mPct: opts.market.price_change_5m_pct,
    priceChange1hPct: opts.market.price_change_1h_pct,
    marketRegime: opts.regime ?? str(ms.regime),
    tokenPhase: str(ms.phase),
    dataConfidence: opts.dataConfidence ?? str(ms.dataConfidence),
    topHolderPct: num(ms.topHolderPct),
    strategyInputs: strategyInputsFromMarketState(ms, opts.signalOverallScore ?? null),
    strategyParamsAtEntry: paramsAtEntry(ms),
  };
  return { features, entryPriceMidUsd: opts.market.price_usd, maxHoldSec: opts.maxHoldSec };
}

function paramsAtEntry(ms: Record<string, unknown>): Record<string, number> | null {
  const p = obj(ms.strategyParams);
  const entries = Object.entries(p).filter(([, v]) => typeof v === 'number' && Number.isFinite(v));
  return entries.length ? (Object.fromEntries(entries) as Record<string, number>) : null;
}

function featuresFromSignal(
  ms: Record<string, unknown>,
  signalAt: Date | null,
  overallScore: number | null = null,
): EntryFeatures {
  const accel = obj(ms.volumeAccel);
  const flow = obj(ms.flow);
  return {
    observedAt: str(ms.observedAt),
    quoteAgeMs: null,
    signalAt: signalAt?.toISOString() ?? null,
    tokenAgeMinutes: num(ms.ageMinutes),
    liquidityUsd: num(ms.liquidityUsd),
    liquidityStatus: str(ms.liquidityStatus),
    volume5mUsd: num(ms.volume5mUsd),
    volume1hUsd: num(ms.volume1hUsd),
    volumeAcceleration: num(accel.capped) ?? num(accel.raw) ?? (typeof ms.volumeAccel === 'number' ? ms.volumeAccel : null),
    volumeAccelerationConfidence: str(accel.confidence),
    buyVolume5mUsd: num(ms.buyVolume5mUsd),
    sellVolume5mUsd: num(ms.sellVolume5mUsd),
    buyCount5m: num(flow.buys5m),
    sellCount5m: num(flow.sells5m),
    txCount5m: num(ms.txCount5m),
    uniqueBuyers: num(flow.uniqueBuyers),
    uniqueSellers: num(flow.uniqueSellers),
    priceChange5mPct: num(ms.priceChange5mPct),
    priceChange1hPct: num(ms.priceChange1hPct),
    marketRegime: str(ms.regime),
    tokenPhase: str(ms.phase),
    dataConfidence: str(ms.dataConfidence),
    topHolderPct: num(ms.topHolderPct),
    strategyInputs: ms.priceUsd == null ? null : strategyInputsFromMarketState(ms, overallScore),
    strategyParamsAtEntry: paramsAtEntry(ms),
  };
}

/** True when an input feature was observed after the trade was opened (look-ahead). */
export function isAfterEntry(observedAt: string | null, entryAt: Date): boolean {
  if (!observedAt) return false;
  const t = Date.parse(observedAt);
  return Number.isFinite(t) && t > entryAt.getTime() + 1000;
}

/** Pure: builds the observation from a closed position. No database access. */
export function buildObservation(p: PositionForObservation): TradeObservation {
  const journal = obj(p.journal);
  const ev = obj(journal.ev ?? p.signal_expected_value);
  const costBreakdown = obj(ev.costBreakdown);
  const snapshot = obj(p.entry_snapshot);
  const snapFeatures = snapshot.features ? (snapshot.features as EntryFeatures) : null;

  let entryFeatures: EntryFeatures;
  let snapshotSource: SnapshotSource;
  if (snapFeatures && !isAfterEntry(snapFeatures.observedAt, p.opened_at)) {
    entryFeatures = snapFeatures;
    snapshotSource = 'ENTRY_SNAPSHOT';
  } else {
    entryFeatures = featuresFromSignal(obj(p.signal_market_state), p.signal_created_at, num(p.signal_overall_score));
    if (isAfterEntry(entryFeatures.observedAt, p.opened_at)) {
      // Never let post-entry values become inputs; keep only the timestamps
      entryFeatures = { ...featuresFromSignal({}, p.signal_created_at), observedAt: entryFeatures.observedAt };
    }
    snapshotSource = 'SIGNAL_BACKFILL';
  }
  if (!entryFeatures.marketRegime && p.market_regime) entryFeatures = { ...entryFeatures, marketRegime: p.market_regime };
  if (!entryFeatures.tokenPhase && p.token_phase) entryFeatures = { ...entryFeatures, tokenPhase: p.token_phase };
  entryFeatures = sanitizeEntryFeatures(entryFeatures);

  const size = num(p.cost_basis_usd) ?? 0;
  const net = num(p.net_pnl_usd) ?? 0;
  const entryCosts = obj(p.entry_costs);
  const exitCosts = obj(p.exit_costs);
  const sumCost = (k: string) => {
    const a = num(entryCosts[k]);
    const b = num(exitCosts[k]);
    return a == null && b == null ? null : (a ?? 0) + (b ?? 0);
  };
  const actualCost = sumCost('totalCostUsd');
  const actualSlip = sumCost('slippageCostUsd');
  const actualImpact = sumCost('priceImpactCostUsd');
  const rate = (usd: number | null) => (usd == null || size <= 0 ? null : usd / size);

  const confidence = num(p.signal_confidence) ?? num(p.signal_overall_score);
  const exitPrice = num(p.current_price_usd);
  const secsFrom = (t: Date | null) =>
    t ? Math.max(0, Math.round((t.getTime() - p.opened_at.getTime()) / 1000)) : null;

  return {
    positionId: p.id,
    portfolioId: p.portfolio_id,
    portfolioType: p.portfolio_type === 'RESEARCH' ? 'RESEARCH' : 'PRODUCTION',
    tokenId: p.token_id,
    symbol: p.symbol,
    strategyId: p.strategy_key ?? p.strategy_name ?? 'unknown',
    strategyVersion: p.strategy_version,
    entryAt: p.opened_at,
    exitAt: p.closed_at,
    entryPriceUsd: num(p.entry_price_usd) ?? 0,
    exitPriceUsd: exitPrice,
    positionSizeUsd: size,
    requestedSizeUsd: num(p.requested_size_usd) ?? num(obj(journal.risk).requestedSizeUsd),
    predictedEv: num(ev.expectedNetValue) ?? num(p.expected_net_value),
    predictedWinProbability: num(ev.winProbability) ?? (confidence != null ? winProbabilityFromConfidence(confidence) : null),
    dataConfidence: str(ev.dataConfidence) ?? p.signal_data_confidence ?? entryFeatures.dataConfidence,
    riskTier: p.risk_tier ?? str(obj(journal.risk).tier),
    expectedReturn: num(ev.grossUpside),
    expectedLoss: num(ev.downside),
    maxPlannedLossUsd: num(p.max_planned_loss_usd) ?? num(obj(journal.risk).maximumPlannedLossUsd),
    estimatedCostUsd: num(ev.executionCostUsd) ?? num(costBreakdown.totalCostUsd),
    estimatedCostRate: num(ev.executionCostRate) ?? num(costBreakdown.totalCostRate),
    estimatedSlippageRate: num(costBreakdown.slippageRate),
    estimatedImpactRate: num(costBreakdown.priceImpactRate),
    stopLossPct: num(p.stop_loss_pct),
    takeProfitPct: num(p.take_profit_pct),
    trailingStopPct: num(p.trailing_stop_pct),
    maxHoldSec: num(snapshot.maxHoldSec),
    actualCostUsd: actualCost,
    actualCostRate: rate(actualCost),
    actualSlippageRate: rate(actualSlip),
    actualImpactRate: rate(actualImpact),
    grossPnlUsd: num(p.gross_pnl_usd) ?? 0,
    netPnlUsd: net,
    netReturn: size > 0 ? net / size : 0,
    win: net > 0,
    mfePct: num(p.mfe_pct),
    maePct: num(p.mae_pct),
    timeToMfeSec: secsFrom(p.mfe_at),
    timeToMaeSec: secsFrom(p.mae_at),
    exitReason: p.close_reason,
    marketRegime: entryFeatures.marketRegime,
    liquidityBucket: liquidityBucket(entryFeatures.liquidityUsd),
    entryFeatures,
    snapshotSource,
    quality: observationQuality(snapshotSource, entryFeatures),
    modelVersions: {
      strategy: p.strategy_version,
      ev: ev.calibrationVersion ? `ev-v2+${String(ev.calibrationVersion)}` : 'ev-v2',
      risk: p.risk_version,
      execution: p.execution_model_version,
      safety: p.safety_version,
    },
    dataMode: p.data_mode,
  };
}

const POSITION_SELECT = `
  SELECT p.id, p.portfolio_id, up.portfolio_type, p.token_id, t.symbol, p.strategy_key,
         s.strategy_name, COALESCE(p.strategy_version, s.strategy_version) AS strategy_version,
         p.opened_at, p.closed_at, p.entry_price_usd, p.current_price_usd, p.cost_basis_usd,
         p.gross_pnl_usd, p.net_pnl_usd, p.entry_costs, p.exit_costs, p.close_reason,
         p.stop_loss_pct, p.take_profit_pct, p.trailing_stop_pct, p.mfe_pct, p.mae_pct,
         p.mfe_at, p.mae_at, p.risk_tier, p.requested_size_usd, p.max_planned_loss_usd, p.expected_net_value,
         p.market_regime, p.token_phase, p.journal, p.entry_snapshot,
         s.market_state AS signal_market_state, s.expected_value AS signal_expected_value,
         s.confidence AS signal_confidence, s.overall_score AS signal_overall_score,
         s.data_confidence AS signal_data_confidence, s.created_at AS signal_created_at,
         p.risk_version, p.execution_model_version, p.safety_version, p.data_mode
  FROM positions p
  JOIN user_portfolios up ON up.id = p.portfolio_id
  JOIN tokens t ON t.id = p.token_id
  LEFT JOIN signals s ON s.id = p.entry_signal_id
  WHERE p.status = 'CLOSED' AND p.closed_at IS NOT NULL`;

const COLUMNS: Array<[string, (o: TradeObservation) => unknown]> = [
  ['position_id', (o) => o.positionId],
  ['portfolio_id', (o) => o.portfolioId],
  ['portfolio_type', (o) => o.portfolioType],
  ['token_id', (o) => o.tokenId],
  ['symbol', (o) => o.symbol],
  ['strategy_id', (o) => o.strategyId],
  ['strategy_version', (o) => o.strategyVersion],
  ['entry_at', (o) => o.entryAt],
  ['exit_at', (o) => o.exitAt],
  ['entry_price_usd', (o) => o.entryPriceUsd],
  ['exit_price_usd', (o) => o.exitPriceUsd],
  ['position_size_usd', (o) => o.positionSizeUsd],
  ['requested_size_usd', (o) => o.requestedSizeUsd],
  ['predicted_ev', (o) => o.predictedEv],
  ['predicted_win_probability', (o) => o.predictedWinProbability],
  ['data_confidence', (o) => o.dataConfidence],
  ['risk_tier', (o) => o.riskTier],
  ['expected_return', (o) => o.expectedReturn],
  ['expected_loss', (o) => o.expectedLoss],
  ['max_planned_loss_usd', (o) => o.maxPlannedLossUsd],
  ['estimated_cost_usd', (o) => o.estimatedCostUsd],
  ['estimated_cost_rate', (o) => o.estimatedCostRate],
  ['estimated_slippage_rate', (o) => o.estimatedSlippageRate],
  ['estimated_impact_rate', (o) => o.estimatedImpactRate],
  ['stop_loss_pct', (o) => o.stopLossPct],
  ['take_profit_pct', (o) => o.takeProfitPct],
  ['trailing_stop_pct', (o) => o.trailingStopPct],
  ['max_hold_sec', (o) => o.maxHoldSec],
  ['actual_cost_usd', (o) => o.actualCostUsd],
  ['actual_cost_rate', (o) => o.actualCostRate],
  ['actual_slippage_rate', (o) => o.actualSlippageRate],
  ['actual_impact_rate', (o) => o.actualImpactRate],
  ['gross_pnl_usd', (o) => o.grossPnlUsd],
  ['net_pnl_usd', (o) => o.netPnlUsd],
  ['net_return', (o) => o.netReturn],
  ['win', (o) => o.win],
  ['mfe_pct', (o) => o.mfePct],
  ['mae_pct', (o) => o.maePct],
  ['time_to_mfe_sec', (o) => o.timeToMfeSec],
  ['time_to_mae_sec', (o) => o.timeToMaeSec],
  ['exit_reason', (o) => o.exitReason],
  ['market_regime', (o) => o.marketRegime],
  ['liquidity_bucket', (o) => o.liquidityBucket],
  ['entry_features', (o) => JSON.stringify(o.entryFeatures)],
  ['snapshot_source', (o) => o.snapshotSource],
  ['model_versions', (o) => JSON.stringify(o.modelVersions)],
  ['data_mode', (o) => o.dataMode],
];

async function insertObservation(o: TradeObservation): Promise<boolean> {
  const cols = COLUMNS.map(([c]) => c);
  const values = COLUMNS.map(([, f]) => f(o));
  const { rowCount } = await query(
    `INSERT INTO trade_observations (${cols.join(', ')})
     VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})
     ON CONFLICT (position_id) DO NOTHING`,
    values,
  );
  return (rowCount ?? 0) > 0;
}

/** Records the observation for one closed position. Idempotent; open positions are ignored. */
export async function recordTradeObservation(positionId: string): Promise<boolean> {
  const { rows } = await query<PositionForObservation>(`${POSITION_SELECT} AND p.id = $1`, [positionId]);
  if (!rows[0]) return false;
  return insertObservation(buildObservation(rows[0]));
}

/** Safety net: records observations for any closed position that does not have one yet. */
export async function recordMissingObservations(limit = 200): Promise<number> {
  const { rows } = await query<PositionForObservation>(
    `${POSITION_SELECT}
       AND NOT EXISTS (SELECT 1 FROM trade_observations o WHERE o.position_id = p.id)
     ORDER BY p.closed_at
     LIMIT $1`,
    [limit],
  );
  let n = 0;
  for (const r of rows) {
    try {
      if (await insertObservation(buildObservation(r))) n++;
    } catch (err) {
      logger.warn({ err, positionId: r.id }, 'Trade observation could not be recorded');
    }
  }
  return n;
}
