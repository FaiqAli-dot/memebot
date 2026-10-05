import {
  createProviders,
  getStalePriceMaxAgeMs,
  isGasUsableForTrading,
} from '../providers/index.js';
import { createDiscoveryProviders } from '../providers/discovery/multi-source.js';
import { dataMode, env, realismProfile } from '../config/env.js';
import { logger } from '../utils/logger.js';
import {
  upsertDiscoveredToken,
  insertMarketSnapshot,
  insertHolderSnapshot,
  getLatestMarketByToken,
  getLatestHolders,
  getSnapshotHistory,
  logBotEvent,
  quoteLiquidityStatus,
  tokenAgeOf,
  type SnapshotHistoryRow,
} from '../services/token-service.js';
import {
  ensureDefaultPortfolio,
  ensureResearchPortfolio,
  ensureOlderTokenResearchPortfolio,
  getPortfolio,
  getPortfolioSettings,
  setRiskState,
} from '../services/portfolio-service.js';
import { evaluateRisk, computeDrawdownPct } from '../engines/risk/engine.js';
import {
  executePaperBuy,
  executePaperSell,
  markPositionMarkToMarket,
} from '../engines/paper/engine.js';
import { evaluateExitRules } from '../engines/paper/exits.js';
import { query } from '../db/client.js';
import { pruneOldData } from '../db/retention.js';
import { publish } from '../ws/hub.js';
import { runDailyReportIfDue } from '../services/report-service.js';
import { buildEntrySnapshot, recordMissingObservations, recordTradeObservation } from '../learning/observations.js';
import { runHealthCheckIfDue } from '../learning/health-service.js';
import { getActiveEvCalibrations } from '../learning/calibration-service.js';
import { registerJob, defaultIntervals, startJobs, stopJobs } from './scheduler.js';
import type { GasFeeEstimate, MarketQuote } from '../providers/types.js';
import {
  assessSafety,
  demoSafetyFromSymbol,
  SAFETY_VERSION,
  type SafetyResult,
} from '../safety/engine.js';
import {
  approximateTradesFromSnapshot,
  computeFlowFeatures,
} from '../features/flow.js';
import { detectRegime, regimeSizeMultiplier } from '../features/regime.js';
import { detectTokenPhase } from '../features/lifecycle.js';
import {
  computeMarketMetrics,
  previousCompletedWindow,
  type MetricSnapshot,
} from '../features/market-metrics.js';
import { assessBuySellConfidence, assessDataConfidence } from '../features/data-confidence.js';
import {
  activeStrategies,
  createStrategyCatalog,
  evaluateAllStrategies,
  researchOnlyStrategies,
} from '../strategies/catalog.js';
import { historyCoverageMinutes, olderLaneRejection } from '../research/older-token-lane.js';
import type { Signal, StrategyContext } from '../strategies/types.js';
import { estimateExpectedValue } from '../risk/expected-value.js';
import {
  assessPositionRisk,
  referenceSizeUsd,
  type RiskAssessment,
  type RiskConfig,
} from '../risk/position-risk.js';
import { markRiskExecution, recordRiskDecision } from '../services/risk-decision-service.js';
import {
  beginExecutionAttempt,
  recordRevalidation,
  revalidateSignalStrategy,
  revalidationFeatures,
  updateExecutionAttempt,
  type StrategyRevalidation,
} from '../services/signal-revalidation.js';
import { estimateRoundTripCost, networkFeePerLegUsd } from '../execution/cost-estimate.js';
import {
  getRealismKnobs,
  simulateRealisticTrade,
  EXECUTION_MODEL_VERSION,
} from '../execution/realism.js';
import { SeededRng } from '../domain/seeded-rng.js';
import {
  openShadowTrade,
  updateOpenShadowTrades,
  recordMissedOpportunity,
  type ExecutionSettings,
} from '../research/shadow.js';
import type { ExitParams } from '../research/exit-sim.js';
import { recordOpportunity, processOpportunityOutcomes } from '../research/opportunities.js';
import { classifyStrategyRejection, FunnelRecorder, pruneFunnelSnapshots } from '../research/funnel.js';
import {
  auditEligibility,
  auditFinalOutcome,
  auditRiskDecision,
  auditSignalPass,
  auditSignalRejection,
  auditStrategyRevalidation,
  buildFeatureSnapshot,
  onMarketTracked,
  onTokenDiscovered,
  persistRawFeatureObservation,
} from '../intelligence/hooks.js';
import { captureDueOutcomeCheckpoints } from '../intelligence/outcomes.js';
import { ensureSourceHealthRows } from '../intelligence/source-health.js';
import { snapshotStorageMonitor } from '../intelligence/storage.js';
import { refreshStorageState, researchWritesAllowed, stateRank } from '../db/storage-guard.js';
import { WriteDedupe } from '../db/write-dedupe.js';
import { AUTO_COMPACT_TABLES, compactTables } from '../db/compact.js';

/** token_phases: one row per phase change (or per dedupe window), not per signal tick. */
const phaseWrites = new WriteDedupe();
import {
  classifyTradingEligibility,
  computeActivityScore,
  hasBasicTradingData,
  selectForEvaluation,
  selectForPolling,
} from '../universe/lifecycle.js';
import {
  applyQuoteToToken,
  getExposureTokenIds,
  getTrackedToken,
  getUniverseCounts,
  listEvaluationCandidates,
  listTopActiveTokens,
  listTrackedTokens,
  markEvaluated,
  markPolledWithoutQuote,
  runLifecycleTick,
  type TrackedTokenRow,
} from '../universe/repository.js';
import {
  isKillSwitchActive,
  evaluateCircuitBreakers,
} from '../monitoring/kill-switch.js';
import { sendAlert } from '../monitoring/alerts.js';
import { toMeasuredJson } from '../domain/measured.js';
import type {
  ConfidenceLevel,
  MarketRegime,
  PortfolioSettings,
  RejectionReason,
  SignalLane,
} from '@memebot/shared';
import { OLDER_TOKEN_RESEARCH_PORTFOLIO_ID, resolveStrategyParams } from '@memebot/shared';

const providers = createProviders();
const discovery = createDiscoveryProviders(dataMode);
const strategyCatalog = createStrategyCatalog();
const rng = new SeededRng(env.REPLAY_SEED);

let lastScanAt: Date | null = null;
let tokensScanned = 0;
let signalsGenerated = 0;
let latestRegime: MarketRegime | null = null;

let missingQuotesSinceLog = 0;
let missingQuoteSample: string[] = [];
let lastMissingLogAt = 0;

const ACTIVE_WINDOW_SEC = 120;

export function getRuntimeBotStats() {
  return { lastScanAt, tokensScanned, signalsGenerated, latestRegime };
}

type MarketRow = NonNullable<Awaited<ReturnType<typeof getLatestMarketByToken>>>;

function quoteFromMarket(market: MarketRow, midPriceUsd = market.price_usd): MarketQuote {
  return {
    chain: 'solana',
    address: '',
    priceUsd: midPriceUsd,
    marketCapUsd: market.market_cap_usd,
    volume5mUsd: market.volume_5m_usd,
    volume1hUsd: market.volume_1h_usd,
    volume24hUsd: market.volume_24h_usd,
    buyVolume5mUsd: market.buy_volume_5m_usd,
    sellVolume5mUsd: market.sell_volume_5m_usd,
    txCount5m: market.tx_count_5m,
    priceChange5mPct: market.price_change_5m_pct,
    priceChange1hPct: market.price_change_1h_pct,
    liquidityUsd: market.liquidity_usd,
    liquidityStatus: market.liquidity_status,
    observedAt: market.observed_at,
    poolAddress: market.pool_address,
    venue: market.venue,
    feeBps: market.fee_bps,
    baseReserve: market.base_reserve,
    quoteReserve: market.quote_reserve,
  };
}

function toMetricSnapshot(s: SnapshotHistoryRow): MetricSnapshot {
  return {
    observedAt: s.observed_at,
    volume5mUsd: s.volume_5m_usd,
    volume1hUsd: s.volume_1h_usd,
    volume24hUsd: s.volume_24h_usd,
    txCount5m: s.tx_count_5m,
    buys5m: s.buys_5m,
    sells5m: s.sells_5m,
    buys24h: s.buys_24h,
    sells24h: s.sells_24h,
  };
}

function exitParamsFrom(settings: PortfolioSettings): ExitParams {
  return {
    stopLossPct: settings.stopLossPct,
    takeProfitPct: settings.takeProfitPct,
    trailingStopPct: settings.trailingStopPct,
    maxHoldSec: settings.maxHoldingTimeSec,
    minLiquidityUsd: settings.minLiquidityUsd,
  };
}

/** Risk limits derived from the existing portfolio settings + bankroll (no parallel config). */
function riskConfigFrom(settings: PortfolioSettings, equityUsd: number): RiskConfig {
  return {
    baseSizeUsd: equityUsd * settings.maxPositionPct,
    minSizeUsd: env.PAPER_MIN_POSITION_USD,
    maxRiskPerTradeUsd: equityUsd * settings.maxRiskPerTradePct,
    maxOpenPositions: settings.maxSimultaneousPositions,
    maxPortfolioExposureUsd: equityUsd * env.MAX_PORTFOLIO_EXPOSURE_PCT,
    maxStrategyExposureUsd: equityUsd * env.MAX_STRATEGY_EXPOSURE_PCT,
    maxTokenExposureUsd: equityUsd * env.MAX_TOKEN_EXPOSURE_PCT,
    confidenceMultipliers: {
      HIGH: env.RISK_SIZE_HIGH_MULTIPLIER,
      MEDIUM: env.RISK_SIZE_MEDIUM_MULTIPLIER,
      LOW: env.RISK_SIZE_LOW_MULTIPLIER,
    },
    strongEvMargin: env.RISK_STRONG_EV_MARGIN,
    strongEvMultiplier: env.RISK_SIZE_STRONG_EV_MULTIPLIER,
    researchMultiplier: env.RISK_SIZE_RESEARCH_MULTIPLIER,
    volHighPct: env.RISK_VOL_HIGH_PCT,
    volVeryHighPct: env.RISK_VOL_VERY_HIGH_PCT,
    volExtremePct: env.RISK_VOL_EXTREME_PCT,
    highVolMultiplier: env.RISK_SIZE_HIGH_VOL_MULTIPLIER,
    veryHighVolMultiplier: env.RISK_SIZE_VERY_HIGH_VOL_MULTIPLIER,
    maxEntryPriceImpactPct: env.MAX_ENTRY_PRICE_IMPACT_PCT,
    maxRoundTripCostRate: env.MAX_ROUND_TRIP_COST_RATE,
  };
}

function execSettingsFrom(settings: PortfolioSettings): ExecutionSettings {
  return {
    profile: settings.realismProfile ?? realismProfile,
    priorityFeeLamports: settings.priorityFeeLamports,
    jitoTipLamports: settings.jitoTipLamports ?? env.DEFAULT_JITO_TIP_LAMPORTS,
    failedTxStillChargesNetwork: settings.failedTxStillChargesNetwork,
  };
}

async function jobTokenDiscovery(): Promise<void> {
  const portfolioId = await ensureDefaultPortfolio();
  await ensureSourceHealthRows().catch(() => undefined);
  await discovery.subscribe();
  const discovered = await discovery.getRecentTokens();
  for (const token of discovered) {
    const existing = await query(
      `SELECT id FROM tokens WHERE chain = $1 AND address = $2 AND data_mode = $3`,
      [token.chain, token.address, dataMode],
    );
    const id = await upsertDiscoveredToken(token);
    const isNew = Boolean(id && existing.rows.length === 0);
    await onTokenDiscovered(token, id, isNew).catch((err) =>
      logger.warn({ err, address: token.address }, 'Token intelligence ledger write failed'),
    );
    if (id && isNew) {
      await query(
        `INSERT INTO market_events (token_id, event_type, payload, observed_at, source, data_mode)
         VALUES ($1,'TOKEN_DISCOVERED',$2,NOW(),$3,$4)`,
        [
          id,
          JSON.stringify({
            discoverySource: token.discoverySource,
            allDiscoverySources: token.allDiscoverySources ?? [token.discoverySource],
            venue: token.dexVenue ?? null,
            symbol: token.symbol,
            paidBoost: token.discoverySource === 'DEXSCREENER_BOOST',
            dbcStatus: token.metadata?.dbcStatus ?? null,
            migrationStatus: token.metadata?.migrationStatus ?? null,
          }),
          token.discoverySource,
          dataMode,
        ],
      );
      await logBotEvent({
        portfolioId,
        level: 'info',
        category: 'discovery',
        message: `Discovered ${token.symbol} via ${token.discoverySource}`,
        details: {
          address: token.address,
          discoverySource: token.discoverySource,
          venue: token.dexVenue ?? null,
          paidBoost: token.discoverySource === 'DEXSCREENER_BOOST',
        },
      });
      publish('token_discovered', {
        tokenId: id,
        symbol: token.symbol,
        address: token.address,
        discoverySource: token.discoverySource,
        venue: token.dexVenue ?? null,
      });
    }
  }
  lastScanAt = new Date();
}

