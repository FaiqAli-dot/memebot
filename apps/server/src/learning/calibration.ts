/**
 * LEVEL 3 — calibration. Pure: no database.
 *
 * Answers "when the system predicted X, what actually happened?" and fits a conservative,
 * per-strategy EV calibration: calibratedEV = offset + scale × rawEV, shrunk toward the
 * identity and constrained to offset ≤ 0, 0 ≤ scale ≤ 1 (never more aggressive than raw).
 *
 * Walk-forward: the candidate is fitted on the older TRAIN_FRACTION of observations and
 * judged only on the newer, unseen remainder. Promotion requires a forward improvement in
 * prediction error without worse bias, plus the INITIAL_CALIBRATION data stage.
 * Trade count / trade frequency is never a promotion criterion.
 */
import { finite, mean, median, profitFactor, wilson, type Interval } from './stats.js';

export interface CalibrationObservation {
  seq: number;
  exitAt: Date;
  predictedEv: number | null;
  predictedWinProbability: number | null;
  netReturn: number;
  netPnlUsd: number;
  win: boolean;
  mfePct: number | null;
  maePct: number | null;
  dataConfidence: string | null;
  marketRegime: string | null;
  liquidityBucket: string | null;
  riskTier: string | null;
}

export interface EvCalibrationParams {
  offset: number;
  scale: number;
}

export const IDENTITY: EvCalibrationParams = { offset: 0, scale: 1 };

export const CALIBRATION_RULES = {
  trainFraction: 0.7,
  minTrain: 40,
  minValidation: 15,
  /** Pseudo-observations pulling the fit toward the identity */
  shrinkK: 50,
  /** Relative MSE improvement required on the unseen window */
  minImprovement: 0.02,
  minOffset: -0.1,
  /** Segment tables only when every reported segment has this many trades */
  minSegment: 30,
} as const;

export type CalibrationStage = 'OBSERVATION' | 'DESCRIPTIVE' | 'INITIAL_CALIBRATION' | 'MODEL_FITTING';

export const STAGES: Array<{ stage: CalibrationStage; from: number; note: string }> = [
  { stage: 'OBSERVATION', from: 0, note: 'Observation / debugging — not enough evidence for any fitting' },
  { stage: 'DESCRIPTIVE', from: 100, note: 'Descriptive statistics only — not enough evidence for model fitting' },
  { stage: 'INITIAL_CALIBRATION', from: 300, note: 'Initial calibration — conservative, forward-validated updates' },
  { stage: 'MODEL_FITTING', from: 1000, note: 'Enough data for more serious model fitting' },
];

export function stageFor(productionObservations: number): (typeof STAGES)[number] {
  return [...STAGES].reverse().find((s) => productionObservations >= s.from)!;
}

export const PROMOTION_MIN_OBSERVATIONS = STAGES.find((s) => s.stage === 'INITIAL_CALIBRATION')!.from;

// ---------- descriptive reliability tables ----------

export interface BucketRow {
  label: string;
  n: number;
  avgPredicted: number | null;
  avgRealized: number | null;
  medianRealized: number | null;
  winRate: number | null;
  winRateCI: Interval | null;
  profitFactor: number | null;
  avgMfePct: number | null;
  avgMaePct: number | null;
}

const EV_BUCKETS: Array<[string, number, number]> = [
  ['<0%', -Infinity, 0],
  ['0–1%', 0, 0.01],
  ['1–2%', 0.01, 0.02],
  ['2–3%', 0.02, 0.03],
  ['3–5%', 0.03, 0.05],
  ['5%+', 0.05, Infinity],
];

function bucketRow(label: string, rows: CalibrationObservation[], predicted: (o: CalibrationObservation) => number | null): BucketRow {
  const realized = rows.map((o) => o.netReturn);
  const wins = rows.filter((o) => o.win).length;
  return {
    label,
    n: rows.length,
    avgPredicted: mean(finite(rows.map(predicted))),
    avgRealized: mean(realized),
    medianRealized: median(realized),
    winRate: rows.length ? wins / rows.length : null,
    winRateCI: wilson(wins, rows.length),
    profitFactor: profitFactor(rows.map((o) => o.netPnlUsd)),
    avgMfePct: mean(finite(rows.map((o) => o.mfePct))),
    avgMaePct: mean(finite(rows.map((o) => o.maePct))),
  };
}

