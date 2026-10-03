import {
  STRATEGY_PARAM_REGISTRY,
  clampStrategyParam,
  strategyParamDef,
  type ExitStats,
  type LearnableParam,
  type Lesson,
  type LessonSplitMetrics,
  type PortfolioSettings,
  type StrategyParamDef,
  type StrategyParamValues,
} from '@memebot/shared';
import { MIN_BUCKET_TRADES, featurePoints, inBand, tightenedThreshold } from './analyze.js';
import {
  EXIT_PARAMS,
  clampExit,
  exitStep,
  getStrategyParam,
  setExitParam,
  setStrategyParam,
  strategyStep,
  type ExitParam,
} from './bounds.js';
import { type ClosedTrade, isWin } from './types.js';

/** Win-rate gap (percentage points) required on BOTH training and validation before a threshold moves. */
export const MIN_EDGE_PP = 15;
export const MAX_CHANGES_PER_DAY = 3;
/** A setting may not move in the opposite direction within this many days. */
export const FLIP_FLOP_DAYS = 3;
/** Older share proposes; the newer, unseen remainder must confirm. */
export const LESSON_TRAIN_FRACTION = 0.7;
export const LESSON_VERSION = 'strategy-lessons-v2';

export interface PastLesson {
  reportDate: string;
  strategyId?: string | null;
  param: LearnableParam | 'all';
  from: number | null;
  to: number | null;
  status: Lesson['status'];
}

const pp = (n: number) => `${n.toFixed(0)}%`;

function daysBetween(a: string, b: string): number {
  return Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;
}

export function splitMetrics(trades: ClosedTrade[], def: StrategyParamDef, candidate: number): LessonSplitMetrics {
  const points = featurePoints(trades, def);
  const band = points.filter((p) => inBand(def, candidate, p.v));
  const rest = points.filter((p) => !inBand(def, candidate, p.v));
  const rate = (xs: typeof points) => (xs.length ? (xs.filter((p) => isWin(p.t)).length / xs.length) * 100 : 0);
  const bandWinRatePct = rate(band);
  const restWinRatePct = rate(rest);
  return {
    trades: points.length,
    bandTrades: band.length,
    bandWinRatePct,
    restTrades: rest.length,
    restWinRatePct,
    gapPp: restWinRatePct - bandWinRatePct,
  };
}

function hasEdge(m: LessonSplitMetrics): boolean {
  return m.bandTrades >= MIN_BUCKET_TRADES && m.restTrades >= MIN_BUCKET_TRADES && Math.abs(m.gapPp) >= MIN_EDGE_PP;
}

export function lessonConfidence(validationTrades: number): 'LOW' | 'MEDIUM' | 'HIGH' {
  return validationTrades >= 100 ? 'HIGH' : validationTrades >= 30 ? 'MEDIUM' : 'LOW';
}

export function minValidationTrades(minTrades: number): number {
  return Math.max(5, Math.ceil((minTrades * (1 - LESSON_TRAIN_FRACTION)) / LESSON_TRAIN_FRACTION));
}

/**
 * Lessons for ONE strategy from that strategy's own calibration-grade trades (oldest first).
 * Proposed on the older 70%, confirmed on the newer 30%. Pure: never touches the database.
 * Returned `applied` lessons are provisional; `finalizeLessons` and `applyLessons` decide.
 */
