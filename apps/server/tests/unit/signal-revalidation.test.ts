import { describe, expect, it } from 'vitest';
import { createStrategyCatalog } from '../../src/strategies/catalog.js';
import { revalidateSignalStrategy, revalidationFeatures } from '../../src/services/signal-revalidation.js';
import type { StrategyContext } from '../../src/strategies/types.js';

const EVE = 'early-volume-expansion';
const catalog = createStrategyCatalog();

/** A token that early-volume-expansion accepts (liquidity, volume, acceleration, phase, age). */
function healthy(over: Partial<StrategyContext> = {}): StrategyContext {
  return {
    tokenId: 't1',
    address: 'Mint1111111111111111111111111111111111111111',
    symbol: 'GOOD',
    chain: 'solana',
    ageMinutes: 8,
    priceUsd: 0.000049,
    liquidityUsd: 18_338,
    volume5mUsd: 20_750,
    volume1hUsd: 46_000,
    buyVolume5mUsd: 14_000,
    sellVolume5mUsd: 6_750,
    txCount5m: 1030,
    priceChange5mPct: -2.96,
    priceChange1hPct: 40,
    holderCount: null,
    topHolderPct: null,
    observedAt: new Date('2026-10-04T19:27:14Z'),
    priorVolume5mUsd: null,
    phase: 'DISCOVERY',
    liquidityStatus: 'KNOWN',
    volumeAccel: {
      raw: 1.86,
      capped: 1.86,
      baselineUsd: 11_150,
      method: 'previous_completed_5m',
      confidence: 'MEDIUM',
      reasons: [],
    } as unknown as StrategyContext['volumeAccel'],
    ...over,
  };
}

/** Cockroach at fill time: liquidity $2,372, 5m volume $78 after a 95% crash. */
const cockroachAtFill = healthy({
  priceUsd: 0.000002369,
  liquidityUsd: 2371.72,
  volume5mUsd: 77.9,
  buyVolume5mUsd: 23.37,
  sellVolume5mUsd: 54.53,
  txCount5m: 10,
  priceChange5mPct: -0.17,
  priceChange1hPct: -95.31,
  observedAt: new Date('2026-10-04T19:34:45Z'),
});

describe('execution-time strategy revalidation', () => {
  it('passes when the stored signal strategy still produces a BUY on current data', () => {
    const r = revalidateSignalStrategy({ strategyId: EVE, catalog, params: {}, ctx: healthy() });
    expect(r.passed).toBe(true);
    expect(r.reason).toBeNull();
    expect(r.signal?.action).toBe('BUY');
  });

  it('fails the Cockroach fill-time state on the strategy own liquidity floor', () => {
    const r = revalidateSignalStrategy({ strategyId: EVE, catalog, params: {}, ctx: cockroachAtFill });
    expect(r.passed).toBe(false);
    expect(r.reason).toBe('liquidity_below_min');
    expect(r.sharedRejection).toBe('LIQUIDITY_REJECTION');
  });

  it('fails on the strategy volume floor when liquidity is still fine', () => {
    const r = revalidateSignalStrategy({
      strategyId: EVE,
      catalog,
      params: {},
      ctx: healthy({ volume5mUsd: 78 }),
    });
    expect(r.passed).toBe(false);
    expect(r.reason).toBe('volume_low');
  });

  it('fails when volume acceleration no longer satisfies the strategy', () => {
    const accel = { ...healthy().volumeAccel!, raw: 1.1, capped: 1.1 };
    const r = revalidateSignalStrategy({ strategyId: EVE, catalog, params: {}, ctx: healthy({ volumeAccel: accel }) });
    expect(r.passed).toBe(false);
    expect(r.reason).toBe('accel_insufficient');
  });

  it('uses the current strategy parameters, not hard-coded ones', () => {
    const r = revalidateSignalStrategy({
      strategyId: EVE,
      catalog,
      params: { [EVE]: { minVolume5mUsd: 50_000 } },
      ctx: healthy(),
    });
    expect(r.passed).toBe(false);
    expect(r.reason).toBe('volume_low');
  });

  it('judges only the signal own strategy', () => {
    const r = revalidateSignalStrategy({ strategyId: EVE, catalog, params: {}, ctx: healthy() });
    expect(r.signal?.strategyId).toBe(EVE);
  });

  it('a strategy that is inactive or unknown cannot pass', () => {
    const inactive = revalidateSignalStrategy({
      strategyId: EVE,
      catalog,
      activeIds: ['momentum-breakout'],
      params: {},
      ctx: healthy(),
    });
    expect(inactive).toMatchObject({ passed: false, reason: 'strategy_inactive' });
    const unknown = revalidateSignalStrategy({ strategyId: 'nope', catalog, params: {}, ctx: healthy() });
    expect(unknown).toMatchObject({ passed: false, reason: 'strategy_unknown' });
    const missing = revalidateSignalStrategy({ strategyId: null, catalog, params: {}, ctx: healthy() });
    expect(missing.passed).toBe(false);
  });

  it('records the execution-time features it judged', () => {
    const f = revalidationFeatures(cockroachAtFill);
    expect(f.liquidityUsd).toBe(2371.72);
    expect(f.volume5mUsd).toBe(77.9);
    expect(f.priceChange1hPct).toBe(-95.31);
  });
});