export function evBuckets(rows: CalibrationObservation[]): BucketRow[] {
  const withEv = rows.filter((o) => o.predictedEv != null);
  return EV_BUCKETS.map(([label, lo, hi]) =>
    bucketRow(label, withEv.filter((o) => o.predictedEv! >= lo && o.predictedEv! < hi), (o) => o.predictedEv),
  ).filter((b) => b.n > 0);
}

export function winProbabilityBuckets(rows: CalibrationObservation[]): BucketRow[] {
  const withP = rows.filter((o) => o.predictedWinProbability != null);
  const out: BucketRow[] = [];
  for (let lo = 0; lo < 1; lo += 0.05) {
    const hi = lo + 0.05;
    const inB = withP.filter((o) => o.predictedWinProbability! >= lo - 1e-9 && o.predictedWinProbability! < hi - 1e-9);
    if (inB.length) out.push(bucketRow(`${lo.toFixed(2)}–${hi.toFixed(2)}`, inB, (o) => o.predictedWinProbability));
  }
  return out;
}

export function brierScore(rows: CalibrationObservation[]): number | null {
  const withP = rows.filter((o) => o.predictedWinProbability != null);
  return mean(withP.map((o) => (o.predictedWinProbability! - (o.win ? 1 : 0)) ** 2));
}

/** Segment only when every segment of the key has enough data; otherwise report nothing. */
export function segmentTables(
  rows: CalibrationObservation[],
  keys: Array<keyof Pick<CalibrationObservation, 'dataConfidence' | 'marketRegime' | 'liquidityBucket' | 'riskTier'>>,
): Record<string, BucketRow[] | { skipped: string }> {
  const out: Record<string, BucketRow[] | { skipped: string }> = {};
  for (const key of keys) {
    const groups = new Map<string, CalibrationObservation[]>();
    for (const o of rows) {
      const k = (o[key] as string | null) ?? 'UNKNOWN';
      groups.set(k, [...(groups.get(k) ?? []), o]);
    }
    const small = [...groups.entries()].filter(([, g]) => g.length < CALIBRATION_RULES.minSegment);
    out[key] = small.length
      ? { skipped: `segments below ${CALIBRATION_RULES.minSegment} trades: ${small.map(([k, g]) => `${k}=${g.length}`).join(', ')}` }
      : [...groups.entries()].map(([k, g]) => bucketRow(k, g, (o) => o.predictedEv));
  }
  return out;
}

// ---------- EV calibration fit + walk-forward validation ----------

export function predict(p: EvCalibrationParams, rawEv: number): number {
  return Math.min(rawEv, p.offset + p.scale * rawEv);
}

export interface FitMetrics {
  n: number;
  mse: number | null;
  mae: number | null;
  bias: number | null;
  avgPredicted: number | null;
  avgRealized: number | null;
}

export function evaluate(p: EvCalibrationParams, rows: CalibrationObservation[]): FitMetrics {
  const withEv = rows.filter((o) => o.predictedEv != null);
  const errs = withEv.map((o) => predict(p, o.predictedEv!) - o.netReturn);
  return {
    n: withEv.length,
    mse: mean(errs.map((e) => e * e)),
    mae: mean(errs.map(Math.abs)),
    bias: mean(errs),
    avgPredicted: mean(withEv.map((o) => predict(p, o.predictedEv!))),
    avgRealized: mean(withEv.map((o) => o.netReturn)),
  };
}

/** OLS realized ~ predicted, shrunk toward identity, then constrained to be conservative. */
export function fitEvCalibration(train: CalibrationObservation[]): EvCalibrationParams & { shrinkWeight: number } {
  const rows = train.filter((o) => o.predictedEv != null);
  const n = rows.length;
  const xs = rows.map((o) => o.predictedEv!);
  const ys = rows.map((o) => o.netReturn);
  const mx = mean(xs) ?? 0;
  const my = mean(ys) ?? 0;
  const sxx = xs.reduce((a, x) => a + (x - mx) ** 2, 0);
  const sxy = xs.reduce((a, x, i) => a + (x - mx) * (ys[i]! - my), 0);
  let scale = sxx > 1e-12 ? sxy / sxx : 1;
  let offset = sxx > 1e-12 ? my - scale * mx : my - mx;
  const w = n / (n + CALIBRATION_RULES.shrinkK);
  scale = 1 + w * (scale - 1);
  offset = w * offset;
  scale = Math.max(0, Math.min(1, scale));
  offset = Math.max(CALIBRATION_RULES.minOffset, Math.min(0, offset));
  return { offset: round6(offset), scale: round6(scale), shrinkWeight: round6(w) };
}

