import { describe, expect, it } from 'vitest';
import { defaultPortfolioSettings } from '../../src/engines/risk/engine.js';
import { selectImportantTrades, MAX_IMPORTANT_TRADES } from '../../src/engines/learning/select.js';
import { strategyInputsFromMarketState } from '../../src/engines/learning/analyze.js';
import {
  MAX_CHANGES_PER_DAY,
  applyLessons,
  deriveStrategyLessons,
  finalizeLessons,
  revertLessons,
  type PastLesson,
} from '../../src/engines/learning/lessons.js';
import { MAX_STEP_PCT } from '../../src/engines/learning/bounds.js';
import { strategyParamDef, type StrategyParamValues } from '@memebot/shared';
import { reviewLessons } from '../../src/engines/learning/review.js';
import type { ClosedTrade, TradeFeatures } from '../../src/engines/learning/types.js';
import { addDays, isReportDue, localDateTime } from '../../src/services/report-service.js';

const baseFeatures: TradeFeatures = {
  priceChange5mPct: 5,
  buySellRatio: 1.5,
  volumeAcceleration: 1.6,
  liquidityUsd: 30_000,
  txCount5m: 40,
  volume5mUsd: 8_000,
  overallScore: 70,
  topHolderPct: 15,
  ageMinutes: 60,
};

let seq = 0;
function trade(over: Partial<ClosedTrade> & { features?: Partial<TradeFeatures> | null } = {}): ClosedTrade {
  seq++;
  const opened = new Date('2026-10-03T10:00:00Z');
  const { features, ...rest } = over;
  return {
    positionId: `pos-${seq}`,
    tokenId: `tok-${seq}`,
    symbol: `T${seq}`,
    entryPriceUsd: 1,
    highestPriceUsd: 1.02,
    costBasisUsd: 5,
    netPnlUsd: 0.5,
    grossPnlUsd: 0.6,
    costsUsd: 0.1,
    closeReason: 'take_profit',
    openedAt: opened,
    closedAt: new Date(opened.getTime() + 120_000),
    strategyId: 'momentum-breakout',
    features: features === null ? null : { ...baseFeatures, ...features },
    ...rest,
  };
}

const win = (o: Parameters<typeof trade>[0] = {}) => trade({ netPnlUsd: 0.5, ...o });
const loss = (o: Parameters<typeof trade>[0] = {}) =>
  trade({ netPnlUsd: -0.4, closeReason: 'stop_loss', ...o });

/** Alternating near-limit losers and clear winners, so both the 70% and the 30% show the edge. */
function edgeTrades(n: number, near: Partial<TradeFeatures>, rest: Partial<TradeFeatures> = {}): ClosedTrade[] {
  return Array.from({ length: n }, (_, i) => (i % 2 === 0 ? loss({ features: near }) : win({ features: rest })));
}

function derive(
  trades: ClosedTrade[],
  over: { params?: StrategyParamValues; history?: PastLesson[]; minTrades?: number } = {},
) {
  return deriveStrategyLessons({
    strategyId: 'momentum-breakout',
    trades,
    params: over.params ?? {},
    minTrades: over.minTrades ?? 20,
    history: over.history ?? [],
    reportDate: '2026-10-03',
  });
}

describe('selectImportantTrades', () => {
  it('tags winners, losers, fast stop-outs and cost-eaten trades without duplicates', () => {
    const bigWin = win({ netPnlUsd: 3 });
    const bigLoss = loss({ netPnlUsd: -2, closedAt: new Date('2026-10-03T10:00:05Z') });
    const eaten = trade({ netPnlUsd: -0.05, costsUsd: 0.3, closeReason: 'max_holding_time' });
    const picked = selectImportantTrades([bigWin, bigLoss, eaten, win(), loss()]);

    const lossEntry = picked.find((p) => p.positionId === bigLoss.positionId)!;
    expect(lossEntry.tags).toEqual(['biggest_loss', 'fast_stop_out']);
    expect(picked.find((p) => p.positionId === eaten.positionId)!.tags).toContain('costs_ate_gain');
    expect(picked[0]!.positionId).toBe(bigWin.positionId);
    expect(new Set(picked.map((p) => p.positionId)).size).toBe(picked.length);
  });

  it('caps the list', () => {
    const many = [
      ...Array.from({ length: 10 }, (_, i) => win({ netPnlUsd: i + 1 })),
      ...Array.from({ length: 10 }, (_, i) => loss({ netPnlUsd: -(i + 1) })),
      ...Array.from({ length: 5 }, () => trade({ netPnlUsd: -0.01, costsUsd: 1 })),
    ];
    expect(selectImportantTrades(many).length).toBeLessThanOrEqual(MAX_IMPORTANT_TRADES);
  });
});

