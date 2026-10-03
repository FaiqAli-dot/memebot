import type {
  ExitStats,
  FeatureStat,
  LearnableParam,
  Lesson,
  PortfolioSettings,
} from '@memebot/shared';
import { MIN_BUCKET_TRADES } from './analyze.js';
import { clampToBounds, getParam, setParam, stepFor } from './bounds.js';

/** Win-rate gap (percentage points) required before a threshold moves. */
export const MIN_EDGE_PP = 15;
export const MAX_CHANGES_PER_DAY = 3;
/** A setting may not move in the opposite direction within this many days. */
export const FLIP_FLOP_DAYS = 3;

export interface PastLesson {
  reportDate: string;
  param: LearnableParam | 'all';
  from: number | null;
  to: number | null;
  status: Lesson['status'];
}

export interface DeriveInput {
  features: FeatureStat[];
  exits: ExitStats;
  settings: PortfolioSettings;
  windowTradeCount: number;
  minTrades: number;
  history: PastLesson[];
  reportDate: string;
  enabled: boolean;
}

interface Candidate {
  param: LearnableParam;
  from: number;
  to: number;
  strength: number;
  reason: string;
  evidence: Record<string, number>;
}

const pp = (n: number) => `${n.toFixed(0)}%`;

function featureCandidates(features: FeatureStat[]): Candidate[] {
  const out: Candidate[] = [];
  for (const f of features) {
    if (f.band.n < MIN_BUCKET_TRADES || f.rest.n < MIN_BUCKET_TRADES) continue;
    const gap = f.rest.winRatePct - f.band.winRatePct;
    if (Math.abs(gap) < MIN_EDGE_PP) continue;
    const evidence = {
      sample: f.band.n + f.rest.n,
      bandTrades: f.band.n,
      bandWinRatePct: f.band.winRatePct,
      restTrades: f.rest.n,
      restWinRatePct: f.rest.winRatePct,
      gapPp: gap,
    };
    const edgeSide = f.direction === 'min' ? 'just above' : 'just below';
    if (gap > 0) {
      out.push({
        param: f.param,
        from: f.threshold,
        to: f.candidate,
        strength: gap,
        reason: `Trades with ${f.feature} ${edgeSide} the limit won ${pp(f.band.winRatePct)} vs ${pp(f.rest.winRatePct)} for the rest, so tighten the filter`,
        evidence,
      });
    } else {
      const step = stepFor(f.param, f.threshold);
      out.push({
        param: f.param,
        from: f.threshold,
        to: f.direction === 'min' ? f.threshold - step : f.threshold + step,
        strength: -gap,
        reason: `Trades with ${f.feature} ${edgeSide} the limit won ${pp(f.band.winRatePct)} vs ${pp(f.rest.winRatePct)} for the rest, so the filter may be too strict; relax it slightly`,
        evidence,
      });
    }
  }
  return out;
}

function exitCandidates(exits: ExitStats, settings: PortfolioSettings): Candidate[] {
  const out: Candidate[] = [];
  const stops = exits.byReason.stop_loss ?? 0;
  if (
    stops >= MIN_BUCKET_TRADES &&
    exits.stopLossSharePct >= 50 &&
    exits.medianStopHoldSec != null &&
    exits.medianWinnerHoldSec != null &&
    exits.medianStopHoldSec <= exits.medianWinnerHoldSec * 0.5
  ) {
    out.push({
      param: 'stopLossPct',
      from: settings.stopLossPct,
      to: settings.stopLossPct + stepFor('stopLossPct', settings.stopLossPct),
      strength: exits.stopLossSharePct - 35,
      reason: `${pp(exits.stopLossSharePct)} of trades hit the stop-loss, usually within ${exits.medianStopHoldSec.toFixed(0)}s (winners need ${exits.medianWinnerHoldSec.toFixed(0)}s), so the stop is likely catching noise; widen it`,
      evidence: {
        sample: exits.total,
        stopLossTrades: stops,
        stopLossSharePct: exits.stopLossSharePct,
        medianStopHoldSec: exits.medianStopHoldSec,
        medianWinnerHoldSec: exits.medianWinnerHoldSec,
      },
    });
  }

  const losers = exits.losers;
  if (losers >= MIN_BUCKET_TRADES && exits.losersThatWereUpSharePct >= 30) {
    const evidence = {
      sample: exits.total,
      losers,
      losersThatWereUp: exits.losersThatWereUp,
      losersThatWereUpSharePct: exits.losersThatWereUpSharePct,
    };
    const strength = exits.losersThatWereUpSharePct - 15;
    if (settings.trailingStopPct != null) {
      out.push({
        param: 'trailingStopPct',
        from: settings.trailingStopPct,
        to: settings.trailingStopPct - stepFor('trailingStopPct', settings.trailingStopPct),
        strength,
        reason: `${pp(exits.losersThatWereUpSharePct)} of losing trades were well in profit before reversing, so tighten the trailing stop to lock gains earlier`,
        evidence,
      });
    } else {
      out.push({
        param: 'takeProfitPct',
        from: settings.takeProfitPct,
        to: settings.takeProfitPct - stepFor('takeProfitPct', settings.takeProfitPct),
        strength,
        reason: `${pp(exits.losersThatWereUpSharePct)} of losing trades were well in profit before reversing, so lower take-profit to bank gains earlier`,
        evidence,
      });
    }
  }
  return out;
}

