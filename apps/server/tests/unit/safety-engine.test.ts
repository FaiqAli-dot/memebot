import { describe, expect, it } from 'vitest';
import { assessSafety, demoSafetyFromSymbol } from '../../src/safety/engine.js';

describe('safety engine', () => {
  it('blocks mint authority and marks BLOCKED', () => {
    const r = assessSafety({
      tokenId: 't1',
      mintAuthorityActive: true,
      freezeAuthorityActive: false,
      isToken2022: false,
      transferRestricted: false,
      liquidityUsd: 20_000,
      liquidityChangePct5m: 0,
      lpLockedOrBurned: true,
      top1HolderPct: 10,
      top5HolderPct: 20,
      top10HolderPct: 30,
      top20HolderPct: 40,
      creatorHoldingPct: 5,
      creatorPriorRugs: 0,
      creatorPriorLaunches: 1,
      sniperConcentrationPct: 10,
      bundledLaunchSuspected: false,
      artificialVolumeSuspected: false,
      sellable: true,
      buyButNotSell: false,
    });
    expect(r.blocked).toBe(true);
    expect(r.safetyClass).toBe('BLOCKED');
    expect(r.reasons).toContain('mint_authority_active');
  });

  it('marks honeypot as catastrophic block', () => {
    const r = assessSafety({
      ...demoSafetyFromSymbol('SAFE', 10_000, 10),
      sellable: false,
      buyButNotSell: true,
    });
    expect(r.blocked).toBe(true);
    expect(r.score).toBe(0);
    expect(r.reasons).toContain('unsellable_or_honeypot');
  });

  it('UNKNOWN never becomes LOWER_RISK when many fields missing', () => {
    const r = assessSafety({
      tokenId: 't2',
      mintAuthorityActive: null,
      freezeAuthorityActive: null,
      isToken2022: null,
      transferRestricted: null,
      liquidityUsd: 50_000,
      liquidityChangePct5m: null,
      lpLockedOrBurned: null,
      top1HolderPct: null,
      top5HolderPct: null,
      top10HolderPct: null,
      top20HolderPct: null,
      creatorHoldingPct: null,
      creatorPriorRugs: null,
      creatorPriorLaunches: null,
      sniperConcentrationPct: null,
      bundledLaunchSuspected: null,
      artificialVolumeSuspected: null,
      sellable: null,
      buyButNotSell: null,
    });
    expect(r.safetyClass).not.toBe('LOWER_RISK');
    expect(['UNKNOWN', 'MEDIUM_RISK', 'HIGH_RISK', 'EXTREME_RISK']).toContain(r.safetyClass);
  });

  it('demo RUG? token is blocked', () => {
    const r = assessSafety(demoSafetyFromSymbol('RUG?', 500, 45));
    expect(r.blocked).toBe(true);
  });
});
