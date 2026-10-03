/**
 * Deterministic exit-path simulation for shadow trades and opportunity outcomes.
 *
 * Points are processed strictly in chronological order and each point is evaluated
 * with the same rule priority as live paper positions (engines/paper/exits.ts):
 * liquidity emergency → stop loss → take profit → trailing stop → max hold.
 * The exit mid is the observed market price at the triggering point, never the
 * theoretical stop/TP level (gaps are honoured).
 */
import { evaluateExitRules, type ExitCloseReason } from '../engines/paper/exits.js';

export interface ExitParams {
  stopLossPct: number;
  takeProfitPct: number;
  trailingStopPct: number | null;
  maxHoldSec: number;
  minLiquidityUsd: number;
}

export interface PathPoint {
  observedAt: Date;
  priceUsd: number;
  /** null when unknown — treated as not collapsed */
  liquidityUsd: number | null;
}

export interface ExitState {
  entryPriceUsd: number;
  entryAt: string;
  highestPriceUsd: number;
  mfePct: number;
  maePct: number;
  timeToMfeSec: number | null;
  timeToMaeSec: number | null;
  lastProcessedAt: string | null;
  lastPriceUsd: number;
  exited: boolean;
  exitReason: ExitCloseReason | 'data_unavailable' | null;
  exitAt: string | null;
  exitMidPriceUsd: number | null;
}

export function initExitState(entryPriceUsd: number, entryAt: Date): ExitState {
  return {
    entryPriceUsd,
    entryAt: entryAt.toISOString(),
    highestPriceUsd: entryPriceUsd,
    mfePct: 0,
    maePct: 0,
    timeToMfeSec: null,
    timeToMaeSec: null,
    lastProcessedAt: null,
    lastPriceUsd: entryPriceUsd,
    exited: false,
    exitReason: null,
    exitAt: null,
    exitMidPriceUsd: null,
  };
}

export function stepExit(state: ExitState, point: PathPoint, params: ExitParams): ExitState {
  if (state.exited) return state;
  const t = point.observedAt.getTime();
  const entryMs = new Date(state.entryAt).getTime();
  if (t <= entryMs) return state;
  if (state.lastProcessedAt && t <= new Date(state.lastProcessedAt).getTime()) return state;
  if (!(point.priceUsd > 0)) return { ...state, lastProcessedAt: point.observedAt.toISOString() };

  const next: ExitState = { ...state };
  const ret = (point.priceUsd - state.entryPriceUsd) / state.entryPriceUsd;
  const sinceEntrySec = Math.round((t - entryMs) / 1000);
  if (ret * 100 > next.mfePct) {
    next.mfePct = ret * 100;
    next.timeToMfeSec = sinceEntrySec;
  }
  if (ret * 100 < next.maePct) {
    next.maePct = ret * 100;
    next.timeToMaeSec = sinceEntrySec;
  }

  const decision = evaluateExitRules({
    entryPriceUsd: state.entryPriceUsd,
    markPriceUsd: point.priceUsd,
    highestPriceUsd: state.highestPriceUsd,
    stopLossPct: params.stopLossPct,
    takeProfitPct: params.takeProfitPct,
    trailingStopPct: params.trailingStopPct,
    openedAt: new Date(entryMs),
    now: point.observedAt,
    maxHoldingTimeSec: params.maxHoldSec,
    liquidityUsd: point.liquidityUsd ?? Number.POSITIVE_INFINITY,
    minLiquidityUsd: params.minLiquidityUsd,
    marketStale: false,
  });

  next.highestPriceUsd = Math.max(state.highestPriceUsd, point.priceUsd);
  next.lastProcessedAt = point.observedAt.toISOString();
  next.lastPriceUsd = point.priceUsd;
  if (decision.closeReason) {
    next.exited = true;
    next.exitReason = decision.closeReason;
    next.exitAt = point.observedAt.toISOString();
    next.exitMidPriceUsd = decision.exitMidPriceUsd;
  }
  return next;
}

export function runExitPath(
  entryPriceUsd: number,
  entryAt: Date,
  points: PathPoint[],
  params: ExitParams,
): ExitState {
  const sorted = [...points].sort((a, b) => a.observedAt.getTime() - b.observedAt.getTime());
  let state = initExitState(entryPriceUsd, entryAt);
  for (const p of sorted) {
    state = stepExit(state, p, params);
    if (state.exited) break;
  }
  return state;
}

/** Force-close when the price feed disappeared well past max hold. */
export function closeForMissingData(state: ExitState, now: Date, params: ExitParams, graceSec = 600): ExitState {
  if (state.exited) return state;
  const entryMs = new Date(state.entryAt).getTime();
  if ((now.getTime() - entryMs) / 1000 < params.maxHoldSec + graceSec) return state;
  return {
    ...state,
    exited: true,
    exitReason: 'data_unavailable',
    exitAt: now.toISOString(),
    exitMidPriceUsd: state.lastPriceUsd,
  };
}
