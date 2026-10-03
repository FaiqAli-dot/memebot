import type { BucketStat, StrategyInputs } from '@memebot/shared';

/** Entry-time strategy inputs (as compared against thresholds at signal time) — no post-entry data. */
export type TradeFeatures = StrategyInputs;

export interface ClosedTrade {
  positionId: string;
  tokenId: string;
  symbol: string;
  /** Owning strategy (positions.strategy_key); null for legacy rows */
  strategyId: string | null;
  entryPriceUsd: number;
  highestPriceUsd: number;
  costBasisUsd: number;
  netPnlUsd: number;
  grossPnlUsd: number;
  costsUsd: number;
  closeReason: string | null;
  openedAt: Date;
  closedAt: Date;
  features: TradeFeatures | null;
}

export function isWin(t: ClosedTrade): boolean {
  return t.netPnlUsd > 0;
}

export function holdSec(t: ClosedTrade): number {
  return Math.max(0, (t.closedAt.getTime() - t.openedAt.getTime()) / 1000);
}

export function peakGainPct(t: ClosedTrade): number {
  return t.entryPriceUsd > 0 ? (t.highestPriceUsd / t.entryPriceUsd - 1) * 100 : 0;
}

export function bucketStats(trades: ClosedTrade[]): BucketStat {
  const n = trades.length;
  if (n === 0) return { n: 0, winRatePct: 0, avgPnlUsd: 0 };
  const wins = trades.filter(isWin).length;
  const pnl = trades.reduce((s, t) => s + t.netPnlUsd, 0);
  return { n, winRatePct: (wins / n) * 100, avgPnlUsd: pnl / n };
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}
