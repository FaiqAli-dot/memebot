/**
 * Learning metrics — optimize expectancy / PF / DD / costs, not win rate.
 * Parameter changes require statistical evidence; small samples → no churn.
 */
export interface TradeOutcome {
  netPnlUsd: number;
  grossPnlUsd: number;
  costsUsd: number;
  win: boolean;
  holdSec: number;
  regime?: string | null;
}

export interface LearningMetrics {
  tradeCount: number;
  winRate: number | null;
  expectancyUsd: number | null;
  profitFactor: number | null;
  avgWinUsd: number | null;
  avgLossUsd: number | null;
  medianWinUsd: number | null;
  medianLossUsd: number | null;
  tailLossP5Usd: number | null;
  maxDrawdownPct: number;
  totalGrossUsd: number;
  totalCostsUsd: number;
  totalNetUsd: number;
  costPerTradeUsd: number | null;
  sampleAdequate: boolean;
  notes: string[];
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export function computeLearningMetrics(
  trades: TradeOutcome[],
  minTrades = 30,
): LearningMetrics {
  const notes: string[] = [];
  const n = trades.length;
  if (n < minTrades) {
    notes.push(`sample_size_${n}_below_min_${minTrades}_no_parameter_churn`);
  }
  const nets = trades.map((t) => t.netPnlUsd);
  const wins = trades.filter((t) => t.win).map((t) => t.netPnlUsd);
  const losses = trades.filter((t) => !t.win).map((t) => t.netPnlUsd);
  const gross = trades.reduce((a, t) => a + t.grossPnlUsd, 0);
  const costs = trades.reduce((a, t) => a + t.costsUsd, 0);
  const net = trades.reduce((a, t) => a + t.netPnlUsd, 0);
  const grossWin = wins.reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));

  let peak = 0;
  let eq = 0;
  let maxDd = 0;
  for (const p of nets) {
    eq += p;
    peak = Math.max(peak, eq);
    if (peak > 0) maxDd = Math.max(maxDd, (peak - eq) / peak);
  }

  const sorted = [...nets].sort((a, b) => a - b);
  const p5 = sorted.length ? sorted[Math.floor(sorted.length * 0.05)]! : null;

  if (costs > Math.abs(net) && n > 0) {
    notes.push('costs_dominate_net_edge_unvalidated');
  }

  return {
    tradeCount: n,
    winRate: n ? (wins.length / n) * 100 : null,
    expectancyUsd: n ? net / n : null,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
    avgWinUsd: wins.length ? grossWin / wins.length : null,
    avgLossUsd: losses.length ? losses.reduce((a, b) => a + b, 0) / losses.length : null,
    medianWinUsd: median(wins),
    medianLossUsd: median(losses),
    tailLossP5Usd: p5,
    maxDrawdownPct: maxDd * 100,
    totalGrossUsd: gross,
    totalCostsUsd: costs,
    totalNetUsd: net,
    costPerTradeUsd: n ? costs / n : null,
    sampleAdequate: n >= minTrades,
    notes,
  };
}

/** Feature interaction vector for experimental ML — never bypasses safety. */
export interface FeatureVector {
  highVolume: boolean;
  risingUniqueBuyers: boolean;
  risingLiquidity: boolean;
  lowConcentration: boolean;
  positiveMomentum: boolean;
  label?: 'healthy_expansion' | 'suspicious_volume' | 'unknown';
}

export function classifyInteraction(v: Omit<FeatureVector, 'label'>): FeatureVector {
  if (
    v.highVolume &&
    v.risingUniqueBuyers &&
    v.risingLiquidity &&
    v.lowConcentration &&
    v.positiveMomentum
  ) {
    return { ...v, label: 'healthy_expansion' };
  }
  if (v.highVolume && !v.risingUniqueBuyers && !v.risingLiquidity && !v.lowConcentration) {
    return { ...v, label: 'suspicious_volume' };
  }
  return { ...v, label: 'unknown' };
}