export type VersionStatus = 'VALIDATED' | 'PROMOTED' | 'REJECTED';

export interface StrategyCalibrationResult {
  strategyId: string;
  computed: boolean;
  skippedReason?: string;
  status?: VersionStatus;
  promotionDecision?: string;
  previous: EvCalibrationParams;
  candidate?: EvCalibrationParams & { shrinkWeight: number };
  trainingCount: number;
  validationCount: number;
  trainingWindow?: { start: Date; end: Date };
  validationWindow?: { start: Date; end: Date };
  trainingMetrics?: FitMetrics;
  validationMetrics?: { current: FitMetrics; candidate: FitMetrics; improvement: number | null };
}

export function calibrateStrategy(opts: {
  strategyId: string;
  /** Production observations for this strategy, oldest first */
  rows: CalibrationObservation[];
  current: EvCalibrationParams | null;
  /** Calibration-grade production observations across all strategies */
  totalProductionObservations: number;
  /** false (observation mode): a candidate that would be promoted stays VALIDATED */
  autoPromotion?: boolean;
}): StrategyCalibrationResult {
  const previous = opts.current ?? IDENTITY;
  const rows = opts.rows.filter((o) => o.predictedEv != null);
  const split = Math.floor(rows.length * CALIBRATION_RULES.trainFraction);
  const train = rows.slice(0, split);
  const validation = rows.slice(split);
  const base = { strategyId: opts.strategyId, previous, trainingCount: train.length, validationCount: validation.length };

  if (train.length < CALIBRATION_RULES.minTrain || validation.length < CALIBRATION_RULES.minValidation) {
    return {
      ...base,
      computed: false,
      skippedReason: `Only ${rows.length} calibration-grade production observations with an EV prediction; need ${CALIBRATION_RULES.minTrain} to fit and ${CALIBRATION_RULES.minValidation} unseen to validate`,
    };
  }

  const candidate = fitEvCalibration(train);
  const cur = evaluate(previous, validation);
  const cand = evaluate(candidate, validation);
  const improvement = cur.mse != null && cand.mse != null && cur.mse > 0 ? (cur.mse - cand.mse) / cur.mse : null;
  const biasOk = Math.abs(cand.bias ?? 0) <= Math.abs(cur.bias ?? 0) + 1e-9;
  const unchanged = Math.abs(candidate.offset - previous.offset) < 1e-4 && Math.abs(candidate.scale - previous.scale) < 1e-4;
  const windows = {
    trainingWindow: { start: train[0]!.exitAt, end: train[train.length - 1]!.exitAt },
    validationWindow: { start: validation[0]!.exitAt, end: validation[validation.length - 1]!.exitAt },
  };
  const metrics = {
    trainingMetrics: evaluate(candidate, train),
    validationMetrics: { current: cur, candidate: cand, improvement },
  };

  let status: VersionStatus;
  let promotionDecision: string;
  if (unchanged) {
    status = 'REJECTED';
    promotionDecision = 'Candidate is not materially different from the current calibration';
  } else if (improvement == null || improvement < CALIBRATION_RULES.minImprovement || !biasOk) {
    status = 'REJECTED';
    promotionDecision = `Failed forward validation on ${validation.length} unseen trades (MSE improvement ${improvement == null ? 'n/a' : `${(improvement * 100).toFixed(1)}%`}, need ≥${CALIBRATION_RULES.minImprovement * 100}%${biasOk ? '' : '; bias got worse'}). Current calibration retained.`;
  } else if (opts.totalProductionObservations < PROMOTION_MIN_OBSERVATIONS) {
    status = 'VALIDATED';
    promotionDecision = `Passed forward validation, but promotion requires the INITIAL_CALIBRATION stage (${PROMOTION_MIN_OBSERVATIONS}+ calibration-grade production observations; have ${opts.totalProductionObservations}). Current calibration retained.`;
  } else if (opts.autoPromotion === false) {
    status = 'VALIDATED';
    promotionDecision = `Passed forward validation (MSE improved ${(improvement * 100).toFixed(1)}% on ${validation.length} unseen trades), but automatic promotion is disabled (LEARNING_OBSERVATION_MODE). Current calibration retained.`;
  } else {
    status = 'PROMOTED';
    promotionDecision = `Promoted: forward MSE improved ${(improvement * 100).toFixed(1)}% on ${validation.length} unseen trades without worse bias`;
  }
  return { ...base, computed: true, status, promotionDecision, candidate, ...windows, ...metrics };
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