export function deriveStrategyLessons(input: {
  strategyId: string;
  trades: ClosedTrade[];
  params: StrategyParamValues;
  minTrades: number;
  history: PastLesson[];
  reportDate: string;
}): Lesson[] {
  const { strategyId } = input;
  const registry = STRATEGY_PARAM_REGISTRY[strategyId];
  const note = (reason: string, evidence: Record<string, number> = {}): Lesson[] => [
    { strategyId, param: 'all', from: null, to: null, status: 'skipped', reason, evidence, lessonVersion: LESSON_VERSION },
  ];
  if (!registry) {
    return note(`${strategyId} has no runtime-configurable thresholds; nothing learned from it can be applied`);
  }
  if (input.trades.length < input.minTrades) {
    return note(
      `${registry.name}: only ${input.trades.length} calibration-grade (TRUE_ENTRY_SNAPSHOT) trades in the window; need ${input.minTrades} before changing any of its thresholds`,
      { sample: input.trades.length, required: input.minTrades },
    );
  }

  const split = Math.floor(input.trades.length * LESSON_TRAIN_FRACTION);
  const train = input.trades.slice(0, split);
  const validation = input.trades.slice(split);
  const minVal = minValidationTrades(input.minTrades);
  const lessons: Array<Lesson & { strength: number }> = [];

  for (const def of registry.params) {
    if (!def.feature) continue;
    const from = input.params[def.key] ?? def.default;
    const tighten = tightenedThreshold(def, from);
    const trainingMetrics = splitMetrics(train, def, tighten);
    if (!hasEdge(trainingMetrics)) continue;

    const tightening = trainingMetrics.gapPp > 0;
    const step = strategyStep(def, from);
    const raw = tightening ? tighten : def.direction === 'min' ? from - step : from + step;
    const to = clampStrategyParam(def, raw);
    const validationMetrics = splitMetrics(validation, def, tighten);
    const base = {
      strategyId,
      param: def.key as LearnableParam,
      from,
      to,
      trainingSampleCount: train.length,
      validationSampleCount: validation.length,
      trainingMetrics,
      validationMetrics,
      confidence: lessonConfidence(validation.length),
      lessonVersion: LESSON_VERSION,
      strength: Math.abs(trainingMetrics.gapPp),
      evidence: {
        sample: input.trades.length,
        bandTrades: trainingMetrics.bandTrades,
        bandWinRatePct: trainingMetrics.bandWinRatePct,
        restTrades: trainingMetrics.restTrades,
        restWinRatePct: trainingMetrics.restWinRatePct,
        gapPp: trainingMetrics.gapPp,
      },
    };
    const edgeSide = def.direction === 'min' ? 'just above' : 'just below';
    const reason = `${registry.name}: trades with ${def.feature} ${edgeSide} the limit won ${pp(trainingMetrics.bandWinRatePct)} vs ${pp(trainingMetrics.restWinRatePct)} for the rest on ${train.length} training trades, so ${tightening ? 'tighten' : 'relax'} ${def.label}`;

    if (to === clampStrategyParam(def, from)) {
      lessons.push({ ...base, status: 'skipped', reason: `${reason} — already at its limit` });
      continue;
    }
    if (!tightening && def.safety) {
      lessons.push({
        ...base,
        status: 'rejected',
        reason: `${reason} — rejected: ${def.label} is a safety threshold and may only be tightened automatically`,
      });
      continue;
    }
    const dir = Math.sign(to - from);
    const flip = input.history.find(
      (h) =>
        (h.strategyId ?? null) === strategyId &&
        h.param === def.key &&
        h.status === 'applied' &&
        h.from != null &&
        h.to != null &&
        Math.sign(h.to - h.from) === -dir &&
        daysBetween(h.reportDate, input.reportDate) <= FLIP_FLOP_DAYS,
    );
    if (flip) {
      lessons.push({ ...base, status: 'skipped', reason: `${reason} — skipped because it was moved the other way on ${flip.reportDate}` });
      continue;
    }
    const confirmed =
      validation.length >= minVal &&
      hasEdge(validationMetrics) &&
      Math.sign(validationMetrics.gapPp) === Math.sign(trainingMetrics.gapPp);
    if (!confirmed) {
      lessons.push({
        ...base,
        status: 'rejected',
        reason: `${reason} — rejected: the newer ${validation.length} unseen trades did not confirm it (validation gap ${validationMetrics.gapPp.toFixed(0)} pts on ${validationMetrics.bandTrades}/${validationMetrics.restTrades} trades)`,
      });
      continue;
    }
    lessons.push({ ...base, status: 'applied', reason: `${reason} (confirmed on ${validation.length} newer, unseen trades)` });
  }

  if (lessons.length === 0) {
    return note(
      `${registry.name}: no threshold showed a clear edge (needs ${MIN_BUCKET_TRADES}+ trades on each side and a ${MIN_EDGE_PP}-point win-rate gap)`,
      { sample: input.trades.length },
    );
  }
  return lessons.sort((a, b) => b.strength - a.strength).map(({ strength: _s, ...l }) => l);
}

/**
 * Exit observations from mixed-strategy trades. Exit settings are shared by every strategy,
 * so these are reported as evidence and never applied.
 */
