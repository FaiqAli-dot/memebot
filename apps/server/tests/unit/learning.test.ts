import { describe, expect, it } from 'vitest';
import { defaultPortfolioSettings } from '../../src/engines/risk/engine.js';
import { selectImportantTrades, MAX_IMPORTANT_TRADES } from '../../src/engines/learning/select.js';
import { analyzeExits, analyzeFeatures, featuresFromMarketState } from '../../src/engines/learning/analyze.js';
import {
  MAX_CHANGES_PER_DAY,
  applyLessons,
  deriveLessons,
  revertLessons,
  type DeriveInput,
} from '../../src/engines/learning/lessons.js';
import { LEARNING_BOUNDS, MAX_STEP_PCT } from '../../src/engines/learning/bounds.js';
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
    features: features === null ? null : { ...baseFeatures, ...features },
    ...rest,
  };
}

const win = (o: Parameters<typeof trade>[0] = {}) => trade({ netPnlUsd: 0.5, ...o });
const loss = (o: Parameters<typeof trade>[0] = {}) =>
  trade({ netPnlUsd: -0.4, closeReason: 'stop_loss', ...o });

function deriveInput(trades: ClosedTrade[], over: Partial<DeriveInput> = {}): DeriveInput {
  const settings = defaultPortfolioSettings();
  return {
    features: analyzeFeatures(trades, settings),
    exits: analyzeExits(trades, settings),
    settings,
    windowTradeCount: trades.length,
    minTrades: 20,
    history: [],
    reportDate: '2026-10-03',
    enabled: true,
    ...over,
  };
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

describe('featuresFromMarketState', () => {
  it('derives ratios from the stored strategy context', () => {
    const f = featuresFromMarketState(
      {
        priceUsd: 1,
        priceChange5mPct: 4,
        buyVolume5mUsd: 600,
        sellVolume5mUsd: 300,
        volume5mUsd: 900,
        priorVolume5mUsd: 450,
        liquidityUsd: 20_000,
        txCount5m: 30,
        topHolderPct: null,
        ageMinutes: 12,
      },
      66,
    )!;
    expect(f.buySellRatio).toBe(2);
    expect(f.volumeAcceleration).toBe(2);
    expect(f.overallScore).toBe(66);
    expect(f.topHolderPct).toBeNull();
    expect(featuresFromMarketState({}, 50)).toBeNull();
  });
});

describe('deriveLessons', () => {
  it('changes nothing when there are too few trades', () => {
    const trades = [win(), loss(), win()];
    const lessons = deriveLessons(deriveInput(trades));
    expect(lessons).toHaveLength(1);
    expect(lessons[0]!.param).toBe('all');
    expect(lessons[0]!.status).toBe('skipped');
  });

  it('tightens a filter by at most one step when trades near the limit lose', () => {
    // Default minPriceChange5mPct = 1.5; candidate = 1.65. Near-limit trades lose, the rest win.
    const near = Array.from({ length: 10 }, () => loss({ features: { priceChange5mPct: 1.55 } }));
    const rest = Array.from({ length: 12 }, () => win({ features: { priceChange5mPct: 6 } }));
    const lessons = deriveLessons(deriveInput([...near, ...rest]));
    const l = lessons.find((x) => x.param === 'minPriceChange5mPct')!;
    expect(l.status).toBe('applied');
    expect(l.from).toBe(1.5);
    expect(l.to).toBeCloseTo(1.65, 5);
    expect((l.to! - l.from!) / l.from!).toBeLessThanOrEqual(MAX_STEP_PCT + 1e-9);
  });

  it('respects hard bounds', () => {
    const settings = defaultPortfolioSettings();
    settings.strategyParams.minOverallScore = LEARNING_BOUNDS.minOverallScore.max;
    const near = Array.from({ length: 10 }, () => loss({ features: { overallScore: 86 } }));
    const rest = Array.from({ length: 12 }, () => win({ features: { overallScore: 99 } }));
    const trades = [...near, ...rest];
    const lessons = deriveLessons({
      ...deriveInput(trades),
      features: analyzeFeatures(trades, settings),
      settings,
    });
    const l = lessons.find((x) => x.param === 'minOverallScore')!;
    expect(l.status).toBe('skipped');
    expect(l.reason).toMatch(/safety limit/);
    expect(applyLessons(settings, lessons).strategyParams.minOverallScore).toBe(85);
  });

  it('does not reverse a recent change (no flip-flop)', () => {
    const near = Array.from({ length: 10 }, () => loss({ features: { priceChange5mPct: 1.55 } }));
    const rest = Array.from({ length: 12 }, () => win({ features: { priceChange5mPct: 6 } }));
    const lessons = deriveLessons(
      deriveInput([...near, ...rest], {
        history: [
          { reportDate: '2026-10-01', param: 'minPriceChange5mPct', from: 1.7, to: 1.5, status: 'applied' },
        ],
      }),
    );
    const l = lessons.find((x) => x.param === 'minPriceChange5mPct')!;
    expect(l.status).toBe('skipped');
    expect(l.reason).toMatch(/other way/);
  });

  it(`applies at most ${MAX_CHANGES_PER_DAY} changes per day`, () => {
    const near = Array.from({ length: 10 }, () =>
      loss({
        features: {
          priceChange5mPct: 1.55,
          buySellRatio: 1.15,
          volumeAcceleration: 1.35,
          txCount5m: 15,
          overallScore: 56,
        },
      }),
    );
    const rest = Array.from({ length: 12 }, () => win());
    const lessons = deriveLessons(deriveInput([...near, ...rest]));
    expect(lessons.filter((l) => l.status === 'applied')).toHaveLength(MAX_CHANGES_PER_DAY);
    expect(lessons.some((l) => l.reason.includes('daily limit'))).toBe(true);
  });

  it('only reports when learning is disabled', () => {
    const near = Array.from({ length: 10 }, () => loss({ features: { priceChange5mPct: 1.55 } }));
    const rest = Array.from({ length: 12 }, () => win({ features: { priceChange5mPct: 6 } }));
    const lessons = deriveLessons(deriveInput([...near, ...rest], { enabled: false }));
    expect(lessons.every((l) => l.status === 'skipped')).toBe(true);
  });

  it('revertLessons restores only the changed settings', () => {
    const settings = defaultPortfolioSettings();
    const changed = applyLessons(settings, [
      { param: 'stopLossPct', from: 0.08, to: 0.088, status: 'applied', reason: 'r', evidence: {} },
    ]);
    expect(changed.stopLossPct).toBe(0.088);
    const tweaked = { ...changed, maxPositionPct: 0.07 };
    const { settings: restored, reverted } = revertLessons(tweaked, [
      { param: 'stopLossPct', from: 0.08, to: 0.088, status: 'applied', reason: 'r', evidence: {} },
    ]);
    expect(restored.stopLossPct).toBe(0.08);
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
