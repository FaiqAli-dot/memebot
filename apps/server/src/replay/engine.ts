/**
 * Deterministic replay: historical events in → exact simulated bot behavior out.
 * Same data + config + seed → same result.
 */
import { SeededRng } from '../domain/seeded-rng.js';
import { TimeGuardedAccessor, type Timestamped } from './time-guard.js';
import { assessSafety, type SafetyInput } from '../safety/engine.js';
import { detectRegime, type RegimeInput } from '../features/regime.js';
import { detectTokenPhase, type LifecycleInput } from '../features/lifecycle.js';
import {
  activeStrategies,
  createStrategyCatalog,
  evaluateAllStrategies,
} from '../strategies/catalog.js';
import type { StrategyContext } from '../strategies/types.js';
import { estimateExpectedValue } from '../risk/expected-value.js';
import { estimateRoundTripCost } from '../execution/cost-estimate.js';
import {
  resolveStrategyParams,
  type ConfidenceLevel,
  type LiquidityStatus,
  type MarketRegime,
  type StrategyParamsById,
  type TokenPhase,
} from '@memebot/shared';

export interface ReplayMarketEvent extends Timestamped {
  type: 'trade' | 'snapshot' | 'safety' | 'discovery';
  tokenId: string;
  payload: Record<string, unknown>;
}

export interface ReplayConfig {
  seed: number;
  minExpectedNetValue: number;
  activeStrategyIds?: string[];
  /** Per-strategy thresholds (as in portfolio settings); defaults when omitted */
  strategyParams?: StrategyParamsById;
  startingCashUsd: number;
  lowConfidenceMultiplier?: number;
  /** Network base + priority + tip per transaction in USD (replay has no live SOL price) */
  networkFeePerLegUsd?: number;
}

/** ~15k lamports per tx at ~$150 SOL; override per replay run when known. */
const DEFAULT_REPLAY_NETWORK_FEE_PER_LEG_USD = 0.0025;

export interface ReplayTrade {
  tokenId: string;
  strategyId: string;
  action: 'BUY' | 'NO_TRADE';
  decisionAt: string;
  confidence: number;
  expectedNetValue: number | null;
  reasons: string[];
}

export interface ReplayResult {
  seed: number;
  trades: ReplayTrade[];
  signals: number;
  buys: number;
  rejections: number;
  regimes: Array<{ at: string; regime: MarketRegime }>;
  phases: Array<{ tokenId: string; at: string; phase: TokenPhase }>;
  finalCashUsd: number;
}