describe('strategyInputsFromMarketState', () => {
  it('rebuilds exactly the inputs strategies compare against (capped volume acceleration)', () => {
    const f = strategyInputsFromMarketState(
      {
        priceUsd: 1,
        priceChange5mPct: 4,
        buyVolume5mUsd: 600,
        sellVolume5mUsd: 300,
        volume5mUsd: 900,
        priorVolume5mUsd: 100,
        volumeAccel: { raw: 9, capped: 2.5, method: 'non_overlapping' },
        liquidityUsd: 20_000,
        txCount5m: 30,
        topHolderPct: null,
        ageMinutes: 12,
      },
      66,
    )!;
    expect(f.buySellRatio).toBe(2);
    expect(f.volumeAcceleration).toBe(2.5);
    expect(f.overallScore).toBe(66);
    expect(f.topHolderPct).toBeNull();
    expect(strategyInputsFromMarketState({}, null)!.volumeAcceleration).toBeNull();
    expect(strategyInputsFromMarketState(null, 50)).toBeNull();
  });
});

describe('deriveStrategyLessons', () => {
  it('changes nothing when there are too few calibration-grade trades', () => {
    const lessons = derive([win(), loss(), win()]);
    expect(lessons).toHaveLength(1);
    expect(lessons[0]!.param).toBe('all');
    expect(lessons[0]!.status).toBe('skipped');
    expect(lessons[0]!.reason).toMatch(/TRUE_ENTRY_SNAPSHOT/);
  });

  it('tightens a filter by at most one step when trades near the limit lose', () => {
    // Default minPriceChange5mPct = 1.5; candidate = 1.65. Near-limit trades lose, the rest win.
    const lessons = derive(edgeTrades(60, { priceChange5mPct: 1.55 }, { priceChange5mPct: 6 }));
    const l = lessons.find((x) => x.param === 'minPriceChange5mPct')!;
    expect(l.status).toBe('applied');
    expect(l.strategyId).toBe('momentum-breakout');
    expect(l.from).toBe(1.5);
    expect(l.to).toBeCloseTo(1.65, 5);
    expect((l.to! - l.from!) / l.from!).toBeLessThanOrEqual(MAX_STEP_PCT + 1e-9);
  });

  it('respects hard bounds', () => {
    const max = strategyParamDef('momentum-breakout', 'minOverallScore')!.max;
    const lessons = derive(edgeTrades(60, { overallScore: max + 1 }, { overallScore: 99 }), {
      params: { minOverallScore: max },
    });
    const l = lessons.find((x) => x.param === 'minOverallScore')!;
    expect(l.status).toBe('skipped');
    expect(l.reason).toMatch(/already at its limit/);
  });

  it('does not reverse a recent change of the same strategy (no flip-flop)', () => {
    const trades = edgeTrades(60, { priceChange5mPct: 1.55 }, { priceChange5mPct: 6 });
    const moved: PastLesson = {
      reportDate: '2026-10-01',
      strategyId: 'momentum-breakout',
      param: 'minPriceChange5mPct',
      from: 1.7,
      to: 1.5,
      status: 'applied',
    };
    const l = derive(trades, { history: [moved] }).find((x) => x.param === 'minPriceChange5mPct')!;
    expect(l.status).toBe('skipped');
    expect(l.reason).toMatch(/other way/);
    // A different strategy's history does not block it
    const other = derive(trades, { history: [{ ...moved, strategyId: 'liquidity-expansion' }] });
    expect(other.find((x) => x.param === 'minPriceChange5mPct')!.status).toBe('applied');
  });

  it(`applies at most ${MAX_CHANGES_PER_DAY} changes per day`, () => {
    const near = { priceChange5mPct: 1.55, buySellRatio: 1.15, volumeAcceleration: 1.35, txCount5m: 15, overallScore: 56 };
    const lessons = finalizeLessons(derive(edgeTrades(60, near)), { enabled: true, observationMode: false });
    expect(lessons.filter((l) => l.status === 'applied')).toHaveLength(MAX_CHANGES_PER_DAY);
    expect(lessons.some((l) => l.reason.includes('daily limit'))).toBe(true);
  });

  it('only reports when learning is disabled', () => {
    const lessons = finalizeLessons(derive(edgeTrades(60, { priceChange5mPct: 1.55 }, { priceChange5mPct: 6 })), {
      enabled: false,
      observationMode: false,
    });
    expect(lessons.some((l) => l.status === 'applied')).toBe(false);
  });

  it('revertLessons restores only the changed strategy setting', () => {
    const lesson = {
      strategyId: 'momentum-breakout',
      param: 'minPriceChange5mPct' as const,
      from: 1.5,
      to: 1.65,
      status: 'applied' as const,
      reason: 'r',
      evidence: {},
    };
    const { settings: changed } = applyLessons(defaultPortfolioSettings(), [lesson]);
    expect(changed.strategyParams['momentum-breakout']!.minPriceChange5mPct).toBe(1.65);
    const tweaked = { ...changed, maxPositionPct: 0.07 };
    const { settings: restored, reverted } = revertLessons(tweaked, [lesson]);
    expect(restored.strategyParams['momentum-breakout']!.minPriceChange5mPct).toBe(1.5);
    expect(restored.maxPositionPct).toBe(0.07);
    expect(reverted[0]!.status).toBe('reverted');
  });
});

