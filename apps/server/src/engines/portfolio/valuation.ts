/** Pure portfolio valuation helpers (unit-testable). */
export function computeEquity(cashUsd: number, investedValueUsd: number): number {
  return cashUsd + investedValueUsd;
}

export function computeUnrealizedPnl(
  currentValueUsd: number,
  costBasisUsd: number,
): number {
  return currentValueUsd - costBasisUsd;
}

export function computeReturnPct(equityUsd: number, startingBalanceUsd: number): number {
  if (startingBalanceUsd <= 0) return 0;
  return ((equityUsd - startingBalanceUsd) / startingBalanceUsd) * 100;
}

export function computeGrossPnl(
  exitFilledUsd: number,
  entryCostBasisUsd: number,
): number {
  return exitFilledUsd - entryCostBasisUsd;
}

export function computeNetPnl(
  exitProceedsUsd: number,
  entryCostBasisUsd: number,
): number {
  return exitProceedsUsd - entryCostBasisUsd;
}

export function markPositionValue(
  quantity: number,
  markPriceUsd: number,
): number {
  return quantity * markPriceUsd;
}

export function sizePositionUsd(opts: {
  equityUsd: number;
  cashUsd: number;
  maxPositionPct: number;
  maxRiskPerTradePct: number;
  stopLossPct: number;
}): number {
  const maxByPct = opts.equityUsd * opts.maxPositionPct;
  const maxByRisk =
    opts.stopLossPct > 0
      ? (opts.equityUsd * opts.maxRiskPerTradePct) / opts.stopLossPct
      : maxByPct;
  return Math.max(0, Math.min(maxByPct, maxByRisk, opts.cashUsd * 0.99));
}
