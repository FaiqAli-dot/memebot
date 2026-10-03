/**
 * Walk-forward validation — learning never uses future data.
 * Example: wk1-2 train, wk3 validate; wk2-3 train, wk4 validate; + untouched OOS.
 */
export interface TimeWindow {
  start: Date;
  end: Date;
  label: string;
}

export interface WalkForwardPlan {
  folds: Array<{
    train: TimeWindow;
    validate: TimeWindow;
  }>;
  outOfSample: TimeWindow;
}

export function buildWalkForwardPlan(opts: {
  start: Date;
  foldDays?: number;
  trainFolds?: number;
  validateFolds?: number;
  oosDays?: number;
}): WalkForwardPlan {
  const foldDays = opts.foldDays ?? 7;
  const trainFolds = opts.trainFolds ?? 2;
  const validateFolds = opts.validateFolds ?? 1;
  const oosDays = opts.oosDays ?? 7;
  const dayMs = 86_400_000;

  const folds: WalkForwardPlan['folds'] = [];
  // Three rolling folds by default
  for (let i = 0; i < 3; i++) {
    const trainStart = new Date(opts.start.getTime() + i * foldDays * dayMs);
    const trainEnd = new Date(
      trainStart.getTime() + trainFolds * foldDays * dayMs,
    );
    const validateStart = trainEnd;
    const validateEnd = new Date(
      validateStart.getTime() + validateFolds * foldDays * dayMs,
    );
    folds.push({
      train: {
        start: trainStart,
        end: trainEnd,
        label: `train-${i + 1}`,
      },
      validate: {
        start: validateStart,
        end: validateEnd,
        label: `validate-${i + 1}`,
      },
    });
  }

  const lastValidateEnd = folds[folds.length - 1]!.validate.end;
  const outOfSample: TimeWindow = {
    start: lastValidateEnd,
    end: new Date(lastValidateEnd.getTime() + oosDays * dayMs),
    label: 'out-of-sample',
  };

  return { folds, outOfSample };
}

/** Ensure a timestamp is not in a future fold relative to train end. */
export function assertNoFutureLeak(asOf: Date, point: Date): void {
  if (point.getTime() > asOf.getTime()) {
    throw new Error(
      `Walk-forward leakage: point ${point.toISOString()} after asOf ${asOf.toISOString()}`,
    );
  }
}

export interface FoldMetrics {
  tradeCount: number;
  expectancyUsd: number | null;
  profitFactor: number | null;
  maxDrawdownPct: number;
  netPnlUsd: number;
  totalCostsUsd: number;
}

export function summarizeFold(pnls: number[], costs: number[]): FoldMetrics {
  const tradeCount = pnls.length;
  const net = pnls.reduce((a, b) => a + b, 0);
  const totalCosts = costs.reduce((a, b) => a + b, 0);
  const wins = pnls.filter((p) => p > 0);
  const losses = pnls.filter((p) => p <= 0);
  const grossWin = wins.reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));
  let peak = 0;
  let eq = 0;
  let maxDd = 0;
  for (const p of pnls) {
    eq += p;
    peak = Math.max(peak, eq);
    maxDd = Math.max(maxDd, peak > 0 ? (peak - eq) / Math.max(peak, 1) : 0);
  }
  return {
    tradeCount,
    expectancyUsd: tradeCount ? net / tradeCount : null,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
    maxDrawdownPct: maxDd * 100,
    netPnlUsd: net,
    totalCostsUsd: totalCosts,
  };
}