export function exitLessons(exits: ExitStats, settings: PortfolioSettings): Lesson[] {
  const out: Lesson[] = [];
  const scope = ' — not applied: exit settings are shared by every strategy and this evidence mixes strategies';
  const push = (param: ExitParam, from: number, raw: number, reason: string, evidence: Record<string, number>) =>
    out.push({
      strategyId: null,
      param,
      from,
      to: clampExit(param, raw),
      status: 'portfolio_scope',
      reason: `${reason}${scope}`,
      evidence,
      lessonVersion: LESSON_VERSION,
    });

  const stops = exits.byReason.stop_loss ?? 0;
  if (
    stops >= MIN_BUCKET_TRADES &&
    exits.stopLossSharePct >= 50 &&
    exits.medianStopHoldSec != null &&
    exits.medianWinnerHoldSec != null &&
    exits.medianStopHoldSec <= exits.medianWinnerHoldSec * 0.5
  ) {
    push(
      'stopLossPct',
      settings.stopLossPct,
      settings.stopLossPct + exitStep('stopLossPct', settings.stopLossPct),
      `${pp(exits.stopLossSharePct)} of trades hit the stop-loss, usually within ${exits.medianStopHoldSec.toFixed(0)}s (winners need ${exits.medianWinnerHoldSec.toFixed(0)}s); a wider stop would also raise planned loss per trade`,
      { sample: exits.total, stopLossTrades: stops, stopLossSharePct: exits.stopLossSharePct },
    );
  }
  if (exits.losers >= MIN_BUCKET_TRADES && exits.losersThatWereUpSharePct >= 30) {
    const evidence = { sample: exits.total, losers: exits.losers, losersThatWereUp: exits.losersThatWereUp };
    const reason = `${pp(exits.losersThatWereUpSharePct)} of losing trades were well in profit before reversing`;
    if (settings.trailingStopPct != null) {
      push('trailingStopPct', settings.trailingStopPct, settings.trailingStopPct - exitStep('trailingStopPct', settings.trailingStopPct), reason, evidence);
    } else {
      push('takeProfitPct', settings.takeProfitPct, settings.takeProfitPct - exitStep('takeProfitPct', settings.takeProfitPct), reason, evidence);
    }
  }
  return out;
}

/** Portfolio-level gates on provisional lessons: learning switch, observation mode, daily cap. */
export function finalizeLessons(
  lessons: Lesson[],
  opts: { enabled: boolean; observationMode: boolean },
): Lesson[] {
  let applied = 0;
  return lessons.map((l) => {
    if (l.status !== 'applied') return l;
    if (!opts.enabled) return { ...l, status: 'skipped', reason: `${l.reason} — learning is disabled` };
    if (opts.observationMode) {
      return {
        ...l,
        status: 'validated_not_applied',
        reason: `${l.reason} — held back: LEARNING_OBSERVATION_MODE collects evidence only, runtime configuration unchanged`,
      };
    }
    if (applied >= MAX_CHANGES_PER_DAY) {
      return { ...l, status: 'skipped', reason: `${l.reason} — daily limit of ${MAX_CHANGES_PER_DAY} changes reached` };
    }
    applied++;
    return l;
  });
}

/**
 * Why an `applied` lesson may not touch runtime configuration, or null if it may. A change
 * must resolve to (strategyId, parameter) and the strategy must consume that parameter.
 */
export function applicationBlock(l: Lesson): Pick<Lesson, 'status' | 'reason'> | null {
  if (l.param === 'all' || l.to == null) return { status: 'skipped', reason: `${l.reason} — nothing to apply` };
  if (!l.strategyId) {
    return {
      status: 'portfolio_scope',
      reason: `${l.reason} — not applied: a lesson without an owning strategy cannot change a strategy parameter`,
    };
  }
  if (!strategyParamDef(l.strategyId, l.param)) {
    return {
      status: 'unused_parameter',
      reason: `${l.reason} — not applied: ${l.strategyId} does not consume ${l.param}`,
    };
  }
  return null;
}

/** Applies validated, strategy-scoped lessons; downgrades any lesson that fails a guard. */
export function applyLessons(
  settings: PortfolioSettings,
  lessons: Lesson[],
): { settings: PortfolioSettings; lessons: Lesson[] } {
  let next = settings;
  const out = lessons.map((l) => {
    if (l.status !== 'applied') return l;
    const block = applicationBlock(l);
    if (block) return { ...l, ...block };
    next = setStrategyParam(next, l.strategyId!, l.param, l.to!);
    return l;
  });
  return { settings: next, lessons: out };
}

/** Pre-Week-1 lessons had no strategy; their non-exit parameters were Momentum Breakout's. */
const LEGACY_OWNER = 'momentum-breakout';

/** Restores each applied lesson's `from` value, leaving unrelated settings untouched. */
export function revertLessons(settings: PortfolioSettings, lessons: Lesson[]): {
  settings: PortfolioSettings;
  reverted: Lesson[];
} {
  let next = settings;
  const reverted: Lesson[] = [];
  for (const l of lessons) {
    if (l.status !== 'applied' || l.param === 'all' || l.from == null) continue;
    let current: number | null;
    if (!l.strategyId && EXIT_PARAMS.has(l.param)) {
      current = next[l.param as ExitParam] ?? null;
      next = setExitParam(next, l.param as ExitParam, l.from);
    } else {
      const owner = l.strategyId ?? LEGACY_OWNER;
      if (!strategyParamDef(owner, l.param)) continue;
      current = getStrategyParam(next, owner, l.param);
      next = setStrategyParam(next, owner, l.param, l.from);
    }
    reverted.push({
      strategyId: l.strategyId ?? null,
      param: l.param,
      from: current,
      to: l.from,
      status: 'reverted',
      reason: `Reverted: ${l.reason}`,
      evidence: l.evidence,
    });
  }
  return { settings: next, reverted };
}