/**
 * Market data over the tracked universe (not the newest-N window): exposures are
 * always polled, then new discoveries, then by activity and least-recently-polled.
 */
async function jobMarketData(): Promise<void> {
  const exposures = await getExposureTokenIds();
  const tracked = await listTrackedTokens(exposures);
  if (tracked.length === 0) return;
  const selected = selectForPolling(
    tracked.map((t) => ({
      ...t,
      mustInclude: exposures.has(t.id),
      activityScore: Number(t.activity_score),
      lastPolledAt: t.last_polled_at,
    })),
    env.MARKET_DATA_CAP_PER_TICK,
  );
  const tokens = selected.map((s) => s.item);
  const quotes = await providers.marketData.getMarketQuotes(tokens.map((t) => t.address));
  const byAddr = new Map(quotes.map((q) => [q.address, q]));
  tokensScanned = tokens.length;

  const missing: TrackedTokenRow[] = [];
  let failed = 0;
  for (const token of tokens) {
    const quote = byAddr.get(token.address);
    if (!quote) {
      missing.push(token);
      continue;
    }
    try {
      await ingestQuote(token, quote);
    } catch (err) {
      failed++;
      logger.warn({ err, token: token.symbol }, 'Market snapshot ingest failed');
    }
  }
  if (failed > 0) logger.warn({ failed, polled: tokens.length }, 'Some market snapshots failed this tick');

  await markPolledWithoutQuote(missing.map((t) => t.id));
  // Profile-only tokens (no pair yet) are normal; aggregate instead of one event per token
  missingQuotesSinceLog += missing.length;
  missingQuoteSample = [...missingQuoteSample, ...missing.map((t) => t.symbol)].slice(-10);
  if (missingQuotesSinceLog > 0 && Date.now() - lastMissingLogAt > 60_000) {
    await logBotEvent({
      level: 'info',
      category: 'market_data',
      message: `No market pair yet for ${missingQuotesSinceLog} polled token(s) in the last minute`,
      details: { sample: missingQuoteSample, polledThisTick: tokens.length },
    });
    missingQuotesSinceLog = 0;
    missingQuoteSample = [];
    lastMissingLogAt = Date.now();
  }
  publish('scanner_updated', { count: quotes.length, polled: tokens.length });
}

async function ingestQuote(token: TrackedTokenRow, quote: MarketQuote): Promise<void> {
  const ageMs = Date.now() - quote.observedAt.getTime();
  const stale = ageMs > getStalePriceMaxAgeMs();
  await insertMarketSnapshot(token.id, quote, stale);

  const liquidityStatus = quoteLiquidityStatus(quote);
  const { eligibility, reasons } = classifyTradingEligibility(liquidityStatus);
  const basicDataOk = hasBasicTradingData({
    priceUsd: quote.priceUsd,
    liquidityStatus,
    liquidityUsd: quote.liquidityUsd,
    volume5mUsd: quote.volume5mUsd,
    volume1hUsd: quote.volume1hUsd,
  });
  await applyQuoteToToken({
    tokenId: token.id,
    observedAt: quote.observedAt,
    liquidityStatus,
    eligibility,
    eligibilityReasons: reasons,
    activityScore: computeActivityScore({
      liquidityUsd: liquidityStatus === 'KNOWN' ? quote.liquidityUsd : null,
      volume5mUsd: quote.volume5mUsd,
      txCount5m: quote.txCount5m,
      priceChange5mPct: quote.priceChange5mPct,
      volumeAccelCapped: null,
      dataAgeSec: ageMs / 1000,
    }),
    basicDataOk,
    poolCreatedAt: quote.pairCreatedAt ?? null,
    venue: quote.venue ?? null,
  });

  const ageMinutes = tokenAgeOf(token).minutes;
  const features = buildFeatureSnapshot({
    liquidityUsd: quote.liquidityUsd,
    volume5mUsd: quote.volume5mUsd,
    volume1hUsd: quote.volume1hUsd,
    volume24hUsd: quote.volume24hUsd,
    marketCapUsd: quote.marketCapUsd,
    ageMinutes,
    priceChange5mPct: quote.priceChange5mPct,
    priceChange1hPct: quote.priceChange1hPct,
    buyVolume5mUsd: quote.buyVolume5mUsd,
    sellVolume5mUsd: quote.sellVolume5mUsd,
    liquidityStatus,
    venue: quote.venue,
    extra: { price: quote.priceUsd },
  });
  await onMarketTracked(
    token.id,
    {
      price_usd: quote.priceUsd,
      market_cap_usd: quote.marketCapUsd,
      liquidity_usd: quote.liquidityUsd,
      volume_24h_usd: quote.volume24hUsd,
      volume_1h_usd: quote.volume1hUsd,
    },
    null,
    ageMinutes,
  ).catch(() => undefined);
  await persistRawFeatureObservation(token.id, features).catch(() => undefined);
  await auditEligibility({
    tokenId: token.id,
    pass: eligibility === 'TRADING_ELIGIBLE' && basicDataOk,
    reasons: basicDataOk ? reasons : [...reasons, 'lowLiquidity'],
    actual: {
      liquidity: quote.liquidityUsd,
      liquidityStatus,
      price: quote.priceUsd,
      volume5m: quote.volume5mUsd,
      volume1h: quote.volume1hUsd,
      ageMinutes,
    },
    required: {
      minLiquidityUsd: 3000,
      liquidityStatus: 'KNOWN',
      eligibility: 'TRADING_ELIGIBLE',
    },
    features,
  }).catch(() => undefined);

  if (liquidityStatus === 'KNOWN') {
    await query(
      `UPDATE tokens SET
        first_liquidity_at = COALESCE(first_liquidity_at, $2),
        first_trade_at = COALESCE(first_trade_at, $2),
        first_meaningful_volume_at = CASE
          WHEN first_meaningful_volume_at IS NULL AND $3::numeric >= 1000 THEN $2
          ELSE first_meaningful_volume_at
        END
       WHERE id = $1
         AND (first_liquidity_at IS NULL OR first_trade_at IS NULL
              OR (first_meaningful_volume_at IS NULL AND $3::numeric >= 1000))`,
      [token.id, quote.observedAt, quote.volume5mUsd],
    );
  }
}

async function jobLifecycle(): Promise<void> {
  const res = await runLifecycleTick({
    maxAgeHours: env.TOKEN_TRACKING_MAX_AGE_HOURS,
    staleAfterSec: env.TOKEN_STALE_AFTER_SEC,
    archiveStaleAfterMin: env.TOKEN_ARCHIVE_STALE_AFTER_MIN,
    activeWindowSec: ACTIVE_WINDOW_SEC,
    trackingCap: env.TOKEN_TRACKING_CAP,
  });
  if (Object.keys(res.transitions).length > 0 || res.archivedByCap > 0) {
    logger.debug({ ...res }, 'Lifecycle transitions');
  }
  if (Math.random() < 0.01) await pruneFunnelSnapshots();
}

/** Event-driven trade stream (demo synthesis + polling reconciliation). */
async function jobTradeStream(): Promise<void> {
  const tokens = await listTopActiveTokens(30, ['ELIGIBLE', 'ACTIVE']);
  for (const token of tokens) {
    const market = await getLatestMarketByToken(token.id);
    if (!market) continue;
    // Low-confidence approximation from snapshots — explicitly labeled
    const ticks = approximateTradesFromSnapshot({
      buyVolume5mUsd: market.buy_volume_5m_usd,
      sellVolume5mUsd: market.sell_volume_5m_usd,
      txCount5m: Math.min(market.tx_count_5m, 40),
      priceUsd: market.price_usd,
      observedAt: market.observed_at,
    });
    if (!researchWritesAllowed()) continue;
    if (env.PERSIST_FEATURE_SNAPSHOTS) {
      const flow = computeFlowFeatures(ticks, new Date());
      await query(
        `INSERT INTO feature_snapshots (token_id, observed_at, window_label, features, data_mode)
         VALUES ($1, NOW(), 'multi', $2, $3)`,
        [
          token.id,
          JSON.stringify({
            flow: Object.fromEntries(
              Object.entries(flow).map(([k, v]) => [
                k,
                {
                  buyVolumeUsd: toMeasuredJson(v.buyVolumeUsd),
                  sellVolumeUsd: toMeasuredJson(v.sellVolumeUsd),
                  netFlowUsd: toMeasuredJson(v.netFlowUsd),
                  buySellRatio: toMeasuredJson(v.buySellRatio),
                  uniqueBuyers: toMeasuredJson(v.uniqueBuyers),
                  uniqueSellers: toMeasuredJson(v.uniqueSellers),
                  whaleFlowPct: toMeasuredJson(v.whaleFlowPct),
                  confidenceNote: 'tx_count_approximation_low_confidence',
                },
              ]),
            ),
          }),
          dataMode,
        ],
      );
    }

    // Persist a sample of approximated trade events for replay (deduped by synthetic sig)
    for (const t of ticks.slice(0, 6)) {
      const sig = `approx:${token.id}:${t.side}:${t.observedAt.toISOString()}:${Math.round(t.amountUsd ?? 0)}`;
      await query(
        `INSERT INTO trade_events (
          token_id, side, amount_usd, price_usd, liquidity_usd, trader_wallet,
          tx_signature, observed_at, source, confidence, data_mode
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'tx_count_approximation','LOW',$9)
        ON CONFLICT (tx_signature, token_id, side) DO NOTHING`,
        [
          token.id,
          t.side,
          t.amountUsd,
          t.priceUsd,
          market.liquidity_usd,
          t.traderWallet,
          sig,
          t.observedAt,
          dataMode,
        ],
      );
    }
  }
}

async function jobOnchain(): Promise<void> {
  const tokens = await listTopActiveTokens(20, ['ELIGIBLE', 'ACTIVE']);
  for (const token of tokens) {
    try {
      const data = await providers.onChain.getHolderData(token.address);
      if (data) await insertHolderSnapshot(token.id, data);
    } catch (err) {
      logger.warn({ err, token: token.symbol }, 'On-chain update failed');
    }
  }
}

function safetyInputFor(
  token: { id: string; symbol: string },
  market: MarketRow,
  holders: Awaited<ReturnType<typeof getLatestHolders>>,
) {
  const input =
    dataMode === 'demo'
      ? demoSafetyFromSymbol(token.symbol, market.liquidity_usd, holders?.top_holder_pct ?? null)
      : {
          tokenId: token.id,
          mintAuthorityActive: null,
          freezeAuthorityActive: null,
          isToken2022: null,
          transferRestricted: null,
          liquidityUsd: market.liquidity_usd,
          liquidityChangePct5m: null,
          lpLockedOrBurned: null,
          top1HolderPct: holders?.top_holder_pct ?? null,
          top5HolderPct: null,
          top10HolderPct: holders?.top10_holder_pct ?? null,
          top20HolderPct: null,
          creatorHoldingPct: null,
          creatorPriorRugs: null,
          creatorPriorLaunches: null,
          sniperConcentrationPct: null,
          bundledLaunchSuspected: null,
          artificialVolumeSuspected: null,
          sellable: null,
          buyButNotSell: null,
          observedAt: market.observed_at,
        };
  input.tokenId = token.id;
  return input;
}

