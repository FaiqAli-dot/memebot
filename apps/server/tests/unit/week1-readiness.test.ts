import { describe, expect, it } from 'vitest';
import {
  STRATEGY_PARAM_REGISTRY,
  portfolioSettingsSchema,
  resolveStrategyParams,
  type Lesson,
  type StrategyParamKey,
} from '@memebot/shared';
import { defaultPortfolioSettings, normalizeSettings } from '../../src/engines/risk/engine.js';
import {
  applyLessons,
  deriveStrategyLessons,
  exitLessons,
  finalizeLessons,
  minValidationTrades,
} from '../../src/engines/learning/lessons.js';
import type { ClosedTrade, TradeFeatures } from '../../src/engines/learning/types.js';
import {
  EarlyVolumeExpansionStrategy,
  LiquidityExpansionStrategy,
  evaluateAllStrategies,
} from '../../src/strategies/catalog.js';
import { MomentumBreakoutStrategy } from '../../src/strategies/momentum-breakout.js';
import type { Strategy, StrategyContext } from '../../src/strategies/types.js';
import {
  OUTCOME_FIELDS,
  buildEntrySnapshot,
  observationQuality,
  sanitizeEntryFeatures,
  type EntryFeatures,
} from '../../src/learning/observations.js';
import { decideGate } from '../../src/learning/calibration-service.js';
import { calibrateStrategy, type CalibrationObservation } from '../../src/learning/calibration.js';
import { learningModeInfo } from '../../src/learning/mode.js';
import { EXECUTION_BACKEND, assertPaperOnly } from '../../src/domain/paper-safety.js';
import { env } from '../../src/config/env.js';

const MOMENTUM = 'momentum-breakout';
const LIQ = 'liquidity-expansion';
const EVE = 'early-volume-expansion';