describe('reviewLessons', () => {
  const good = () => Array.from({ length: 10 }, (_, i) => (i < 7 ? win() : loss()));
  const bad = () => Array.from({ length: 10 }, (_, i) => (i < 3 ? win() : loss()));

  it('is inconclusive with too few trades', () => {
    const r = reviewLessons({ targetReportId: 'r1', since: [win()], before: good(), previousVerdict: null });
    expect(r.verdict).toBe('inconclusive');
  });

  it('flags worse but only reverts on the second worse report in a row', () => {
    const first = reviewLessons({ targetReportId: 'r1', since: bad(), before: good(), previousVerdict: 'better' });
    expect(first.verdict).toBe('worse');
    expect(first.reverted).toBe(false);
    const second = reviewLessons({ targetReportId: 'r1', since: bad(), before: good(), previousVerdict: 'worse' });
    expect(second.reverted).toBe(true);
  });

  it('recognizes improvement', () => {
    const r = reviewLessons({ targetReportId: 'r1', since: good(), before: bad(), previousVerdict: 'worse' });
    expect(r.verdict).toBe('better');
    expect(r.reverted).toBe(false);
  });
});

describe('report scheduling helpers', () => {
  it('uses the configured timezone for date and time', () => {
    const now = new Date('2026-10-03T20:30:00Z'); // 00:30 next day in Dubai
    expect(localDateTime(now, 'Asia/Dubai')).toEqual({ date: '2026-10-04', time: '00:30' });
    expect(isReportDue(new Date('2026-10-03T19:56:00Z'), 'Asia/Dubai', '23:55')).toBe(true);
    expect(isReportDue(new Date('2026-10-03T19:50:00Z'), 'Asia/Dubai', '23:55')).toBe(false);
  });

  it('adds days across month boundaries', () => {
    expect(addDays('2026-10-01', -6)).toBe('2026-09-25');
  });
});
