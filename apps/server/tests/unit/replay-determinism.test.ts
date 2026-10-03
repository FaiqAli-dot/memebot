import { describe, expect, it } from 'vitest';
import { runDeterministicReplay, type ReplayMarketEvent } from '../../src/replay/engine.js';
import { SeededRng } from '../../src/domain/seeded-rng.js';

describe('deterministic replay', () => {
  const events: ReplayMarketEvent[] = [
    {
      type: 'snapshot',
      tokenId: 'tok-a',
      observedAt: new Date('2026-01-01T00:00:00Z'),
      payload: {
        address: 'AddrA',
        symbol: 'AAA',
        priceUsd: 0.001,
        liquidityUsd: 20_000,
        volume5mUsd: 5_000,
        volume1hUsd: 15_000,
        buyVolume5mUsd: 3_500,
        sellVolume5mUsd: 1_500,
        txCount5m: 40,
        priceChange5mPct: 8,
        priceChange1hPct: 12,
        ageMinutes: 20,
        priorVolume5mUsd: 2_000,
        mintAuthorityActive: false,
        freezeAuthorityActive: false,
        lpLockedOrBurned: true,
        sellable: true,
        topHolderPct: 12,
        memecoinActivityScore: 60,
      },
    },
    {
      type: 'snapshot',
      tokenId: 'tok-b',
      observedAt: new Date('2026-01-01T00:01:00Z'),
      payload: {
        address: 'AddrB',
        symbol: 'BBB',
        priceUsd: 0.002,
        liquidityUsd: 8_000,
        volume5mUsd: 3_000,
        volume1hUsd: 8_000,
        buyVolume5mUsd: 2_000,
        sellVolume5mUsd: 1_000,
        txCount5m: 25,
        priceChange5mPct: 4,
        priceChange1hPct: 6,
        ageMinutes: 15,
        priorVolume5mUsd: 1_500,
        mintAuthorityActive: false,
        freezeAuthorityActive: false,
        lpLockedOrBurned: true,
        sellable: true,
        topHolderPct: 18,
        memecoinActivityScore: 55,
      },
    },
  ];

  it('same seed + data → same result', () => {
    const a = runDeterministicReplay(events, {
      seed: 42,
      minExpectedNetValue: 0.01,
      startingCashUsd: 100,
    });
    const b = runDeterministicReplay(events, {
      seed: 42,
      minExpectedNetValue: 0.01,
      startingCashUsd: 100,
    });
    expect(a).toEqual(b);
  });

  it('different seeds can diverge on RNG-coupled paths', () => {
    const rng1 = new SeededRng(1);
    const rng2 = new SeededRng(2);
    const seq1 = Array.from({ length: 20 }, () => rng1.next());
    const seq2 = Array.from({ length: 20 }, () => rng2.next());
    expect(seq1).not.toEqual(seq2);
  });
});