async function jobSafety(): Promise<void> {
  const tokens = await listTopActiveTokens(100, ['ELIGIBLE', 'ACTIVE']);
  for (const token of tokens) {
    const market = await getLatestMarketByToken(token.id);
    if (!market) continue;
    const holders = await getLatestHolders(token.id);
    const result = assessSafety(safetyInputFor(token, market, holders));
    await query(
      `INSERT INTO safety_assessments (
        token_id, score, safety_class, blocked, reasons, checks, version, assessed_at, data_mode
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        token.id,
        result.score,
        result.safetyClass,
        result.blocked,
        JSON.stringify(result.reasons),
        JSON.stringify(
          Object.fromEntries(
            Object.entries(result.checks).map(([k, v]) => [k, toMeasuredJson(v)]),
          ),
        ),
        result.version,
        result.assessedAt,
        dataMode,
      ],
    );
    if (result.blocked) {
      publish('safety_blocked', {
        tokenId: token.id,
        symbol: token.symbol,
        reasons: result.reasons,
        safetyClass: result.safetyClass,
      });
    }
  }
}

async function jobRegime(): Promise<void> {
  const tokens = await listTopActiveTokens(100);
  let totalVol = 0;
  let totalBuy = 0;
  let totalSell = 0;
  let liqSum = 0;
  let liqN = 0;
  let n = 0;
  for (const token of tokens) {
    const m = await getLatestMarketByToken(token.id);
    if (!m) continue;
    totalVol += m.volume_5m_usd;
    totalBuy += m.buy_volume_5m_usd;
    totalSell += m.sell_volume_5m_usd;
    if (m.liquidity_status === 'KNOWN') {
      liqSum += m.liquidity_usd;
      liqN++;
    }
    n++;
  }
  const activity = n > 0 ? totalVol / Math.max(n, 1) / 100 : 0;
  const pressure = totalSell > 0 ? totalBuy / totalSell : null;
  const result = detectRegime({
    solMomentumPct: null,
    solVolatilityPct: null,
    memecoinActivityScore: activity,
    newTokenCount1h: n,
    activeTokenCount: n,
    avgLiquidityUsd: liqN > 0 ? liqSum / liqN : null,
    marketBuySellPressure: pressure,
    launchSuccessRate: null,
    rugFailureRate: null,
  });
  latestRegime = result.regime;
  await query(
    `INSERT INTO regime_snapshots (regime, payload, data_mode) VALUES ($1,$2,$3)`,
    [
      result.regime,
      JSON.stringify({
        ...result,
        solMomentum: toMeasuredJson(result.solMomentum),
        memecoinActivity: toMeasuredJson(result.memecoinActivity),
        marketBuySellPressure: toMeasuredJson(result.marketBuySellPressure),
      }),
      dataMode,
    ],
  );
  publish('regime_updated', { regime: result.regime, reasons: result.reasons });
}

async function latestSafety(tokenId: string): Promise<SafetyResult | null> {
  const { rows } = await query<{
    score: string;
    safety_class: string;
    blocked: boolean;
    reasons: string[];
    version: string;
    assessed_at: Date;
  }>(
    `SELECT score, safety_class, blocked, reasons, version, assessed_at
     FROM safety_assessments WHERE token_id = $1 ORDER BY assessed_at DESC LIMIT 1`,
    [tokenId],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    score: Number(r.score),
    safetyClass: r.safety_class as import('@memebot/shared').SafetyClass,
    blocked: r.blocked,
    reasons: r.reasons,
    checks: {},
    version: r.version,
    assessedAt: r.assessed_at,
  } as SafetyResult;
}

async function researchTradesToday(portfolioId: string): Promise<number> {
  const { rows } = await query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM positions WHERE portfolio_id = $1 AND opened_at >= date_trunc('day', NOW())`,
    [portfolioId],
  );
  return Number(rows[0]?.n ?? 0);
}

/** Signals without a target portfolio predate per-portfolio routing and belong to the lane's original portfolio. */
function ownsUntargetedSignals(portfolioId: string): boolean {
  return portfolioId !== OLDER_TOKEN_RESEARCH_PORTFOLIO_ID;
}

/** A research signal for this token was already routed to this research portfolio within the cooldown. */
async function recentTargetedSignal(tokenId: string, portfolioId: string, cooldownSec: number): Promise<boolean> {
  const { rows } = await query(
    `SELECT 1 FROM signals WHERE token_id = $1 AND lane = 'RESEARCH' AND data_mode = $2
       AND created_at > NOW() - ($3::text || ' seconds')::interval
       AND (target_portfolio_id = $4 OR (target_portfolio_id IS NULL AND $5))
     LIMIT 1`,
    [tokenId, dataMode, String(cooldownSec), portfolioId, ownsUntargetedSignals(portfolioId)],
  );
  return rows.length > 0;
}

/**
 * Everything a strategy's `evaluate()` sees for one token at one market snapshot. Shared by the
 * signal job and execution-time revalidation so both judge a token on identical inputs.
 */
async function buildStrategyContext(
  token: Pick<
    TrackedTokenRow,
    'id' | 'address' | 'symbol' | 'chain' | 'discovered_at' | 'first_observed_at' | 'pool_created_at' | 'created_at_onchain'
  > & { discovery_source?: string | null },
  market: MarketRow,
  history: SnapshotHistoryRow[],
  now: Date,
) {
  const staleSec = getStalePriceMaxAgeMs() / 1000;
  const snapshotAgeSec = (now.getTime() - market.observed_at.getTime()) / 1000;
  const holders = await getLatestHolders(token.id);
  const age = tokenAgeOf(token, now);
  const hist = history.map(toMetricSnapshot);
  const current: MetricSnapshot = {
    observedAt: market.observed_at,
    volume5mUsd: market.volume_5m_usd,
    volume1hUsd: market.volume_1h_usd,
    volume24hUsd: market.volume_24h_usd,
    txCount5m: market.tx_count_5m,
    buys5m: market.buys_5m,
    sells5m: market.sells_5m,
    buys24h: market.buys_24h,
    sells24h: market.sells_24h,
  };
  const metrics = computeMarketMetrics({
    current,
    history: hist,
    ageMinutes: age.minutes,
    config: { minBaselineUsd: env.VOLUME_ACCEL_MIN_BASELINE_USD, maxAccel: env.VOLUME_ACCEL_MAX },
  });
  const prevWindow = previousCompletedWindow(
    hist.filter((s) => s.observedAt.getTime() < current.observedAt.getTime()),
    current,
  );
  const ticks = approximateTradesFromSnapshot({
    buyVolume5mUsd: market.buy_volume_5m_usd,
    sellVolume5mUsd: market.sell_volume_5m_usd,
    txCount5m: market.tx_count_5m,
    priceUsd: market.price_usd,
    observedAt: market.observed_at,
  });
  const flow = computeFlowFeatures(ticks);
  const safety = (await latestSafety(token.id)) ?? assessSafety(safetyInputFor(token, market, holders));
  const phase = detectTokenPhase({
    ageMinutes: age.minutes,
    priceChange2mPct: market.price_change_5m_pct,
    priceChange5mPct: market.price_change_5m_pct,
    priceChange1hPct: market.price_change_1h_pct,
    volumeAcceleration: metrics.volumeAcceleration.capped,
    liquidityUsd: market.liquidity_usd,
    liquidityChangePct: null,
    uniqueBuyers5m: flow['5m']?.uniqueBuyers.value ?? null,
    uniqueSellers5m: flow['5m']?.uniqueSellers.value ?? null,
    netFlow5mUsd: flow['5m']?.netFlowUsd.value ?? null,
    holderGrowthPct: null,
    largeWalletSellPct: null,
    volatility5mPct: Math.abs(market.price_change_5m_pct),
  });
  const dataConf = assessDataConfidence({
    liquidityStatus: market.liquidity_status,
    liquidityUsd: market.liquidity_usd,
    snapshotAgeSec,
    staleAfterSec: staleSec,
    volume5mUsd: market.volume_5m_usd,
    volume1hUsd: market.volume_1h_usd,
    txCount5m: market.tx_count_5m,
    buys5m: market.buys_5m,
    sells5m: market.sells_5m,
    ageSource: age.source,
    observations10m: metrics.observations10m,
    volumeAccelConfidence: metrics.volumeAcceleration.confidence,
    agreeingProviders: 1,
  });
  const buySellConf = assessBuySellConfidence({
    buys5m: market.buys_5m,
    sells5m: market.sells_5m,
    buys1h: market.buys_1h,
    sells1h: market.sells_1h,
    txCount5m: market.tx_count_5m,
    snapshotAgeSec,
    staleAfterSec: staleSec,
  });
  const ctx: StrategyContext = {
    tokenId: token.id,
    address: token.address,
    symbol: token.symbol,
    chain: token.chain,
    ageMinutes: age.minutes,
    priceUsd: market.price_usd,
    liquidityUsd: market.liquidity_usd,
    volume5mUsd: market.volume_5m_usd,
    volume1hUsd: market.volume_1h_usd,
    buyVolume5mUsd: market.buy_volume_5m_usd,
    sellVolume5mUsd: market.sell_volume_5m_usd,
    txCount5m: market.tx_count_5m,
    priceChange5mPct: market.price_change_5m_pct,
    priceChange1hPct: market.price_change_1h_pct,
    holderCount: holders?.holder_count ?? null,
    topHolderPct: holders?.top_holder_pct ?? null,
    observedAt: market.observed_at,
    priorVolume5mUsd: prevWindow?.volume5mUsd ?? null,
    flow,
    safety,
    regime: latestRegime ?? undefined,
    phase: phase.phase,
    buySellConfidence: buySellConf.level,
    discoverySource: token.discovery_source ?? undefined,
    volumeAccel: metrics.volumeAcceleration,
    liquidityStatus: market.liquidity_status,
  };
  return { ctx, holders, age, metrics, flow, safety, phase, dataConf, buySellConf };
}

/**
 * Signal pipeline over the evaluation budget:
 * market data → basic quality → safety → strategy → data confidence → EV (actual size).
 * Every stage is counted in a funnel snapshot so zero trades is explainable.
 */
export async function jobSignals(): Promise<void> {
  const portfolioId = await ensureDefaultPortfolio();
  const researchId = env.RESEARCH_EXPLORATION_ENABLED ? await ensureResearchPortfolio() : null;
  const olderTokenResearchId = env.OLDER_TOKEN_RESEARCH_ENABLED ? await ensureOlderTokenResearchPortfolio() : null;
  const now = new Date();
  const funnel = new FunnelRecorder();
  const evCalibrations = await getActiveEvCalibrations();
  const universe = await getUniverseCounts(env.TOKEN_STALE_AFTER_SEC);
  funnel.setStage('discovered', universe.discoveredLast10m);
  funnel.setStage('tracked', universe.tracked);
  funnel.setStage('freshMarketData', universe.freshMarketData);
  funnel.setStage('knownLiquidity', universe.byLiquidityStatus.KNOWN ?? 0);
  funnel.setStage('researchOnly', universe.byEligibility.RESEARCH_ONLY ?? 0);
  funnel.details.universe = universe;

  if (await isKillSwitchActive(portfolioId)) {
    funnel.details.blocked = 'kill_switch';
    await funnel.persist('signal', now);
    await logBotEvent({
      portfolioId,
      level: 'warn',
      category: 'kill_switch',
      message: 'Kill switch active — skipping new signals',
    });
    return;
  }

  const settings = await getPortfolioSettings(portfolioId);
  const candidates = await listEvaluationCandidates(env.TOKEN_STALE_AFTER_SEC);
  const selected = selectForEvaluation(
    candidates.map((c) => ({ ...c, activityScore: Number(c.activity_score), lastEvaluatedAt: c.last_evaluated_at })),
    env.TOKEN_EVALUATION_CAP_PER_TICK,
    env.TOKEN_EVALUATION_ROTATION_SHARE,
  );
  const tokens = selected.map((s) => s.item);
  funnel.details.selection = {
    eligibleCandidates: candidates.length,
    evaluated: tokens.length,
    cap: env.TOKEN_EVALUATION_CAP_PER_TICK,
    priority: selected.filter((s) => s.reason === 'priority').length,
    rotation: selected.filter((s) => s.reason === 'rotation').length,
  };
  await markEvaluated(tokens.map((t) => t.id));

  const strategies = activeStrategies(strategyCatalog, settings.activeStrategyIds);
  const strategyParams = resolveStrategyParams(settings.strategyParams);
  let generated = 0;
  const runId = (
    await query<{ id: string }>(
      `INSERT INTO strategy_runs (strategy_name, strategy_version, portfolio_id, data_mode, started_at)
       VALUES ($1,$2,$3,$4,NOW()) RETURNING id`,
      ['multi-strategy', 'framework-v2', portfolioId, dataMode],
    )
  ).rows[0]!.id;

  const history = await getSnapshotHistory(tokens.map((t) => t.id), now);
  const gas = await providers.gasFee.getFeeEstimate();
  const exec = execSettingsFrom(settings);
  const knobs = getRealismKnobs(exec.profile);
  const netLeg = networkFeePerLegUsd(gas, {
    priorityFeeLamports: exec.priorityFeeLamports,
    jitoTipLamports: exec.jitoTipLamports * knobs.jitoTipMult,
  });
  const exitParams = exitParamsFrom(settings);
  const portfolio = await getPortfolio(portfolioId);
  const riskCfg = riskConfigFrom(settings, portfolio?.equityUsd ?? settings.startingBalanceUsd);
  const regimeMult = latestRegime ? regimeSizeMultiplier(latestRegime) : 1;
  const staleSec = getStalePriceMaxAgeMs() / 1000;
  const minEv = settings.minExpectedNetValue ?? env.MIN_EXPECTED_NET_VALUE;
  funnel.details.ev = { minExpectedNetValue: minEv, lowConfidenceMultiplier: env.LOW_CONFIDENCE_EV_MULTIPLIER };

  for (const token of tokens) {
    funnel.stage('evaluated');
    const market = await getLatestMarketByToken(token.id);
    if (!market) continue;
    const snapshotAgeSec = (now.getTime() - market.observed_at.getTime()) / 1000;
    if (market.stale || snapshotAgeSec > staleSec) {
      funnel.reject('staleData');
      continue;
    }
    if (market.liquidity_status !== 'KNOWN') {
      funnel.reject('unknownLiquidity');
      continue;
    }

    const { ctx, holders, age, metrics, safety, phase, dataConf, buySellConf } = await buildStrategyContext(
      token,
      market,
      history.get(token.id) ?? [],
      now,
    );
    const quote = quoteFromMarket(market);

    // Reference size for EV/shadows: the tier-sized amount before EV tier and portfolio
    // limits are known. The authoritative risk decision happens at execution time.
    const absChange5m = Math.abs(market.price_change_5m_pct);
    const sizeAt = (conf: ConfidenceLevel) => referenceSizeUsd(riskCfg, conf, absChange5m, regimeMult);

    const shadowSim = {
      quote,
      gas,
      positionSizeUsd: sizeAt('MEDIUM'),
      exit: exitParams,
      quoteAgeMs: snapshotAgeSec * 1000,
      ...exec,
    };

    // Safety BEFORE strategy tradability
    if (safety.blocked) {
      funnel.reject('safetyFailed');
      const safetyFeatures = buildFeatureSnapshot({
        liquidityUsd: market.liquidity_usd,
        volume5mUsd: market.volume_5m_usd,
        volume1hUsd: market.volume_1h_usd,
        volume24hUsd: market.volume_24h_usd,
        marketCapUsd: market.market_cap_usd,
        ageMinutes: age.minutes,
        holders: holders?.holder_count ?? null,
        priceChange5mPct: market.price_change_5m_pct,
        priceChange1hPct: market.price_change_1h_pct,
        buyVolume5mUsd: market.buy_volume_5m_usd,
        sellVolume5mUsd: market.sell_volume_5m_usd,
        riskScore: safety.score,
        liquidityStatus: market.liquidity_status,
        venue: market.venue,
        extra: { price: market.price_usd, safetyClass: safety.safetyClass },
      });
      await auditSignalRejection({
        tokenId: token.id,
        portfolioId,
        funnelCategory: 'safetyFailed',
        sharedRejection: 'SAFETY_REJECTION',
        strategyReasons: safety.reasons,
        features: safetyFeatures,
      }).catch(() => undefined);
      await openShadowTrade({
        portfolioId,
        tokenId: token.id,
        rejectionReason: 'SAFETY_REJECTION',
        rejectionDetails: { reasons: safety.reasons, class: safety.safetyClass },
        cooldownSec: env.SHADOW_REENTRY_COOLDOWN_SECONDS,
        sim: shadowSim,
        now,
      });
      await recordMissedOpportunity({
        portfolioId,
        tokenId: token.id,
        rejectionReason: 'SAFETY_REJECTION',
        filterName: 'safety_engine',
        evidence: { reasons: safety.reasons },
      });
      continue;
    }
    funnel.stage('safetyPassed');

    if (
      researchWritesAllowed() &&
      !phaseWrites.recent(token.id, phase.phase, env.DECISION_AUDIT_DEDUPE_MINUTES * 60_000)
    ) {
      phaseWrites.remember(token.id, phase.phase);
      await query(
        `INSERT INTO token_phases (token_id, phase, reasons, data_mode) VALUES ($1,$2,$3,$4)`,
        [token.id, phase.phase, JSON.stringify(phase.reasons), dataMode],
      ).catch((err) => logger.warn({ err: (err as Error).message }, 'token_phases write failed'));
    }

    const { all } = evaluateAllStrategies(strategies, ctx, strategyParams);
    const rejections = all.filter((s) => s.action === 'NO_TRADE');
    for (const sig of rejections) {
      const category = classifyStrategyRejection(sig, age.minutes);
      funnel.rejectStrategy(sig.strategyId, category);
      if (category === 'unknownLiquidity' || category === 'lowLiquidity') continue;
      await openShadowTrade({
        portfolioId,
        tokenId: token.id,
        strategyId: sig.strategyId,
        rejectionReason: (sig.rejectionReason ?? 'UNKNOWN') as RejectionReason,
        rejectionDetails: { reasons: sig.reasons, category },
        cooldownSec: env.SHADOW_REENTRY_COOLDOWN_SECONDS,
        sim: shadowSim,
        now,
      });
    }

    const buys = all.filter((s) => s.action === 'BUY').sort((a, b) => b.confidence - a.confidence);
    const signalFeatures = buildFeatureSnapshot({
      liquidityUsd: market.liquidity_usd,
      volume5mUsd: market.volume_5m_usd,
      volume1hUsd: market.volume_1h_usd,
      volume24hUsd: market.volume_24h_usd,
      marketCapUsd: market.market_cap_usd,
      ageMinutes: age.minutes,
      holders: holders?.holder_count ?? null,
      priceChange5mPct: market.price_change_5m_pct,
      priceChange1hPct: market.price_change_1h_pct,
      buyVolume5mUsd: market.buy_volume_5m_usd,
      sellVolume5mUsd: market.sell_volume_5m_usd,
      liquidityStatus: market.liquidity_status,
      venue: market.venue,
      dataConfidence: dataConf.level,
      volatility5mPct: Math.abs(market.price_change_5m_pct),
      extra: { price: market.price_usd, phase: phase.phase },
    });
    if (buys.length === 0) {
      // Token-level reason: the rejection from the strategy that got furthest (highest score)
      const closest = [...rejections].sort((a, b) => b.confidence - a.confidence)[0];
      const category = closest ? classifyStrategyRejection(closest, age.minutes) : 'strategyFailed';
      funnel.reject(category);
      await auditSignalRejection({
        tokenId: token.id,
        portfolioId,
        funnelCategory: category,
        strategyReasons: closest?.reasons ?? [],
        sharedRejection: closest?.rejectionReason ?? null,
        score: closest?.confidence ?? null,
        features: {
          ...signalFeatures,
          modelScore: closest?.confidence ?? null,
          overallScore: closest?.confidence ?? null,
        },
        strategyId: closest?.strategyId ?? null,
      }).catch(() => undefined);
      continue;
    }
    funnel.stage('strategyEligible');

    const best = buys[0]!;
    await auditSignalPass({
      tokenId: token.id,
      portfolioId,
      score: best.confidence,
      features: { ...signalFeatures, modelScore: best.confidence, overallScore: best.confidence },
      strategyId: best.strategyId,
    }).catch(() => undefined);
    const proposedSizeUsd = sizeAt(dataConf.level);

    const cost = estimateRoundTripCost({
      positionSizeUsd: proposedSizeUsd,
      liquidityUsd: market.liquidity_usd,
      venue: market.venue,
      feeBps: market.fee_bps,
      absPriceChange5mPct: Math.abs(market.price_change_5m_pct),
      networkFeePerLegUsd: netLeg,
      adverseSelectionRatePerLeg: snapshotAgeSec > 2 ? 0.002 * knobs.adverseSelectionMult : 0,
    });
    const evFor = (sig: Signal) =>
      estimateExpectedValue({
        signal: sig,
        cost,
        failureProbability: knobs.failureRate,
        minExpectedNetValue: minEv,
        dataConfidence: dataConf.level,
        lowConfidenceMultiplier: env.LOW_CONFIDENCE_EV_MULTIPLIER,
        calibration: evCalibrations.get(sig.strategyId) ?? null,
      });

    const ev = evFor(best);
    // Research eligibility is judged on the uncalibrated model (calibration is production-only)
    const researchEv = ev.rawExpectedNetValue ?? ev.expectedNetValue;
    const shortfall = researchEv != null ? ev.threshold - researchEv : null;
    const researchEligible =
      !ev.passes &&
      researchId != null &&
      shortfall != null &&
      shortfall <= env.RESEARCH_MAX_EV_SHORTFALL &&
      cost.networkFeePriced &&
      dataConf.checks.filter((c) => c.critical).every((c) => c.ok);
    const decision = ev.passes ? 'SIGNAL' : researchEligible ? 'RESEARCH_SIGNAL' : 'EV_REJECTED';

    for (const sig of buys) {
      const sigEv = sig === best ? ev : evFor(sig);
      if (sigEv.expectedNetValue != null) {
        funnel.evCandidate({
          tokenId: token.id,
          symbol: token.symbol,
          strategyId: sig.strategyId,
          expectedNetValue: sigEv.expectedNetValue,
          threshold: sigEv.threshold,
          dataConfidence: dataConf.level,
          executionCostRate: sigEv.executionCostRate,
          positionSizeUsd: sigEv.positionSizeUsd,
        });
      }
      await recordOpportunity({
        tokenId: token.id,
        strategyId: sig.strategyId,
        strategyVersion: sig.strategyVersion,
        decision: sig === best ? decision : sigEv.passes ? 'EV_PASS_NOT_SELECTED' : 'EV_REJECTED',
        observedAt: market.observed_at,
        priceUsd: market.price_usd,
        liquidityUsd: market.liquidity_usd,
        liquidityStatus: market.liquidity_status,
        volume5mUsd: market.volume_5m_usd,
        volume1hUsd: market.volume_1h_usd,
        buys5m: market.buys_5m,
        sells5m: market.sells_5m,
        txCount5m: market.tx_count_5m,
        uniqueBuyers: null,
        uniqueSellers: null,
        marketRegime: latestRegime,
        tokenAgeMin: age.minutes,
        ageSource: age.source,
        sinceFirstObservedSec: token.first_observed_at
          ? Math.round((now.getTime() - token.first_observed_at.getTime()) / 1000)
          : null,
        dataConfidence: dataConf.level,
        buySellConfidence: buySellConf.level,
        volumeAccelRaw: metrics.volumeAcceleration.raw,
        volumeAccelCapped: metrics.volumeAcceleration.capped,
        volumeAccelConfidence: metrics.volumeAcceleration.confidence,
        expectedValue: sigEv,
        evNet: sigEv.expectedNetValue,
        evThreshold: sigEv.threshold,
        executionCostRate: sigEv.executionCostRate,
        executionCostUsd: sigEv.executionCostUsd,
        positionSizeUsd: sigEv.positionSizeUsd,
        features: {
          confidence: sig.confidence,
          reasons: sig.reasons,
          phase: phase.phase,
          priceChange5mPct: market.price_change_5m_pct,
          priceChange1hPct: market.price_change_1h_pct,
          dataConfidenceChecks: dataConf.checks,
          buySellConfidenceReasons: buySellConf.reasons,
          volumeAccel: metrics.volumeAcceleration,
          txAccel: metrics.transactionAcceleration,
          buyAccel: metrics.buyAcceleration,
          sellAccel: metrics.sellAcceleration,
          volume1mUsd: metrics.volume1mUsd,
          buys1m: metrics.buys1m,
          sells1m: metrics.sells1m,
        },
        exitParams,
        cooldownSec: env.OPPORTUNITY_COOLDOWN_SECONDS,
      });
    }

    let lane: SignalLane | null = null;
    if (ev.passes) {
      funnel.stage('evPassed');
      lane = 'PRODUCTION';
    } else {
      funnel.reject('evFailed');
      await openShadowTrade({
        portfolioId,
        tokenId: token.id,
        strategyId: best.strategyId,
        rejectionReason: 'EXPECTED_VALUE_TOO_LOW',
        rejectionDetails: { ev, reasons: best.reasons },
        cooldownSec: env.SHADOW_REENTRY_COOLDOWN_SECONDS,
        sim: { ...shadowSim, positionSizeUsd: proposedSizeUsd },
        now,
      });
      await recordMissedOpportunity({
        portfolioId,
        tokenId: token.id,
        rejectionReason: 'EXPECTED_VALUE_TOO_LOW',
        filterName: 'expected_value',
        evidence: { ev },
      });
      if (
        researchEligible &&
        researchId &&
        !(await recentTargetedSignal(token.id, researchId, env.OPPORTUNITY_COOLDOWN_SECONDS))
      ) {
        lane = 'RESEARCH';
      }
    }
    if (!lane) continue;

    const scores = best.scores ?? {
      momentum: best.confidence,
      liquidity: 50,
      volume: 50,
      holderDistribution: 50,
      risk: 50,
      overall: best.confidence,
    };

    const { rows } = await query<{ id: string }>(
      `INSERT INTO signals (
        token_id, strategy_name, strategy_version, side,
        momentum_score, liquidity_score, volume_score, holder_score, risk_score, overall_score,
        risk_label, explanation, market_state, data_mode,
        action, confidence, expected_value, lane, position_size_usd, data_confidence, target_portfolio_id
      ) VALUES ($1,$2,$3,'BUY',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'BUY',$14,$15,$16,$17,$18,$19)
      RETURNING id`,
      [
        token.id,
        best.strategyId,
        best.strategyVersion,
        scores.momentum,
        scores.liquidity,
        scores.volume,
        scores.holderDistribution,
        scores.risk,
        scores.overall,
        best.riskLabel ?? 'MODERATE',
        JSON.stringify({ reasons: best.reasons, warnings: [], factors: { ev }, lane }),
        JSON.stringify({
          ...ctx,
          flow: undefined,
          volumeAccel: metrics.volumeAcceleration,
          safety: { score: safety.score, class: safety.safetyClass, reasons: safety.reasons },
          phase: phase.phase,
          regime: latestRegime,
          dataConfidence: dataConf.level,
          ageSource: age.source,
          strategyParams: strategyParams[best.strategyId] ?? {},
        }),
        dataMode,
        best.confidence,
        JSON.stringify(ev),
        lane,
        proposedSizeUsd,
        dataConf.level,
        lane === 'RESEARCH' ? researchId : portfolioId,
      ],
    );

    if (lane === 'PRODUCTION') {
      generated++;
      signalsGenerated++;
    }
    await logBotEvent({
      portfolioId: lane === 'RESEARCH' ? researchId : portfolioId,
      level: 'info',
      category: 'signal',
      message: `${lane === 'RESEARCH' ? 'Research signal' : 'Signal'} ${best.strategyId} for ${token.symbol}`,
      details: {
        signalId: rows[0]!.id,
        lane,
        confidence: best.confidence,
        expectedNetValue: ev.expectedNetValue,
        threshold: ev.threshold,
        disclaimer: 'Model score, not a probability of profit',
      },
    });
    if (lane === 'PRODUCTION') {
      publish('signal_generated', {
        signalId: rows[0]!.id,
        tokenId: token.id,
        symbol: token.symbol,
        strategyId: best.strategyId,
        confidence: best.confidence,
        scores,
      });
    }
  }

  await funnel.persist('signal', now);
  await query(
    `UPDATE strategy_runs SET finished_at = NOW(), tokens_evaluated = $2, signals_generated = $3 WHERE id = $1`,
    [runId, tokens.length, generated],
  );

  if (olderTokenResearchId) {
    await runOlderTokenResearchSignals(olderTokenResearchId, now);
  }
}

/**
 * Older-token research lane: research-only strategies on tokens with enough prior history,
 * traded only in the older-token research portfolio. Production signals, risk state and
 * calibration are untouched. Every strategy-qualified candidate is recorded as an opportunity
 * (forward returns tracked) whether the lane trades it or rejects it.
 */
async function runOlderTokenResearchSignals(researchPortfolioId: string, now: Date): Promise<void> {
  const settings = await getPortfolioSettings(researchPortfolioId);
  const strategyParams = resolveStrategyParams(settings.strategyParams);
  const strategies = researchOnlyStrategies(strategyCatalog);
  if (strategies.length === 0) return;

  // Spend the budget on tokens that can qualify: coverage beyond the most recent hour
  const minPriorMinutes = Math.min(
    ...strategies.map((s) => (strategyParams[s.id]?.minHistoryCoverageHours ?? 0) * 60),
  );
  const candidates = (await listEvaluationCandidates(env.TOKEN_STALE_AFTER_SEC)).filter(
    (c) => historyCoverageMinutes(c, now).coverage - 60 >= minPriorMinutes,
  );
  const selected = selectForEvaluation(
    candidates.map((c) => ({ ...c, activityScore: Number(c.activity_score), lastEvaluatedAt: c.last_evaluated_at })),
    env.OLDER_TOKEN_RESEARCH_EVALUATION_CAP,
    env.OLDER_TOKEN_RESEARCH_ROTATION_SHARE,
  );
  const tokens = selected.map((s) => s.item);
  const runId = (
    await query<{ id: string }>(
      `INSERT INTO strategy_runs (strategy_name, strategy_version, portfolio_id, data_mode, started_at)
       VALUES ($1,$2,$3,$4,NOW()) RETURNING id`,
      ['older-token-research', 'framework-v1', researchPortfolioId, dataMode],
    )
  ).rows[0]!.id;

  const history = await getSnapshotHistory(tokens.map((t) => t.id), now);
  const gas = await providers.gasFee.getFeeEstimate();
  const exec = execSettingsFrom(settings);
  const knobs = getRealismKnobs(exec.profile);
  const netLeg = networkFeePerLegUsd(gas, {
    priorityFeeLamports: exec.priorityFeeLamports,
    jitoTipLamports: exec.jitoTipLamports * knobs.jitoTipMult,
  });
  const exitParams = exitParamsFrom(settings);
  const portfolio = await getPortfolio(researchPortfolioId);
  const riskCfg = riskConfigFrom(settings, portfolio?.equityUsd ?? settings.startingBalanceUsd);
  const staleSec = getStalePriceMaxAgeMs() / 1000;
  const minEv = settings.minExpectedNetValue ?? env.MIN_EXPECTED_NET_VALUE;

  let generated = 0;

  for (const token of tokens) {
    const market = await getLatestMarketByToken(token.id);
    if (!market) continue;
    const snapshotAgeSec = (now.getTime() - market.observed_at.getTime()) / 1000;
    if (market.stale || snapshotAgeSec > staleSec) continue;
    if (market.liquidity_status !== 'KNOWN') continue;

    const built = await buildStrategyContext(token, market, history.get(token.id) ?? [], now);
    const { age, metrics, safety, phase, dataConf, buySellConf } = built;
    if (safety.blocked) continue;
    const ctx: StrategyContext = {
      ...built.ctx,
      volume24hUsd: market.volume_24h_usd,
      buys1h: market.buys_1h,
      sells1h: market.sells_1h,
      buys24h: market.buys_24h,
      sells24h: market.sells_24h,
      observedSpanMinutes: historyCoverageMinutes(token, now).observedSpanMinutes,
    };

    const { all } = evaluateAllStrategies(strategies, ctx, strategyParams);
    const buys = all.filter((s) => s.action === 'BUY').sort((a, b) => b.confidence - a.confidence);
    if (buys.length === 0) continue;

    const best = buys[0]!;
    const proposedSizeUsd = referenceSizeUsd(riskCfg, dataConf.level, Math.abs(market.price_change_5m_pct), 1);
    const cost = estimateRoundTripCost({
      positionSizeUsd: proposedSizeUsd,
      liquidityUsd: market.liquidity_usd,
      venue: market.venue,
      feeBps: market.fee_bps,
      absPriceChange5mPct: Math.abs(market.price_change_5m_pct),
      networkFeePerLegUsd: netLeg,
      adverseSelectionRatePerLeg: snapshotAgeSec > 2 ? 0.002 * knobs.adverseSelectionMult : 0,
    });
    // Research-only strategies emit no return/loss estimate, so EV is reported as unknown
    // (never passes). The lane gates on measurable cost viability instead.
    const evFor = (sig: Signal) =>
      estimateExpectedValue({
        signal: sig,
        cost,
        failureProbability: knobs.failureRate,
        minExpectedNetValue: minEv,
        dataConfidence: dataConf.level,
        lowConfidenceMultiplier: env.LOW_CONFIDENCE_EV_MULTIPLIER,
        calibration: null,
      });
    const ev = evFor(best);
    const rejection = olderLaneRejection({
      costRate: cost.totalCostRate,
      networkFeePriced: cost.networkFeePriced,
      maxRoundTripCostPct: env.OLDER_TOKEN_RESEARCH_MAX_ROUND_TRIP_COST_PCT,
      criticalDataOk: dataConf.checks.filter((c) => c.critical).every((c) => c.ok),
      inCooldown: await recentTargetedSignal(token.id, researchPortfolioId, env.OPPORTUNITY_COOLDOWN_SECONDS),
    });

    for (const sig of buys) {
      const sigEv = sig === best ? ev : evFor(sig);
      await recordOpportunity({
        tokenId: token.id,
        strategyId: sig.strategyId,
        strategyVersion: sig.strategyVersion,
        decision:
          sig !== best ? 'OLDER_RESEARCH_NOT_SELECTED' : rejection ? 'OLDER_RESEARCH_REJECTED' : 'OLDER_RESEARCH_SIGNAL',
        observedAt: market.observed_at,
        priceUsd: market.price_usd,
        liquidityUsd: market.liquidity_usd,
        liquidityStatus: market.liquidity_status,
        volume5mUsd: market.volume_5m_usd,
        volume1hUsd: market.volume_1h_usd,
        buys5m: market.buys_5m,
        sells5m: market.sells_5m,
        txCount5m: market.tx_count_5m,
        uniqueBuyers: null,
        uniqueSellers: null,
        marketRegime: latestRegime,
        tokenAgeMin: age.minutes,
        ageSource: age.source,
        sinceFirstObservedSec: ctx.observedSpanMinutes != null ? Math.round(ctx.observedSpanMinutes * 60) : null,
        dataConfidence: dataConf.level,
        buySellConfidence: buySellConf.level,
        volumeAccelRaw: metrics.volumeAcceleration.raw,
        volumeAccelCapped: metrics.volumeAcceleration.capped,
        volumeAccelConfidence: metrics.volumeAcceleration.confidence,
        expectedValue: sigEv,
        evNet: sigEv.expectedNetValue,
        evThreshold: sigEv.threshold,
        executionCostRate: sigEv.executionCostRate,
        executionCostUsd: sigEv.executionCostUsd,
        positionSizeUsd: sigEv.positionSizeUsd,
        features: {
          lane: 'RESEARCH',
          portfolioId: researchPortfolioId,
          rejectionReason: sig === best ? rejection : 'lower_confidence_than_best',
          confidence: sig.confidence,
          reasons: sig.reasons,
          phase: phase.phase,
          priceChange5mPct: market.price_change_5m_pct,
          priceChange1hPct: market.price_change_1h_pct,
          volume24hUsd: market.volume_24h_usd,
          dataConfidenceChecks: dataConf.checks,
          volumeAccel: metrics.volumeAcceleration,
          txAccel: metrics.transactionAcceleration,
        },
        exitParams,
        cooldownSec: env.OPPORTUNITY_COOLDOWN_SECONDS,
      });
    }
    if (rejection) continue;

    const scores = best.scores ?? {
      momentum: best.confidence,
      liquidity: 50,
      volume: 50,
      holderDistribution: 50,
      risk: 50,
      overall: best.confidence,
    };

    const { rows } = await query<{ id: string }>(
      `INSERT INTO signals (
        token_id, strategy_name, strategy_version, side,
        momentum_score, liquidity_score, volume_score, holder_score, risk_score, overall_score,
        risk_label, explanation, market_state, data_mode,
        action, confidence, expected_value, lane, position_size_usd, data_confidence, target_portfolio_id
      ) VALUES ($1,$2,$3,'BUY',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'BUY',$14,$15,'RESEARCH',$16,$17,$18)
      RETURNING id`,
      [
        token.id,
        best.strategyId,
        best.strategyVersion,
        scores.momentum,
        scores.liquidity,
        scores.volume,
        scores.holderDistribution,
        scores.risk,
        scores.overall,
        best.riskLabel ?? 'MODERATE',
        JSON.stringify({
          reasons: best.reasons,
          warnings: ['no_empirical_return_estimate'],
          factors: { ev, costRate: cost.totalCostRate },
          lane: 'RESEARCH',
        }),
        JSON.stringify({
          ...ctx,
          flow: undefined,
          volumeAccel: metrics.volumeAcceleration,
          safety: { score: safety.score, class: safety.safetyClass, reasons: safety.reasons },
          phase: phase.phase,
          regime: latestRegime,
          dataConfidence: dataConf.level,
          ageSource: age.source,
          strategyParams: strategyParams[best.strategyId] ?? {},
        }),
        dataMode,
        best.confidence,
        JSON.stringify(ev),
        proposedSizeUsd,
        dataConf.level,
        researchPortfolioId,
      ],
    );

    generated++;

    await logBotEvent({
      portfolioId: researchPortfolioId,
      level: 'info',
      category: 'signal',
      message: `Older-token research signal ${best.strategyId} for ${token.symbol}`,
      details: {
        signalId: rows[0]!.id,
        lane: 'RESEARCH',
        strategy: best.strategyId,
        confidence: best.confidence,
        expectedNetValue: null,
        roundTripCostRate: cost.totalCostRate,
        disclaimer: 'Research only - no empirical return estimate yet',
      },
    });
  }

  await query(
    `UPDATE strategy_runs SET finished_at = NOW(), tokens_evaluated = $2, signals_generated = $3 WHERE id = $1`,
    [runId, tokens.length, generated],
  );
}

export async function jobPaperExecution(): Promise<void> {
  const productionId = await ensureDefaultPortfolio();
  const production = await getPortfolio(productionId);
  if (!production) return;
  await executeLane(productionId, 'PRODUCTION', production.botStatus);
  if (env.RESEARCH_EXPLORATION_ENABLED) {
    const researchId = await ensureResearchPortfolio();
    // Research follows the production bot status / kill switch
    await executeLane(researchId, 'RESEARCH', production.botStatus, productionId);
  }
  if (env.OLDER_TOKEN_RESEARCH_ENABLED) {
    const olderTokenResearchId = await ensureOlderTokenResearchPortfolio();
    // Older-token research follows the production bot status / kill switch
    await executeLane(olderTokenResearchId, 'RESEARCH', production.botStatus, productionId);
  }
}

/** Capital committed to open positions (cost basis) — same measure the atomic buy check uses. */
async function openExposure(
  portfolioId: string,
  strategyKey: string | null,
  tokenId: string,
): Promise<{ portfolio: number; strategy: number; token: number }> {
  const { rows } = await query<{ portfolio: string; strategy: string; token: string }>(
    `SELECT COALESCE(SUM(cost_basis_usd), 0) AS portfolio,
            COALESCE(SUM(cost_basis_usd) FILTER (WHERE strategy_key = $2), 0) AS strategy,
            COALESCE(SUM(cost_basis_usd) FILTER (WHERE token_id = $3), 0) AS token
     FROM positions WHERE portfolio_id = $1 AND status = 'OPEN'`,
    [portfolioId, strategyKey, tokenId],
  );
  return {
    portfolio: Number(rows[0]?.portfolio ?? 0),
    strategy: Number(rows[0]?.strategy ?? 0),
    token: Number(rows[0]?.token ?? 0),
  };
}

function isResearchOnlyStrategy(strategyId: string | null): boolean {
  return strategyCatalog.some((s) => s.id === strategyId && s.researchOnly);
}

function researchDailyCap(portfolioId: string): number {
  return portfolioId === OLDER_TOKEN_RESEARCH_PORTFOLIO_ID
    ? env.OLDER_TOKEN_RESEARCH_MAX_TRADES_PER_DAY
    : env.RESEARCH_MAX_TRADES_PER_DAY;
}

/**
 * Stored BUY → Signal for the final EV check. A missing return/loss estimate is only accepted
 * for research-only strategies in the research lane (their EV stays unknown); anywhere else
 * the signal is unusable.
 */
function signalFromStored(
  row: {
    confidence: string | null;
    overall_score: string;
    strategy_id: string | null;
    strategy_version: string;
    expected_value: unknown;
  },
  allowUnknownEv: boolean,
): Signal | null {
  const ev = (row.expected_value ?? {}) as {
    grossUpside?: number | null;
    downside?: number | null;
    timeToTargetSec?: number;
  };
  const known = ev.grossUpside != null && ev.downside != null;
  if (!known && !allowUnknownEv) return null;
  return {
    action: 'BUY',
    confidence: Number(row.confidence ?? row.overall_score),
    expectedReturn: known ? ev.grossUpside! : null,
    expectedLoss: known ? ev.downside! : null,
    expectedHoldTimeSec: ev.timeToTargetSec ?? null,
    reasons: [],
    strategyId: row.strategy_id ?? 'unknown',
    strategyVersion: row.strategy_version,
  };
}

export async function executeLane(
  portfolioId: string,
  lane: SignalLane,
  botStatus: string,
  controlPortfolioId: string = portfolioId,
): Promise<void> {
  const portfolio = await getPortfolio(portfolioId);
  if (!portfolio) return;
  const settings = await getPortfolioSettings(portfolioId);

  await manageOpenPositions(portfolioId, settings);

  if (botStatus === 'KILLED' || (await isKillSwitchActive(controlPortfolioId))) return;
  if (botStatus !== 'RUNNING') return;

  if (lane === 'RESEARCH' && (await researchTradesToday(portfolioId)) >= researchDailyCap(portfolioId)) {
    return;
  }

  const { rows: signals } = await query<{
    id: string;
    token_id: string;
    overall_score: string;
    confidence: string | null;
    expected_value: unknown;
    strategy_id: string | null;
    strategy_version: string;
    data_confidence: ConfidenceLevel | null;
    market_state: Record<string, unknown> | null;
    created_at: Date;
    token_address: string | null;
  }>(
    `SELECT s.id, s.token_id, s.overall_score, s.confidence, s.expected_value,
            s.strategy_name AS strategy_id, s.strategy_version, s.data_confidence,
            s.market_state, s.created_at, t.address AS token_address
     FROM signals s
     LEFT JOIN tokens t ON t.id = s.token_id
     WHERE s.data_mode = $1
       AND s.side = 'BUY'
       AND s.lane = $3
       AND (s.target_portfolio_id = $2 OR (s.target_portfolio_id IS NULL AND $4))
       AND s.created_at > NOW() - INTERVAL '10 minutes'
       AND NOT EXISTS (
         SELECT 1 FROM paper_orders o WHERE o.signal_id = s.id AND o.portfolio_id = $2
       )
       AND NOT EXISTS (
         SELECT 1 FROM positions p WHERE p.token_id = s.token_id AND p.portfolio_id = $2 AND p.status = 'OPEN'
       )
       AND NOT EXISTS (
         SELECT 1 FROM signal_execution_attempts a
         WHERE a.signal_id = s.id AND a.portfolio_id = $2 AND a.status = 'STRATEGY_INVALIDATED'
       )
     ORDER BY COALESCE(s.confidence, s.overall_score) DESC
     LIMIT 5`,
    [dataMode, portfolioId, lane, ownsUntargetedSignals(portfolioId)],
  );
  if (signals.length === 0) return;

  const funnel = new FunnelRecorder();
  funnel.details.lane = lane;
  funnel.details.signalsConsidered = signals.length;
  const persist = () => funnel.persist(`execution_${lane.toLowerCase()}`);

  const gas = await providers.gasFee.getFeeEstimate();
  if (!isGasUsableForTrading(gas)) {
    funnel.reject('executionFailed', signals.length);
    funnel.details.blocked = 'sol_usd_unavailable';
    await persist();
    await logBotEvent({
      portfolioId,
      level: 'error',
      category: 'fees',
      message: 'SOL/USD price unavailable or stale — skipping new paper trades (fail-safe)',
      details: {
        solPriceUsd: gas.solPriceUsd,
        solPriceSource: gas.solPriceSource,
        solPriceStale: gas.solPriceStale,
      },
    });
    return;
  }

  const exec = execSettingsFrom(settings);
  const knobs = getRealismKnobs(exec.profile);
  const netLeg = networkFeePerLegUsd(gas, {
    priorityFeeLamports: exec.priorityFeeLamports,
    jitoTipLamports: exec.jitoTipLamports * knobs.jitoTipMult,
  });
  const exitParams = exitParamsFrom(settings);
  const minEv = settings.minExpectedNetValue ?? env.MIN_EXPECTED_NET_VALUE;
  const evCalibrations = await getActiveEvCalibrations();

  const dayPnl = await query<{ pnl: string }>(
    `SELECT COALESCE(SUM(realized_pnl_usd),0) AS pnl FROM positions
     WHERE portfolio_id = $1 AND closed_at >= date_trunc('day', NOW())`,
    [portfolioId],
  );

  for (const signal of signals) {
    const latest = await getPortfolio(portfolioId);
    if (!latest) break;
    if (lane === 'RESEARCH' && (await researchTradesToday(portfolioId)) >= researchDailyCap(portfolioId)) {
      funnel.details.researchDailyCapReached = true;
      break;
    }
    const researchOnly = isResearchOnlyStrategy(signal.strategy_id);
    if (researchOnly && lane !== 'RESEARCH') {
      funnel.reject('strategyFailed');
      continue;
    }

    // Per-signal duplicate check (fixes race across loop iterations)
    const openDup = await query(
      `SELECT id FROM positions WHERE portfolio_id = $1 AND token_id = $2 AND status = 'OPEN'`,
      [portfolioId, signal.token_id],
    );
    if (openDup.rows.length > 0) continue;

    const market = await getLatestMarketByToken(signal.token_id);
    if (!market) continue;
    // Production BUYs are re-checked against their own strategy at execution time.
    const attemptId =
      lane === 'PRODUCTION'
        ? await beginExecutionAttempt({
            portfolioId,
            signalId: signal.id,
            tokenId: signal.token_id,
            tokenAddress: signal.token_address,
            strategyId: signal.strategy_id,
            lane,
            signalCreatedAt: signal.created_at,
            marketObservedAt: market.observed_at,
            status: 'PENDING',
          })
        : null;
    if (market.stale || Date.now() - market.observed_at.getTime() > getStalePriceMaxAgeMs()) {
      if (attemptId) await updateExecutionAttempt(attemptId, { status: 'STALE_DATA', statusReason: 'market_snapshot_stale' });
      funnel.reject('staleData');
      await logBotEvent({
        portfolioId,
        level: 'warn',
        category: 'execution',
        message: "Stale price — don't trade",
        details: { tokenId: signal.token_id, lane },
      });
      await recordMissedOpportunity({
        portfolioId,
        tokenId: signal.token_id,
        rejectionReason: 'STALE_DATA',
        filterName: 'execution_freshness',
      });
      continue;
    }
    if (market.liquidity_status !== 'KNOWN' || market.liquidity_usd <= 0) {
      if (attemptId) {
        await updateExecutionAttempt(attemptId, { status: 'UNKNOWN_LIQUIDITY', statusReason: market.liquidity_status });
      }
      funnel.reject('unknownLiquidity');
      continue;
    }
    const quote = quoteFromMarket(market);
    const quoteAgeMs = Date.now() - market.observed_at.getTime();

    let revalidation: Record<string, unknown> | null = null;
    if (attemptId) {
      const now = new Date();
      const token = await getTrackedToken(signal.token_id);
      const built = token
        ? await buildStrategyContext(token, market, (await getSnapshotHistory([token.id], now)).get(token.id) ?? [], now)
        : null;
      const reval: StrategyRevalidation = built
        ? revalidateSignalStrategy({
            strategyId: signal.strategy_id,
            catalog: strategyCatalog,
            activeIds: settings.activeStrategyIds,
            params: resolveStrategyParams(settings.strategyParams),
            ctx: built.ctx,
          })
        : { passed: false, reason: 'token_missing', reasons: ['token_missing'], sharedRejection: null, confidence: null, signal: null };
      const features = built ? revalidationFeatures(built.ctx) : {};
      const signalAgeMs = now.getTime() - signal.created_at.getTime();
      await recordRevalidation(attemptId, reval, features);
      await auditStrategyRevalidation({
        tokenId: signal.token_id,
        portfolioId,
        passed: reval.passed,
        strategyId: signal.strategy_id,
        signalId: signal.id,
        signalAgeMs,
        reasons: reval.reasons,
        sharedRejection: reval.sharedRejection,
        confidence: reval.confidence,
        features,
      }).catch(() => undefined);
      if (!reval.passed) {
        funnel.reject('strategyFailed');
        funnel.details.strategyInvalidated = Number(funnel.details.strategyInvalidated ?? 0) + 1;
        await auditFinalOutcome({
          tokenId: signal.token_id,
          portfolioId,
          traded: false,
          reasonCode: 'SIGNAL_INVALIDATED',
          details: { reason: reval.reason, reasons: reval.reasons, signalAgeMs, lane },
          strategyId: signal.strategy_id,
          signalId: signal.id,
        }).catch(() => undefined);
        await logBotEvent({
          portfolioId,
          level: 'info',
          category: 'execution',
          message: `Signal invalidated at execution: ${signal.strategy_id} no longer passes (${reval.reason})`,
          details: { tokenId: signal.token_id, signalId: signal.id, signalAgeMs, reasons: reval.reasons, lane },
        });
        continue;
      }
      revalidation = {
        result: 'PASS',
        at: now.toISOString(),
        signalAgeMs,
        confidence: reval.confidence,
        reasons: reval.reasons,
        features,
      };
    }

    const risk = evaluateRisk({
      equityUsd: latest.equityUsd,
      cashUsd: latest.cashUsd,
      openPositions: latest.openPositions,
      startingBalanceUsd: latest.startingBalanceUsd,
      peakEquityUsd: latest.peakEquityUsd,
      realizedPnlTodayUsd: Number(dayPnl.rows[0]?.pnl ?? 0),
      proposedSizeUsd: latest.equityUsd * settings.maxPositionPct,
      stopLossPct: settings.stopLossPct,
      settings,
      currentRiskState: latest.riskState,
      killSwitchActive: settings.killSwitchActive,
    });

    await setRiskState(portfolioId, risk.riskState);
    await query(`UPDATE user_portfolios SET risk_state_changed_at = NOW() WHERE id = $1`, [portfolioId]);

    const stored = signalFromStored(signal, researchOnly && lane === 'RESEARCH');
    if (!stored) {
      funnel.reject('evFailed');
      continue;
    }
    const signalEv = (signal.expected_value ?? {}) as { expectedNetValue?: number | null; threshold?: number };

    // Drawdown / daily-loss / kill state machine decides whether entries are allowed and
    // its size multiplier. Open-position count and cash are handled by the risk sizer.
    const stateAllows =
      risk.allowed || risk.reason.startsWith('Max simultaneous') || risk.reason.startsWith('Insufficient cash');
    const exposure = await openExposure(portfolioId, signal.strategy_id, signal.token_id);
    const costAt = (sizeUsd: number) =>
      estimateRoundTripCost({
        positionSizeUsd: sizeUsd,
        liquidityUsd: market.liquidity_usd,
        venue: market.venue,
        feeBps: market.fee_bps,
        absPriceChange5mPct: Math.abs(market.price_change_5m_pct),
        networkFeePerLegUsd: netLeg,
        adverseSelectionRatePerLeg: quoteAgeMs > 2000 ? 0.002 * knobs.adverseSelectionMult : 0,
      });
    const riskCfg = riskConfigFrom(settings, latest.equityUsd);
    const assessment: RiskAssessment = assessPositionRisk(
      {
        lane,
        dataConfidence: signal.data_confidence ?? 'LOW',
        expectedNetValue: signalEv.expectedNetValue ?? null,
        evThreshold: signalEv.threshold ?? minEv,
        liquidityStatus: market.liquidity_status,
        liquidityUsd: market.liquidity_usd,
        absPriceChange5mPct: Math.abs(market.price_change_5m_pct),
        stopLossPct: settings.stopLossPct,
        regimeMultiplier: latestRegime ? regimeSizeMultiplier(latestRegime) : 1,
        costAt,
      },
      {
        cashUsd: latest.cashUsd,
        openPositions: latest.openPositions,
        portfolioExposureUsd: exposure.portfolio,
        strategyExposureUsd: exposure.strategy,
        tokenExposureUsd: exposure.token,
        riskStateAllowsEntries: stateAllows,
        riskStateMultiplier: stateAllows ? Math.max(risk.sizeMultiplier, 0) : 0,
      },
      riskCfg,
    );
    funnel.stage('riskEvaluated');
    const riskDecisionId = await recordRiskDecision(assessment, {
      portfolioId,
      signalId: signal.id,
      tokenId: signal.token_id,
      strategyId: signal.strategy_id,
      lane,
      stopLossPct: settings.stopLossPct,
      expectedNetValue: signalEv.expectedNetValue ?? null,
      evThreshold: signalEv.threshold ?? null,
      dataConfidence: signal.data_confidence,
    });

    const shadowSim = {
      quote,
      gas,
      positionSizeUsd: Math.max(riskCfg.minSizeUsd, assessment.finalSizeUsd || assessment.maxViableSizeUsd),
      exit: exitParams,
      quoteAgeMs,
      ...exec,
    };

    if (attemptId) {
      const rejected = assessment.decision === 'REJECTED';
      await updateExecutionAttempt(attemptId, {
        status: !rejected
          ? 'PENDING'
          : assessment.rejectionReason === 'maxOpenPositions'
            ? 'CAPACITY_BLOCKED'
            : 'RISK_REJECTED',
        statusReason: rejected ? (assessment.rejectionReason ?? 'minimumPositionSize') : null,
        riskDecisionId,
        riskResult: rejected ? 'FAIL' : 'PASS',
        riskReason: rejected ? (assessment.rejectionReason ?? 'minimumPositionSize') : assessment.decision,
      });
    }

    if (assessment.decision === 'REJECTED') {
      funnel.stage('riskRejected');
      funnel.reject('riskFailed');
      funnel.riskReject(assessment.rejectionReason ?? 'minimumPositionSize');
      funnel.riskSample(assessment, signal.strategy_id);
      await auditRiskDecision({
        tokenId: signal.token_id,
        portfolioId,
        rejected: true,
        riskReason: assessment.rejectionReason,
        actual: {
          openPositions: latest.openPositions,
          requestedSizeUsd: assessment.requestedSizeUsd,
          maxViableSizeUsd: assessment.maxViableSizeUsd,
          cashUsd: latest.cashUsd,
          detail: assessment.detail,
        },
        required: {
          maxOpenPositions: riskCfg.maxOpenPositions,
          minSizeUsd: riskCfg.minSizeUsd,
        },
        features: {
          price: market.price_usd,
          marketCap: market.market_cap_usd,
          liquidity: market.liquidity_usd,
        },
        strategyId: signal.strategy_id,
        signalId: signal.id,
        riskDecisionId,
      }).catch(() => undefined);
      await openShadowTrade({
        portfolioId,
        tokenId: signal.token_id,
        signalId: signal.id,
        strategyId: signal.strategy_id,
        rejectionReason: 'RISK_LIMIT',
        rejectionDetails: {
          reason: assessment.rejectionReason,
          detail: assessment.detail,
          requestedSizeUsd: assessment.requestedSizeUsd,
          maxViableSizeUsd: assessment.maxViableSizeUsd,
          lane,
        },
        cooldownSec: env.SHADOW_REENTRY_COOLDOWN_SECONDS,
        sim: shadowSim,
      });
      continue;
    }
    funnel.stage(assessment.decision === 'RESIZED' ? 'riskResized' : 'riskSized');
    funnel.riskSample(assessment, signal.strategy_id);
    await auditRiskDecision({
      tokenId: signal.token_id,
      portfolioId,
      rejected: false,
      actual: {
        decision: assessment.decision,
        openPositions: latest.openPositions,
        finalSizeUsd: assessment.finalSizeUsd,
        bindingConstraint: assessment.bindingConstraint,
      },
      required: { maxOpenPositions: riskCfg.maxOpenPositions, minSizeUsd: riskCfg.minSizeUsd },
      strategyId: signal.strategy_id,
      signalId: signal.id,
      riskDecisionId,
    }).catch(() => undefined);

    const amountUsd = assessment.finalSizeUsd;
    const finalCost = assessment.cost ?? costAt(amountUsd);
    // Re-check EV with the FINAL position size (costs depend on size)
    const finalEv = estimateExpectedValue({
      signal: stored,
      cost: finalCost,
      failureProbability: knobs.failureRate,
      minExpectedNetValue: minEv,
      dataConfidence: signal.data_confidence ?? 'LOW',
      lowConfidenceMultiplier: env.LOW_CONFIDENCE_EV_MULTIPLIER,
      calibration: lane === 'PRODUCTION' ? (evCalibrations.get(signal.strategy_id ?? '') ?? null) : null,
    });
    const evOk =
      lane === 'PRODUCTION'
        ? finalEv.passes
        : researchOnly
          ? olderLaneRejection({
              costRate: finalCost.totalCostRate,
              networkFeePriced: finalCost.networkFeePriced,
              maxRoundTripCostPct: env.OLDER_TOKEN_RESEARCH_MAX_ROUND_TRIP_COST_PCT,
              criticalDataOk: true,
              inCooldown: false,
            }) == null
          : finalEv.expectedNetValue != null &&
            finalCost.networkFeePriced &&
            finalEv.threshold - finalEv.expectedNetValue <= env.RESEARCH_MAX_EV_SHORTFALL;
    if (!evOk) {
      funnel.reject('evFailed');
      await markRiskExecution(riskDecisionId, 'EV_FAILED_AT_FINAL_SIZE', finalEv.reasons.join(','));
      if (attemptId) {
        await updateExecutionAttempt(attemptId, { status: 'EV_FAILED', statusReason: finalEv.reasons.join(',') || null });
      }
      await openShadowTrade({
        portfolioId,
        tokenId: signal.token_id,
        signalId: signal.id,
        strategyId: signal.strategy_id,
        rejectionReason: 'EXPECTED_VALUE_TOO_LOW',
        rejectionDetails: { ev: finalEv, stage: 'final_size', lane },
        cooldownSec: env.SHADOW_REENTRY_COOLDOWN_SECONDS,
        sim: { ...shadowSim, positionSizeUsd: amountUsd },
      });
      continue;
    }
    funnel.stage('riskPassed');
    funnel.stage('executionAttempted');

    // Realistic sim for audit trail (paper engine still uses base simulator for cash)
    const realistic = simulateRealisticTrade({
      side: 'BUY',
      requestedAmountUsd: amountUsd,
      midPriceUsd: market.price_usd,
      quote,
      gas,
      priorityFeeLamports: settings.priorityFeeLamports,
      failedTxStillChargesNetwork: settings.failedTxStillChargesNetwork,
      profile: exec.profile,
      rng,
      jitoTipLamports: exec.jitoTipLamports,
      quoteAgeMs,
    });

    if (realistic.execution.failed) {
      await logBotEvent({
        portfolioId,
        level: 'error',
        category: 'execution',
        message: `Realistic sim failure: ${realistic.failureMode}`,
        details: { latency: realistic.latency, failureMode: realistic.failureMode, lane },
      });
    }

    const result = await executePaperBuy({
      portfolioId,
      tokenId: signal.token_id,
      signalId: signal.id,
      amountUsd,
      midPriceUsd: market.price_usd,
      quote,
      gas,
      priorityFeeLamports: settings.priorityFeeLamports,
      failedTxStillChargesNetwork: settings.failedTxStillChargesNetwork,
      stopLossPct: settings.stopLossPct,
      takeProfitPct: settings.takeProfitPct,
      trailingStopPct: settings.trailingStopPct,
      risk: {
        maxOpenPositions: riskCfg.maxOpenPositions,
        maxPortfolioExposureUsd: riskCfg.maxPortfolioExposureUsd,
        maxStrategyExposureUsd: riskCfg.maxStrategyExposureUsd,
        strategyKey: signal.strategy_id,
        riskDecisionId,
        riskTier: assessment.riskTier,
        requestedSizeUsd: assessment.requestedSizeUsd,
        maxPlannedLossUsd: assessment.maximumPlannedLossUsd,
        expectedNetValue: finalEv.expectedNetValue,
      },
      entrySnapshot: {
        ...buildEntrySnapshot({
          signalMarketState: signal.market_state,
          signalAt: signal.created_at,
          signalOverallScore: Number(signal.overall_score),
          market,
          quoteAgeMs,
          regime: latestRegime,
          dataConfidence: signal.data_confidence,
          maxHoldSec: settings.maxHoldingTimeSec,
        }),
        ...(revalidation ? { strategyRevalidation: revalidation } : {}),
      },
    });

    if (attemptId) {
      await updateExecutionAttempt(attemptId, {
        status: result.success && result.orderId ? 'EXECUTED' : result.limitBlocked ? 'CAPACITY_BLOCKED' : 'EXECUTION_FAILED',
        statusReason: result.success ? null : (result.limitBlocked ?? result.reason ?? null),
        orderId: result.orderId ?? null,
        positionId: result.positionId ?? null,
      });
    }

    if (result.limitBlocked) {
      funnel.reject('riskFailed');
      funnel.riskReject(result.limitBlocked);
      await markRiskExecution(riskDecisionId, 'LIMIT_BLOCKED', result.limitBlocked);
      await auditRiskDecision({
        tokenId: signal.token_id,
        portfolioId,
        rejected: true,
        riskReason: result.limitBlocked,
        actual: { limitBlocked: result.limitBlocked, requestedSizeUsd: amountUsd },
        required: { maxOpenPositions: riskCfg.maxOpenPositions },
        features: {
          price: market.price_usd,
          marketCap: market.market_cap_usd,
          liquidity: market.liquidity_usd,
        },
        strategyId: signal.strategy_id,
        signalId: signal.id,
        riskDecisionId,
      }).catch(() => undefined);
      await auditFinalOutcome({
        tokenId: signal.token_id,
        portfolioId,
        traded: false,
        reasonCode: result.limitBlocked === 'maxOpenPositions' ? 'MAX_OPEN_POSITIONS' : 'INSUFFICIENT_CAPACITY',
        details: { limitBlocked: result.limitBlocked },
        strategyId: signal.strategy_id,
        signalId: signal.id,
        riskDecisionId,
      }).catch(() => undefined);
    } else if (result.success && result.orderId) {
      await markRiskExecution(riskDecisionId, 'EXECUTED', null, result.positionId ?? null);
      await auditFinalOutcome({
        tokenId: signal.token_id,
        portfolioId,
        traded: true,
        reasonCode: 'TRADED',
        details: {
          orderId: result.orderId,
          positionId: result.positionId,
          lane,
          signalAgeMs: Date.now() - signal.created_at.getTime(),
          strategyRevalidatedAt: revalidation?.at ?? null,
        },
        strategyId: signal.strategy_id,
        signalId: signal.id,
        riskDecisionId,
      }).catch(() => undefined);
      funnel.stage('executed');
      await query(
        `UPDATE paper_orders SET
          signal_ts = NOW() - ($2 || ' milliseconds')::interval,
          decision_ts = NOW() - ($3 || ' milliseconds')::interval,
          attempt_ts = NOW(),
          quote_ts = $4,
          confirm_ts = NOW(),
          latency_ms = $5,
          realism_profile = $6,
          fill_probability = $7,
          jito_tip_usd = $8,
          execution_model_version = $9,
          idempotency_key = $10
         WHERE id = $1`,
        [
          result.orderId,
          String(realistic.latency.signalToDecisionMs + realistic.latency.decisionToQuoteMs),
          String(realistic.latency.decisionToQuoteMs),
          market.observed_at,
          realistic.latency.totalMs,
          realistic.realismProfile,
          realistic.fillProbability,
          realistic.jitoTipUsd,
          EXECUTION_MODEL_VERSION,
          `signal:${signal.id}:${portfolioId}`,
        ],
      );
      if (result.positionId) {
        await query(
          `UPDATE positions SET
            journal = $2, strategy_version = $3, risk_version = 'risk-v2',
            execution_model_version = $4, safety_version = $5,
            market_regime = $6
           WHERE id = $1`,
          [
            result.positionId,
            JSON.stringify({
              entryReasons: [lane === 'RESEARCH' ? 'research_ev_within_shortfall' : 'signal_passed_ev_and_risk'],
              lane,
              ev: finalEv,
              safetyVersion: SAFETY_VERSION,
              risk: {
                decision: assessment.decision,
                tier: assessment.riskTier,
                multipliers: assessment.multipliers,
                requestedSizeUsd: assessment.requestedSizeUsd,
                finalSizeUsd: assessment.finalSizeUsd,
                bindingConstraint: assessment.bindingConstraint,
                maximumPlannedLossUsd: assessment.maximumPlannedLossUsd,
              },
              latency: realistic.latency,
            }),
            signal.strategy_version,
            EXECUTION_MODEL_VERSION,
            SAFETY_VERSION,
            latestRegime,
          ],
        );
      }
      await logBotEvent({
        portfolioId,
        level: 'info',
        category: 'execution',
        message: lane === 'RESEARCH' ? 'Research paper BUY executed' : 'Paper BUY executed',
        details: { ...result, lane, latencyMs: realistic.latency.totalMs },
      });
      if (lane === 'PRODUCTION') {
        publish('trade_opened', result);
        publish('portfolio_updated', await getPortfolio(portfolioId));
      }
    } else {
      funnel.reject('executionFailed');
      await markRiskExecution(riskDecisionId, 'EXECUTION_FAILED', result.reason ?? null);
      await logBotEvent({
        portfolioId,
        level: 'error',
        category: 'execution',
        message: `Paper BUY failed: ${result.reason}`,
        details: { ...result, lane },
      });
    }

    if (lane === 'PRODUCTION') {
      await evaluateCircuitBreakers({
        portfolioId,
        netPnlUsd: latest.totalPnlUsd,
        startingBalanceUsd: latest.startingBalanceUsd,
        recentSlippagePct: realistic.execution.slippagePct,
        providerOutages: 0,
        staleCritical: false,
      });
    }
  }
  await persist();
}

async function jobShadow(): Promise<void> {
  const portfolioId = await ensureDefaultPortfolio();
  const settings = await getPortfolioSettings(portfolioId);
  const gas: GasFeeEstimate = await providers.gasFee.getFeeEstimate();
  const res = await updateOpenShadowTrades({ gas, exec: execSettingsFrom(settings) });
  if (res.updated > 0 || res.closed > 0) publish('shadow_trade_updated', res);
}

async function jobOpportunityOutcomes(): Promise<void> {
  await processOpportunityOutcomes();
}

async function manageOpenPositions(portfolioId: string, settings: PortfolioSettings): Promise<void> {
  const { rows: positions } = await query<{
    id: string;
    token_id: string;
    entry_price_usd: string;
    highest_price_usd: string;
    stop_loss_pct: string;
    take_profit_pct: string;
    trailing_stop_pct: string | null;
    opened_at: Date;
    quantity: string;
    cost_basis_usd: string;
    mfe_pct: string | null;
    mae_pct: string | null;
  }>(`SELECT * FROM positions WHERE portfolio_id = $1 AND status = 'OPEN'`, [portfolioId]);
  if (positions.length === 0) return;

  const gas = await providers.gasFee.getFeeEstimate();
  const isProduction = portfolioId === env.DEFAULT_PORTFOLIO_ID;

  for (const pos of positions) {
    const market = await getLatestMarketByToken(pos.token_id);
    if (!market) continue;

    await markPositionMarkToMarket(pos.id, market.price_usd);
    const entry = Number(pos.entry_price_usd);
    const ret = entry > 0 ? (market.price_usd - entry) / entry : 0;
    const prevMfe = Number(pos.mfe_pct ?? 0);
    const prevMae = Number(pos.mae_pct ?? 0);
    const mfe = Math.max(prevMfe, ret * 100);
    const mae = Math.min(prevMae, ret * 100);
    await query(
      `UPDATE positions SET mfe_pct = $2, mae_pct = $3,
         mfe_at = CASE WHEN $4 THEN $6 ELSE mfe_at END,
         mae_at = CASE WHEN $5 THEN $6 ELSE mae_at END
       WHERE id = $1`,
      [pos.id, mfe, mae, mfe > prevMfe, mae < prevMae, market.observed_at],
    );

    const costBasis = Number(pos.cost_basis_usd);
    const unrealizedPnlUsd = Number(pos.quantity) * market.price_usd - costBasis;
    if (isProduction) {
      publish('position_updated', {
        positionId: pos.id,
        tokenId: pos.token_id,
        price: market.price_usd,
        priceUsd: market.price_usd,
        observedAt: market.observed_at.toISOString(),
        highestPriceUsd: Math.max(Number(pos.highest_price_usd), market.price_usd),
        unrealizedPnlUsd,
        unrealizedPnlPct: costBasis > 0 ? (unrealizedPnlUsd / costBasis) * 100 : 0,
      });
    }

    const marketStale =
      market.stale || Date.now() - market.observed_at.getTime() > getStalePriceMaxAgeMs();

    // LIQUIDITY_EMERGENCY can override price exits (already first in evaluateExitRules).
    // Unknown liquidity is not treated as collapse (it is not evidence of zero).
    const decision = evaluateExitRules({
      entryPriceUsd: Number(pos.entry_price_usd),
      markPriceUsd: market.price_usd,
      highestPriceUsd: Number(pos.highest_price_usd),
      stopLossPct: Number(pos.stop_loss_pct),
      takeProfitPct: Number(pos.take_profit_pct),
      trailingStopPct: pos.trailing_stop_pct != null ? Number(pos.trailing_stop_pct) : null,
      openedAt: pos.opened_at,
      now: new Date(),
      maxHoldingTimeSec: settings.maxHoldingTimeSec,
      liquidityUsd: market.liquidity_status === 'KNOWN' ? market.liquidity_usd : Number.POSITIVE_INFINITY,
      minLiquidityUsd: settings.minLiquidityUsd,
      marketStale,
    });

    if (decision.deferredDueToStale) continue;
    const closeReason = decision.closeReason;
    if (!closeReason) continue;

    if (closeReason !== 'emergency_liquidity_collapse' && !isGasUsableForTrading(gas)) continue;

    if (closeReason === 'emergency_liquidity_collapse') {
      await query(`UPDATE positions SET exit_state = 'LIQUIDITY_EMERGENCY' WHERE id = $1`, [pos.id]);
      await sendAlert({
        severity: 'error',
        title: 'Liquidity emergency exit',
        body: `Position ${pos.id} exiting due to liquidity collapse`,
        cooldownKey: `liq-emergency:${pos.id}`,
      });
    }

    const result = await executePaperSell({
      portfolioId,
      positionId: pos.id,
      midPriceUsd: decision.exitMidPriceUsd,
      quote: quoteFromMarket(market, decision.exitMidPriceUsd),
      gas,
      priorityFeeLamports: settings.priorityFeeLamports,
      failedTxStillChargesNetwork: settings.failedTxStillChargesNetwork,
      closeReason,
    });

    if (result.success) {
      const finalReason = result.closeReason ?? closeReason;
      try {
        await recordTradeObservation(pos.id);
      } catch (err) {
        logger.warn({ err, positionId: pos.id }, 'Trade observation deferred to the learning job');
      }
      await logBotEvent({
        portfolioId,
        level: 'info',
        category: 'execution',
        message: `Paper SELL executed (${finalReason})`,
        details: result,
      });
      if (isProduction) {
        publish('trade_closed', { ...result, positionId: pos.id, closeReason: finalReason });
        publish('portfolio_updated', await getPortfolio(portfolioId));
      }
    }
  }
}

async function valuePortfolio(portfolioId: string): Promise<void> {
  const portfolio = await getPortfolio(portfolioId);
  if (!portfolio) return;

  const peak = Math.max(portfolio.peakEquityUsd, portfolio.equityUsd);
  const dd = computeDrawdownPct(peak, portfolio.equityUsd);
  const maxDd = Math.max(portfolio.maxDrawdownPct / 100, dd);

  const settings = await getPortfolioSettings(portfolioId);
  const risk = evaluateRisk({
    equityUsd: portfolio.equityUsd,
    cashUsd: portfolio.cashUsd,
    openPositions: portfolio.openPositions,
    startingBalanceUsd: portfolio.startingBalanceUsd,
    peakEquityUsd: peak,
    realizedPnlTodayUsd: 0,
    proposedSizeUsd: 1,
    stopLossPct: settings.stopLossPct,
    settings,
    currentRiskState: portfolio.riskState,
    killSwitchActive: await isKillSwitchActive(portfolioId),
  });
  await setRiskState(portfolioId, risk.riskState);

  await query(
    `UPDATE user_portfolios SET peak_equity_usd = $2, max_drawdown_pct = $3, updated_at = NOW() WHERE id = $1`,
    [portfolioId, peak, maxDd],
  );

  await query(
    `INSERT INTO portfolio_snapshots (
      portfolio_id, equity_usd, cash_usd, invested_value_usd, unrealized_pnl_usd, realized_pnl_usd, data_mode
    ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      portfolioId,
      portfolio.equityUsd,
      portfolio.cashUsd,
      portfolio.investedValueUsd,
      portfolio.unrealizedPnlUsd,
      portfolio.realizedPnlUsd,
      dataMode,
    ],
  );
}

async function jobPortfolioValuation(): Promise<void> {
  const portfolioId = await ensureDefaultPortfolio();
  await valuePortfolio(portfolioId);
  publish('portfolio_updated', await getPortfolio(portfolioId));
  if (env.RESEARCH_EXPLORATION_ENABLED) await valuePortfolio(await ensureResearchPortfolio());
}

async function jobAnalytics(): Promise<void> {
  const portfolioId = await ensureDefaultPortfolio();
  await logBotEvent({
    portfolioId,
    level: 'info',
    category: 'analytics',
    message: 'Analytics aggregation tick',
    details: getRuntimeBotStats(),
  });
  await query(
    `INSERT INTO system_health (component, status, metrics) VALUES ('worker', 'ok', $1)`,
    [JSON.stringify(getRuntimeBotStats())],
  );
}

async function jobDailyReport(): Promise<void> {
  await runDailyReportIfDue(await ensureDefaultPortfolio());
}

/** Level 1 safety net (observations missed at close) + Level 2 health check every N observations. */
async function jobLearning(): Promise<void> {
  await recordMissingObservations();
  const outcome = await runHealthCheckIfDue(await ensureDefaultPortfolio());
  if (outcome) {
    logger.info(
      {
        healthCheckId: outcome.id,
        newObservations: outcome.newObservations,
        anomalies: outcome.result.anomalies.length,
        emitted: outcome.emitted.length,
        protection: outcome.protectionAction,
      },
      'Learning health check completed',
    );
  }
}

export function registerAllJobs(): void {
  const intervals = defaultIntervals();
  registerJob('token_discovery', intervals.token_discovery, jobTokenDiscovery);
  registerJob('market_data', intervals.market_data, jobMarketData);
  registerJob('lifecycle', intervals.lifecycle, jobLifecycle);
  registerJob('trade_stream', intervals.trade_stream, jobTradeStream);
  registerJob('onchain', intervals.onchain, jobOnchain);
  registerJob('safety', intervals.safety, jobSafety);
  registerJob('regime', intervals.regime, jobRegime);
  registerJob('signal', intervals.signal, jobSignals);
  registerJob('paper_execution', intervals.paper_execution, jobPaperExecution);
  registerJob('shadow', intervals.shadow, jobShadow);
  registerJob('opportunity_outcomes', intervals.opportunity_outcomes, jobOpportunityOutcomes);
  registerJob('portfolio_valuation', intervals.portfolio_valuation, jobPortfolioValuation);
  registerJob('analytics', intervals.analytics, jobAnalytics);
  registerJob('daily_report', intervals.daily_report, jobDailyReport);
  registerJob('learning', intervals.learning, jobLearning);
  registerJob('outcome_checkpoints', intervals.outcome_checkpoints, async () => {
    await captureDueOutcomeCheckpoints();
  });
  registerJob('storage_monitor', intervals.storage_monitor, async () => {
    await snapshotStorageMonitor();
  });
  registerJob('storage_guard', intervals.storage_guard, async () => {
    const m = await refreshStorageState();
    if (stateRank(m.state) >= stateRank('AGGRESSIVE_CLEANUP')) {
      await pruneOldData(new Date(), m.state);
      const after = await refreshStorageState();
      if (stateRank(after.state) >= stateRank('EMERGENCY_CLEANUP')) {
        await compactTables({ tables: AUTO_COMPACT_TABLES, lockTimeoutMs: 1_000 });
        await refreshStorageState();
      }
    }
  });
  registerJob('retention', intervals.retention, async () => {
    await refreshStorageState();
    await pruneOldData();
  });
}

export { startJobs, stopJobs, providers };
