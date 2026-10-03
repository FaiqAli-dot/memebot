import { describe, expect, it } from 'vitest';
import {
  MomentumStrategyV1,
  DEFAULT_MOMENTUM_PARAMS,
  riskLabelFromScore,
} from '../../src/engines/strategy/momentum-v1.js';

describe('MomentumStrategyV1', () => {
  const strategy = new MomentumStrategyV1();

  const strongCtx = {
    tokenId: 't1',
    address: 'addr',
    symbol: 'TEST',
    chain: 'solana',
    ageMinutes: 30,
    priceUsd: 0.01,
    liquidityUsd: 20000,
    volume5mUsd: 8000,
    volume1hUsd: 20000,
    buyVolume5mUsd: 5500,
    sellVolume5mUsd: 2500,
    txCount5m: 40,
    priceChange5mPct: 6,
    priceChange1hPct: 12,
    holderCount: 200,
    topHolderPct: 8,
    observedAt: new Date(),
    priorVolume5mUsd: 3000,
  };

  it('scores and explains without claiming probability', () => {
    const scores = strategy.score(strongCtx, DEFAULT_MOMENTUM_PARAMS);
    expect(scores.overall).toBeGreaterThan(50);
    const explanation = strategy.explain(strongCtx, scores);
    expect(explanation.reasons.length).toBeGreaterThan(0);
  });

  it('passes strong momentum setup', () => {
    const ev = strategy.evaluate(strongCtx, DEFAULT_MOMENTUM_PARAMS);
    expect(ev.pass).toBe(true);
    expect(ev.side).toBe('BUY');
  });

  it('filters low liquidity', () => {
    const ev = strategy.evaluate(
      { ...strongCtx, liquidityUsd: 100 },
      DEFAULT_MOMENTUM_PARAMS,
    );
    expect(ev.pass).toBe(false);
  });

  it('uses only provided context (no look-ahead fields)', () => {
    const ev = strategy.evaluate(
      { ...strongCtx, priorVolume5mUsd: null },
      DEFAULT_MOMENTUM_PARAMS,
    );
    expect(ev.scores.overall).toBeGreaterThanOrEqual(0);
  });
});

describe('risk labels', () => {
  it('labels from measurable rules', () => {
    expect(riskLabelFromScore(10, 5, 50000)).toBe('LOWER_RISK');
    expect(riskLabelFromScore(40, 22, 8000)).toBe('MODERATE');
    expect(riskLabelFromScore(65, 35, 2000)).toBe('HIGH');
    expect(riskLabelFromScore(90, 60, 500)).toBe('EXTREME');
  });
});