export function runDeterministicReplay(
  events: ReplayMarketEvent[],
  config: ReplayConfig,
): ReplayResult {
  const rng = new SeededRng(config.seed);
  const accessor = new TimeGuardedAccessor(events, new Date(0));
  const catalog = activeStrategies(createStrategyCatalog(), config.activeStrategyIds);
  const strategyParams = resolveStrategyParams(config.strategyParams);
  const trades: ReplayTrade[] = [];
  const regimes: ReplayResult['regimes'] = [];
  const phases: ReplayResult['phases'] = [];
  let signals = 0;
  let buys = 0;
  let rejections = 0;
  let cash = config.startingCashUsd;

  // Process in chronological order; advance asOf per event
  const sorted = [...events].sort(
    (a, b) => a.observedAt.getTime() - b.observedAt.getTime(),
  );

  const lastSnap = new Map<string, Record<string, unknown>>();

  for (const ev of sorted) {
    // Advance time guard
    const guard = new TimeGuardedAccessor(sorted, ev.observedAt);
    guard.requireAtOrBefore(ev.observedAt);
    const available = guard.getAvailable();
    void available;
    void rng.next(); // consume for determinism coupling

    if (ev.type === 'snapshot') {
      lastSnap.set(ev.tokenId, ev.payload);

      const p = ev.payload;
      const safetyIn: SafetyInput = {
        tokenId: ev.tokenId,
        mintAuthorityActive: (p.mintAuthorityActive as boolean | null) ?? null,
        freezeAuthorityActive: (p.freezeAuthorityActive as boolean | null) ?? null,
        isToken2022: (p.isToken2022 as boolean | null) ?? null,
        transferRestricted: (p.transferRestricted as boolean | null) ?? null,
        liquidityUsd: Number(p.liquidityUsd ?? 0),
        liquidityChangePct5m: (p.liquidityChangePct5m as number | null) ?? null,
        lpLockedOrBurned: (p.lpLockedOrBurned as boolean | null) ?? null,
        top1HolderPct: (p.topHolderPct as number | null) ?? null,
        top5HolderPct: null,
        top10HolderPct: (p.top10HolderPct as number | null) ?? null,
        top20HolderPct: null,
        creatorHoldingPct: null,
        creatorPriorRugs: null,
        creatorPriorLaunches: null,
        sniperConcentrationPct: null,
        bundledLaunchSuspected: null,
        artificialVolumeSuspected: null,
        sellable: (p.sellable as boolean | null) ?? null,
        buyButNotSell: null,
        observedAt: ev.observedAt,
      };
      const safety = assessSafety(safetyIn);

      const lifeIn: LifecycleInput = {
        ageMinutes: (p.ageMinutes as number | null) ?? null,
        priceChange2mPct: (p.priceChange5mPct as number | null) ?? null,
        priceChange5mPct: Number(p.priceChange5mPct ?? 0),
        priceChange1hPct: Number(p.priceChange1hPct ?? 0),
        volumeAcceleration: (p.volumeAcceleration as number | null) ?? null,
        liquidityUsd: Number(p.liquidityUsd ?? 0),
        liquidityChangePct: null,
        uniqueBuyers5m: null,
        uniqueSellers5m: null,
        netFlow5mUsd: Number(p.buyVolume5mUsd ?? 0) - Number(p.sellVolume5mUsd ?? 0),
        holderGrowthPct: null,
        largeWalletSellPct: null,
        volatility5mPct: Math.abs(Number(p.priceChange5mPct ?? 0)),
      };
      const phase = detectTokenPhase(lifeIn);
      phases.push({
        tokenId: ev.tokenId,
        at: ev.observedAt.toISOString(),
        phase: phase.phase,
      });

      const regimeIn: RegimeInput = {
        solMomentumPct: (p.solMomentumPct as number | null) ?? null,
        solVolatilityPct: null,
        memecoinActivityScore: (p.memecoinActivityScore as number | null) ?? 50,
        newTokenCount1h: null,
        activeTokenCount: null,
        avgLiquidityUsd: Number(p.liquidityUsd ?? 0),
        marketBuySellPressure:
          Number(p.sellVolume5mUsd ?? 1) > 0
            ? Number(p.buyVolume5mUsd ?? 0) / Number(p.sellVolume5mUsd ?? 1)
            : null,
        launchSuccessRate: null,
        rugFailureRate: null,
        observedAt: ev.observedAt,
      };
      const regime = detectRegime(regimeIn);
      regimes.push({ at: ev.observedAt.toISOString(), regime: regime.regime });

      const ctx: StrategyContext = {
        tokenId: ev.tokenId,
        address: String(p.address ?? ''),
        symbol: String(p.symbol ?? ''),
        chain: 'solana',
        ageMinutes: (p.ageMinutes as number | null) ?? null,
        priceUsd: Number(p.priceUsd ?? 0),
        liquidityUsd: Number(p.liquidityUsd ?? 0),
        volume5mUsd: Number(p.volume5mUsd ?? 0),
        volume1hUsd: Number(p.volume1hUsd ?? 0),
        buyVolume5mUsd: Number(p.buyVolume5mUsd ?? 0),
        sellVolume5mUsd: Number(p.sellVolume5mUsd ?? 0),
        txCount5m: Number(p.txCount5m ?? 0),
        priceChange5mPct: Number(p.priceChange5mPct ?? 0),
        priceChange1hPct: Number(p.priceChange1hPct ?? 0),
        holderCount: (p.holderCount as number | null) ?? null,
        topHolderPct: (p.topHolderPct as number | null) ?? null,
        observedAt: ev.observedAt,
        priorVolume5mUsd: (p.priorVolume5mUsd as number | null) ?? null,
        safety,
        regime: regime.regime,
        phase: phase.phase,
        // Recorded measured confidence when present; otherwise insufficient evidence
        buySellConfidence: (p.buySellConfidence as ConfidenceLevel | undefined) ?? 'LOW',
        liquidityStatus: p.liquidityStatus as LiquidityStatus | undefined,
      };

      const { best, all } = evaluateAllStrategies(catalog, ctx, strategyParams);
      signals += all.filter((s) => s.action === 'BUY').length;

      if (best) {
        const sizeUsd = Math.min(cash * 0.05, 5);
        const cost = estimateRoundTripCost({
          positionSizeUsd: sizeUsd,
          liquidityUsd: ctx.liquidityUsd,
          venue: (p.venue as string | undefined) ?? null,
          absPriceChange5mPct: Math.abs(ctx.priceChange5mPct),
          networkFeePerLegUsd: config.networkFeePerLegUsd ?? DEFAULT_REPLAY_NETWORK_FEE_PER_LEG_USD,
        });
        const evEst = estimateExpectedValue({
          signal: best,
          cost,
          failureProbability: 0.08,
          minExpectedNetValue: config.minExpectedNetValue,
          dataConfidence: (p.dataConfidence as ConfidenceLevel | undefined) ?? 'LOW',
          lowConfidenceMultiplier: config.lowConfidenceMultiplier ?? 1.2,
        });
        if (evEst.passes) {
          buys++;
          cash -= sizeUsd + cost.totalCostUsd;
          trades.push({
            tokenId: ev.tokenId,
            strategyId: best.strategyId,
            action: 'BUY',
            decisionAt: ev.observedAt.toISOString(),
            confidence: best.confidence,
            expectedNetValue: evEst.expectedNetValue,
            reasons: best.reasons,
          });
        } else {
          rejections++;
          trades.push({
            tokenId: ev.tokenId,
            strategyId: best.strategyId,
            action: 'NO_TRADE',
            decisionAt: ev.observedAt.toISOString(),
            confidence: best.confidence,
            expectedNetValue: evEst.expectedNetValue,
            reasons: evEst.reasons,
          });
        }
      } else {
        rejections++;
      }
    }
  }

  // Touch accessor for API completeness in tests
  void accessor;

  return {
    seed: config.seed,
    trades,
    signals,
    buys,
    rejections,
    regimes,
    phases,
    finalCashUsd: cash,
  };
}