const features: TradeFeatures = {
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
function trade(win: boolean, over: Partial<TradeFeatures> = {}, strategyId = MOMENTUM): ClosedTrade {
  seq++;
  const openedAt = new Date(Date.UTC(2026, 9, 1) + seq * 60_000);
  return {
    positionId: `p${seq}`,
    tokenId: `t${seq}`,
    symbol: `T${seq}`,
    strategyId,
    entryPriceUsd: 1,
    highestPriceUsd: 1.05,
    costBasisUsd: 5,
    netPnlUsd: win ? 0.5 : -0.4,
    grossPnlUsd: win ? 0.6 : -0.3,
    costsUsd: 0.1,
    closeReason: win ? 'take_profit' : 'stop_loss',
    openedAt,
    closedAt: new Date(openedAt.getTime() + 120_000),
    features: { ...features, ...over },
  };
}

/** Near-limit losers alternating with clear winners: the edge shows in both the 70% and the 30%. */
const edge = (n: number, near: Partial<TradeFeatures>) =>
  Array.from({ length: n }, (_, i) => (i % 2 === 0 ? trade(false, near) : trade(true, { priceChange5mPct: 6 })));

const derive = (trades: ClosedTrade[], strategyId = MOMENTUM) =>
  deriveStrategyLessons({ strategyId, trades, params: {}, minTrades: 20, history: [], reportDate: '2026-10-03' });

const lesson = (over: Partial<Lesson>): Lesson => ({
  strategyId: MOMENTUM,
  param: 'minPriceChange5mPct',
  from: 1.5,
  to: 1.65,
  status: 'applied',
  reason: 'r',
  evidence: {},
  ...over,
});

describe('Week-1: strategy ownership', () => {
  it('1. a lesson for strategy A changes only strategy A (even when B has the same parameter name)', () => {
    const before = defaultPortfolioSettings();
    const { settings, lessons } = applyLessons(before, [lesson({})]);
    expect(lessons[0]!.status).toBe('applied');
    expect(settings.strategyParams[MOMENTUM]!.minPriceChange5mPct).toBe(1.65);
    expect(settings.strategyParams[LIQ]).toEqual(before.strategyParams[LIQ]);
    expect(settings.strategyParams[EVE]).toEqual(before.strategyParams[EVE]);
  });

  it('2. a lesson without an owning strategy is portfolio_scope and changes nothing', () => {
    const before = defaultPortfolioSettings();
    const { settings, lessons } = applyLessons(before, [lesson({ strategyId: null })]);
    expect(lessons[0]!.status).toBe('portfolio_scope');
    expect(settings).toEqual(before);
  });

  it('3. mixed-strategy exit evidence is reported as portfolio_scope and never applied', () => {
    const before = defaultPortfolioSettings();
    const exits = {
      total: 40,
      byReason: { stop_loss: 30, take_profit: 10 },
      stopLossSharePct: 75,
      medianStopHoldSec: 20,
      medianWinnerHoldSec: 200,
      losers: 30,
      losersThatWereUp: 15,
      losersThatWereUpSharePct: 50,
      avgLoserPeakGainPct: 4,
    };
    const ex = exitLessons(exits, before);
    expect(ex.length).toBeGreaterThan(0);
    expect(ex.every((l) => l.status === 'portfolio_scope' && l.strategyId == null)).toBe(true);
    const { settings } = applyLessons(before, finalizeLessons(ex, { enabled: true, observationMode: false }));
    expect(settings).toEqual(before);
  });
});

describe('Week-1: parameter usage', () => {
  it('4. a parameter the strategy consumes is applied', () => {
    const { settings } = applyLessons(defaultPortfolioSettings(), [
      lesson({ strategyId: EVE, param: 'minVolumeAcceleration', from: 1.8, to: 1.98 }),
    ]);
    expect(settings.strategyParams[EVE]!.minVolumeAcceleration).toBe(1.98);
  });

  it('5. a parameter the strategy does not consume is UNUSED_PARAMETER and never applied', () => {
    const before = defaultPortfolioSettings();
    const { settings, lessons } = applyLessons(before, [
      lesson({ strategyId: EVE, param: 'minPriceChange5mPct' }),
      lesson({ strategyId: 'trend-continuation', param: 'minPriceChange5mPct' }),
    ]);
    expect(lessons.map((l) => l.status)).toEqual(['unused_parameter', 'unused_parameter']);
    expect(settings).toEqual(before);
    // The settings API refuses it too, and stored junk is dropped on read
    expect(portfolioSettingsSchema.safeParse({ strategyParams: { [EVE]: { minPriceChange5mPct: 2 } } }).success).toBe(false);
    expect(resolveStrategyParams({ [EVE]: { minPriceChange5mPct: 2 } })[EVE]).not.toHaveProperty('minPriceChange5mPct');
  });

  it('6. the strategy reads the stored value at runtime — every registered parameter (table-driven)', () => {
    const base: StrategyContext = {
      tokenId: 't',
      address: 'a',
      symbol: 'S',
      chain: 'solana',
      ageMinutes: 30,
      priceUsd: 1,
      liquidityUsd: 30_000,
      liquidityStatus: 'KNOWN',
      volume5mUsd: 8_000,
      volume1hUsd: 40_000,
      buyVolume5mUsd: 6_000,
      sellVolume5mUsd: 2_000,
      txCount5m: 40,
      priceChange5mPct: 5,
      priceChange1hPct: 10,
      holderCount: 500,
      topHolderPct: 15,
      observedAt: new Date(),
      priorVolume5mUsd: 3_000,
      phase: 'EARLY_MOMENTUM',
    };
    const strategies: Record<string, Strategy> = {
      [MOMENTUM]: new MomentumBreakoutStrategy(),
      [EVE]: new EarlyVolumeExpansionStrategy(),
      [LIQ]: new LiquidityExpansionStrategy(),
    };
    // A value that rejects `base` (or the given context) while the default accepts it
    const cases: Array<{ id: string; key: StrategyParamKey; value: number; ctx?: Partial<StrategyContext> }> = [
      { id: MOMENTUM, key: 'minLiquidityUsd', value: 40_000 },
      { id: MOMENTUM, key: 'minVolume5mUsd', value: 9_000 },
      { id: MOMENTUM, key: 'minVolumeAcceleration', value: 2.9 },
      { id: MOMENTUM, key: 'minPriceChange5mPct', value: 6 },
      { id: MOMENTUM, key: 'minBuySellRatio', value: 2.8, ctx: { buyVolume5mUsd: 5_000 } },
      { id: MOMENTUM, key: 'minActivityTx5m', value: 50 },
      { id: MOMENTUM, key: 'minTokenAgeMinutes', value: 40 },
      { id: MOMENTUM, key: 'maxTokenAgeMinutes', value: 60, ctx: { ageMinutes: 100 } },
      { id: MOMENTUM, key: 'maxTopHolderPct', value: 12 },
      { id: MOMENTUM, key: 'minOverallScore', value: 85 },
      { id: EVE, key: 'minVolumeAcceleration', value: 2.9 },
      { id: EVE, key: 'minVolume5mUsd', value: 9_000 },
      { id: LIQ, key: 'minLiquidityUsd', value: 40_000 },
      { id: LIQ, key: 'minPriceChange5mPct', value: 6 },
    ];
    const registered = Object.entries(STRATEGY_PARAM_REGISTRY).flatMap(([id, s]) => s.params.map((p) => `${id}.${p.key}`));
    expect(cases.map((c) => `${c.id}.${c.key}`).sort()).toEqual(registered.sort());

    for (const c of cases) {
      const ctx = { ...base, ...c.ctx };
      const s = strategies[c.id]!;
      expect(s.evaluate(ctx).action, `${c.id}.${c.key} default`).toBe('BUY');
      expect(s.evaluate(ctx, { [c.key]: c.value }).action, `${c.id}.${c.key}=${c.value}`).toBe('NO_TRADE');
    }

    // Through the runtime entry point, each strategy receives only its own values
    const { all } = evaluateAllStrategies(Object.values(strategies), base, { [MOMENTUM]: { minPriceChange5mPct: 6 } });
    expect(Object.fromEntries(all.map((x) => [x.strategyId, x.action]))).toEqual({
      [MOMENTUM]: 'NO_TRADE',
      [EVE]: 'BUY',
      [LIQ]: 'BUY',
    });
  });

  it('7. one authoritative value: legacy flat params resolve as Momentum Breakout values, clamped', () => {
    const s = normalizeSettings({ strategyParams: { minPriceChange5mPct: 2, minOverallScore: 999 } as never });
    expect(s.strategyParams[MOMENTUM]!.minPriceChange5mPct).toBe(2);
    expect(s.strategyParams[MOMENTUM]!.minOverallScore).toBe(85);
    expect(s.strategyParams[LIQ]!.minPriceChange5mPct).toBe(0.5);
  });
});

describe('Week-1: lesson validation (70/30)', () => {
  it('8. a training edge the unseen 30% does not confirm is rejected', () => {
    // Older 42: near-limit trades lose. Newer 18: everything wins → no edge out of sample.
    const trades = [...edge(42, { priceChange5mPct: 1.55 }), ...Array.from({ length: 18 }, (_, i) => trade(true, i % 2 ? {} : { priceChange5mPct: 1.55 }))];
    const l = derive(trades).find((x) => x.param === 'minPriceChange5mPct')!;
    expect(l.status).toBe('rejected');
    expect(l.reason).toMatch(/did not confirm/);
    expect(l.trainingMetrics!.gapPp).toBeGreaterThanOrEqual(15);
  });

  it('9. a confirmed edge is applied with full audit fields', () => {
    const l = derive(edge(60, { priceChange5mPct: 1.55 })).find((x) => x.param === 'minPriceChange5mPct')!;
    expect(l).toMatchObject({ status: 'applied', strategyId: MOMENTUM, from: 1.5, to: 1.65, confidence: 'LOW' });
    expect(l.validationMetrics!.gapPp).toBeGreaterThanOrEqual(15);
    expect(l.lessonVersion).toBe('strategy-lessons-v2');
  });

  it('10. split is chronological 70/30', () => {
    const l = derive(edge(60, { priceChange5mPct: 1.55 })).find((x) => x.param === 'minPriceChange5mPct')!;
    expect(l.trainingSampleCount).toBe(42);
    expect(l.validationSampleCount).toBe(18);
    expect(minValidationTrades(20)).toBe(9);
  });
});

describe('Week-1: observation quality', () => {
  const core = { observedAt: '2026-10-01T00:00:00Z', quoteAgeMs: 500, liquidityUsd: 1, priceChange5mPct: 1, volume5mUsd: 1 };

  it('11. an entry snapshot with every core feature is TRUE_ENTRY_SNAPSHOT (calibration-eligible)', () => {
    expect(observationQuality('ENTRY_SNAPSHOT', core)).toBe('TRUE_ENTRY_SNAPSHOT');
    expect(observationQuality('ENTRY_SNAPSHOT', { ...core, quoteAgeMs: null })).toBe('PARTIAL_ENTRY_SNAPSHOT');
  });

  it('12. signal backfill is never equivalent, however complete', () => {
    expect(observationQuality('SIGNAL_BACKFILL', core)).toBe('SIGNAL_BACKFILL');
  });

  it('13. backfill does not count toward the calibration gate but is reported', () => {
    const g = decideGate({
      enabled: true,
      newObservations: 3,
      excludedObservations: 31,
      requiredObservations: 25,
      intervalStartsAt: new Date(0),
      requiredHours: 24,
      now: new Date(),
    });
    expect(g.decision).toBe('SKIPPED_INSUFFICIENT_OBSERVATIONS');
    expect(g.reason).toMatch(/only 3 new calibration-grade/);
    expect(g.reason).toMatch(/31 backfilled\/partial observations .* do not count/);
  });

  it('14. lessons skip with a TRUE_ENTRY_SNAPSHOT note rather than using fewer grade trades', () => {
    const [note] = derive(edge(10, { priceChange5mPct: 1.55 }));
    expect(note!.status).toBe('skipped');
    expect(note!.reason).toMatch(/TRUE_ENTRY_SNAPSHOT/);
  });
});

describe('Week-1: no look-ahead', () => {
  it('15. outcome fields are stripped from entry features, including strategy inputs', () => {
    const dirty = {
      ...core(),
      netPnlUsd: 1,
      mfePct: 30,
      maePct: -5,
      exitPriceUsd: 2,
      strategyInputs: { ...features, win: true, netReturn: 0.2 },
    } as unknown as EntryFeatures;
    const clean = sanitizeEntryFeatures(dirty);
    for (const f of OUTCOME_FIELDS) {
      expect(clean).not.toHaveProperty(f);
      expect(clean.strategyInputs).not.toHaveProperty(f);
    }
    expect(clean.liquidityUsd).toBe(30_000);
  });

  it('16. the entry snapshot is built only from entry-time data (MFE/MAE are outcomes)', () => {
    const snap = buildEntrySnapshot({
      signalMarketState: { priceUsd: 1, priceChange5mPct: 4, buyVolume5mUsd: 600, sellVolume5mUsd: 300, mfePct: 99 },
      signalAt: new Date('2026-10-01T00:00:00Z'),
      signalOverallScore: 70,
      market: {
        observed_at: new Date('2026-10-01T00:00:01Z'),
        price_usd: 1,
        liquidity_usd: 30_000,
        liquidity_status: 'KNOWN',
        volume_5m_usd: 9000,
        volume_1h_usd: 50_000,
        buy_volume_5m_usd: 600,
        sell_volume_5m_usd: 300,
        buys_5m: 10,
        sells_5m: 5,
        tx_count_5m: 15,
        price_change_5m_pct: 4,
        price_change_1h_pct: 9,
      },
      quoteAgeMs: 900,
      regime: 'NORMAL',
      dataConfidence: 'MEDIUM',
      maxHoldSec: 1800,
    });
    const keys = JSON.stringify(snap.features);
    expect(keys).not.toMatch(/mfe|mae|exit|pnl|netReturn/i);
    expect(observationQuality('ENTRY_SNAPSHOT', snap.features as EntryFeatures)).toBe('TRUE_ENTRY_SNAPSHOT');
  });
});

function core() {
  return {
    observedAt: '2026-10-01T00:00:00Z',
    quoteAgeMs: 500,
    liquidityUsd: 30_000,
    priceChange5mPct: 4,
    volume5mUsd: 9000,
  };
}

describe('Week-1: paper safety and observation mode', () => {
  it('17. execution is the paper simulator and live modes are refused', () => {
    expect(EXECUTION_BACKEND).toBe('PAPER_SIMULATOR');
    expect(env.TRADING_MODE).toBe('PAPER');
    expect(() => assertPaperOnly({ TRADING_MODE: 'LIVE', REAL_EXECUTION_ENABLED: false, WALLET_SIGNING_ENABLED: false })).toThrow();
    expect(() => assertPaperOnly({ TRADING_MODE: 'PAPER', REAL_EXECUTION_ENABLED: true, WALLET_SIGNING_ENABLED: false })).toThrow();
    expect(() => assertPaperOnly({ TRADING_MODE: 'PAPER', REAL_EXECUTION_ENABLED: false, WALLET_SIGNING_ENABLED: true })).toThrow();
  });

  it('18. observation mode holds validated lessons and blocks automatic calibration promotion', () => {
    const prev = env.LEARNING_OBSERVATION_MODE;
    env.LEARNING_OBSERVATION_MODE = true;
    try {
      expect(learningModeInfo()).toMatchObject({
        banner: 'PAPER TRADING — WEEK 1 OBSERVATION MODE',
        liveExecution: 'DISABLED',
        automaticStrategyPromotion: 'DISABLED',
        automaticRiskExpansion: 'DISABLED',
      });
    } finally {
      env.LEARNING_OBSERVATION_MODE = prev;
    }
    const before = defaultPortfolioSettings();
    const held = finalizeLessons(derive(edge(60, { priceChange5mPct: 1.55 })), { enabled: true, observationMode: true });
    expect(held.find((l) => l.param === 'minPriceChange5mPct')!.status).toBe('validated_not_applied');
    expect(applyLessons(before, held).settings).toEqual(before);

    // EV overstated by construction: would be PROMOTED, but stays VALIDATED
    const rows: CalibrationObservation[] = Array.from({ length: 400 }, (_, i) => {
      const ev = 0.02 + ((i * 37) % 60) / 1000;
      const r = 0.4 * ev - 0.01 + (((i * 7919) % 101) - 50) / 5000;
      return {
        seq: i,
        exitAt: new Date(Date.UTC(2026, 9, 1) + i * 60_000),
        predictedEv: ev,
        predictedWinProbability: 0.55,
        netReturn: r,
        netPnlUsd: r * 5,
        win: r > 0,
        mfePct: 5,
        maePct: -3,
        dataConfidence: 'MEDIUM',
        marketRegime: 'NORMAL',
        liquidityBucket: '10K_50K',
        riskTier: 'NORMAL',
      };
    });
    const promoted = calibrateStrategy({ strategyId: 's', rows, current: null, totalProductionObservations: 400 });
    expect(promoted.status).toBe('PROMOTED');
    const observed = calibrateStrategy({ strategyId: 's', rows, current: null, totalProductionObservations: 400, autoPromotion: false });
    expect(observed.status).toBe('VALIDATED');
    expect(observed.promotionDecision).toMatch(/automatic promotion is disabled/);
  });

  it('19. five consecutive losses do not modify parameters', () => {
    const before = defaultPortfolioSettings();
    const losses = Array.from({ length: 5 }, () => trade(false, { priceChange5mPct: 1.55 }));
    const out = finalizeLessons(derive(losses), { enabled: true, observationMode: false });
    expect(out.some((l) => l.status === 'applied')).toBe(false);
    expect(applyLessons(before, out).settings).toEqual(before);
  });

  it('20. five consecutive wins do not modify parameters or position sizing', () => {
    const before = defaultPortfolioSettings();
    const wins = Array.from({ length: 5 }, () => trade(true));
    const out = finalizeLessons(derive(wins), { enabled: true, observationMode: false });
    expect(out.some((l) => l.status === 'applied')).toBe(false);
    const after = applyLessons(before, out).settings;
    expect(after).toEqual(before);
    expect(after.maxPositionPct).toBe(before.maxPositionPct);
    expect(after.maxRiskPerTradePct).toBe(before.maxRiskPerTradePct);
  });
});