function daysBetween(a: string, b: string): number {
  return Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;
}

/** Turns analysis into guarded setting changes. Pure: never touches the database. */
export function deriveLessons(input: DeriveInput): Lesson[] {
  if (input.windowTradeCount < input.minTrades) {
    return [
      {
        param: 'all',
        from: null,
        to: null,
        status: 'skipped',
        reason: `Only ${input.windowTradeCount} closed trades in the review window; need ${input.minTrades} before changing any setting`,
        evidence: { sample: input.windowTradeCount, required: input.minTrades },
      },
    ];
  }

  const candidates = [
    ...featureCandidates(input.features),
    ...exitCandidates(input.exits, input.settings),
  ].sort((a, b) => b.strength - a.strength);

  const lessons: Lesson[] = [];
  let appliedCount = 0;
  for (const c of candidates) {
    const to = clampToBounds(c.param, c.to);
    const base = { param: c.param, from: c.from, evidence: c.evidence };

    if (to === clampToBounds(c.param, c.from)) {
      lessons.push({ ...base, to, status: 'skipped', reason: `${c.reason} — already at its safety limit` });
      continue;
    }
    const dir = Math.sign(to - c.from);
    const flip = input.history.find(
      (h) =>
        h.param === c.param &&
        h.status === 'applied' &&
        h.from != null &&
        h.to != null &&
        Math.sign(h.to - h.from) === -dir &&
        daysBetween(h.reportDate, input.reportDate) <= FLIP_FLOP_DAYS,
    );
    if (flip) {
      lessons.push({
        ...base,
        to,
        status: 'skipped',
        reason: `${c.reason} — skipped because it was moved the other way on ${flip.reportDate}`,
      });
      continue;
    }
    if (!input.enabled) {
      lessons.push({ ...base, to, status: 'skipped', reason: `${c.reason} — learning is disabled` });
      continue;
    }
    if (appliedCount >= MAX_CHANGES_PER_DAY) {
      lessons.push({
        ...base,
        to,
        status: 'skipped',
        reason: `${c.reason} — daily limit of ${MAX_CHANGES_PER_DAY} changes reached`,
      });
      continue;
    }
    appliedCount++;
    lessons.push({ ...base, to, status: 'applied', reason: c.reason });
  }

  if (lessons.length === 0) {
    lessons.push({
      param: 'all',
      from: null,
      to: null,
      status: 'skipped',
      reason: `No setting showed a clear edge (needs ${MIN_BUCKET_TRADES}+ trades on each side and a ${MIN_EDGE_PP}-point win-rate gap)`,
      evidence: { sample: input.windowTradeCount },
    });
  }
  return lessons;
}

export function applyLessons(settings: PortfolioSettings, lessons: Lesson[]): PortfolioSettings {
  let next = settings;
  for (const l of lessons) {
    if (l.status !== 'applied' || l.param === 'all' || l.to == null) continue;
    next = setParam(next, l.param, l.to);
  }
  return next;
}

/** Restores each applied lesson's `from` value, leaving unrelated settings untouched. */
export function revertLessons(settings: PortfolioSettings, lessons: Lesson[]): {
  settings: PortfolioSettings;
  reverted: Lesson[];
} {
  let next = settings;
  const reverted: Lesson[] = [];
  for (const l of lessons) {
    if (l.status !== 'applied' || l.param === 'all' || l.from == null) continue;
    const current = getParam(next, l.param);
    next = setParam(next, l.param, l.from);
    reverted.push({
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
