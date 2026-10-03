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
  listActiveTokenIds,
  getLatestMarketByToken,
  getPriorVolume5m,
  getLatestHolders,
  logBotEvent,
  effectiveAgeMinutes,
} from '../services/token-service.js';
import {
  ensureDefaultPortfolio,
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
import { publish } from '../ws/hub.js';
import { runDailyReportIfDue } from '../services/report-service.js';
import { registerJob, defaultIntervals, startJobs, stopJobs } from './scheduler.js';
import type { MarketQuote } from '../providers/types.js';
import {
  assessSafety,
  demoSafetyFromSymbol,
  SAFETY_VERSION,
} from '../safety/engine.js';
import {
  approximateTradesFromSnapshot,
  computeFlowFeatures,
} from '../features/flow.js';
import { detectRegime } from '../features/regime.js';
import { detectTokenPhase } from '../features/lifecycle.js';
import {
  activeStrategies,
  createStrategyCatalog,
  evaluateAllStrategies,
} from '../strategies/catalog.js';
import type { StrategyContext } from '../strategies/types.js';
import { estimateExpectedValue } from '../risk/expected-value.js';
import { computePositionSize } from '../risk/sizing.js';
import {
  estimateRoundTripCostPct,
  simulateRealisticTrade,
  EXECUTION_MODEL_VERSION,
} from '../execution/realism.js';
import { SeededRng } from '../domain/seeded-rng.js';
import {
  openShadowTrade,
  updateOpenShadowTrades,
  recordMissedOpportunity,
} from '../research/shadow.js';
import {
  isKillSwitchActive,
  evaluateCircuitBreakers,
} from '../monitoring/kill-switch.js';
import { sendAlert } from '../monitoring/alerts.js';
import { toMeasuredJson } from '../domain/measured.js';
import type { MarketRegime, RejectionReason } from '@memebot/shared';

const providers = createProviders();
const discovery = createDiscoveryProviders(dataMode);
const strategyCatalog = createStrategyCatalog();
const rng = new SeededRng(env.REPLAY_SEED);

let lastScanAt: Date | null = null;
let tokensScanned = 0;
let signalsGenerated = 0;
let latestRegime: MarketRegime | null = null;

export function getRuntimeBotStats() {
  return { lastScanAt, tokensScanned, signalsGenerated, latestRegime };
}

async function jobTokenDiscovery(): Promise<void> {
  const portfolioId = await ensureDefaultPortfolio();
  await discovery.subscribe();
  const discovered = await discovery.getRecentTokens();
  for (const token of discovered) {
    const existing = await query(
      `SELECT id FROM tokens WHERE chain = $1 AND address = $2 AND data_mode = $3`,
      [token.chain, token.address, dataMode],
    );
    const id = await upsertDiscoveredToken(token);
    if (id && existing.rows.length === 0) {
      await query(
        `INSERT INTO market_events (token_id, event_type, payload, observed_at, source, data_mode)
         VALUES ($1,'TOKEN_DISCOVERED',$2,NOW(),$3,$4)`,
        [
          id,
          JSON.stringify({
            discoverySource: token.discoverySource,
            symbol: token.symbol,
            paidBoost: token.discoverySource === 'DEXSCREENER_BOOST',
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
          paidBoost: token.discoverySource === 'DEXSCREENER_BOOST',
        },
      });
      publish('token_discovered', {
        tokenId: id,
        symbol: token.symbol,
        address: token.address,
        discoverySource: token.discoverySource,
      });
    }
  }
  lastScanAt = new Date();
}

async function jobMarketData(): Promise<void> {
  const tokens = await listActiveTokenIds(50);
  if (tokens.length === 0) return;
  const quotes = await providers.marketData.getMarketQuotes(tokens.map((t) => t.address));
  const byAddr = new Map(quotes.map((q) => [q.address, q]));
  tokensScanned = tokens.length;

  for (const token of tokens) {
    const quote = byAddr.get(token.address);
    if (!quote) {
      await logBotEvent({
        level: 'warn',
        category: 'market_data',
        message: `Missing market data for ${token.symbol}`,
        details: { address: token.address },
      });
      continue;
    }
    const age = Date.now() - quote.observedAt.getTime();
    const stale = age > getStalePriceMaxAgeMs();
    await insertMarketSnapshot(token.id, quote, stale);

    // Lifecycle timestamp updates
    if (quote.liquidityUsd > 0) {
      await query(
        `UPDATE tokens SET
          first_liquidity_at = COALESCE(first_liquidity_at, $2),
          first_trade_at = COALESCE(first_trade_at, $2),
          first_meaningful_volume_at = CASE
            WHEN first_meaningful_volume_at IS NULL AND $3 >= 1000 THEN $2
            ELSE first_meaningful_volume_at
          END
         WHERE id = $1`,
        [token.id, quote.observedAt, quote.volume5mUsd],
      );
    }
  }
  publish('scanner_updated', { count: quotes.length });
}

/** Event-driven trade stream (demo synthesis + polling reconciliation). */
async function jobTradeStream(): Promise<void> {
  const tokens = await listActiveTokenIds(30);
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
  const tokens = await listActiveTokenIds(20);
  for (const token of tokens) {
    try {
      const data = await providers.onChain.getHolderData(token.address);
      if (data) await insertHolderSnapshot(token.id, data);
    } catch (err) {
      logger.warn({ err, token: token.symbol }, 'On-chain update failed');
    }
  }
}

async function jobSafety(): Promise<void> {
  const tokens = await listActiveTokenIds(40);
  for (const token of tokens) {
    const market = await getLatestMarketByToken(token.id);
    if (!market) continue;
    const holders = await getLatestHolders(token.id);
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
    const result = assessSafety(input);
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
  const tokens = await listActiveTokenIds(50);
  let totalVol = 0;
  let totalBuy = 0;
  let totalSell = 0;
  let liqSum = 0;
  let n = 0;
  for (const token of tokens) {
    const m = await getLatestMarketByToken(token.id);
    if (!m) continue;
    totalVol += m.volume_5m_usd;
    totalBuy += m.buy_volume_5m_usd;
    totalSell += m.sell_volume_5m_usd;
    liqSum += m.liquidity_usd;
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
    avgLiquidityUsd: n > 0 ? liqSum / n : null,
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

async function latestSafety(tokenId: string) {
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
  };
}

async function jobSignals(): Promise<void> {
  const portfolioId = await ensureDefaultPortfolio();
  if (await isKillSwitchActive(portfolioId)) {
    await logBotEvent({
      portfolioId,
      level: 'warn',
      category: 'kill_switch',
      message: 'Kill switch active — skipping new signals',
    });
    return;
  }

  const settings = await getPortfolioSettings(portfolioId);
  const tokens = await listActiveTokenIds(50);
  const strategies = activeStrategies(strategyCatalog, settings.activeStrategyIds);
  let generated = 0;

  const runId = (
    await query<{ id: string }>(
      `INSERT INTO strategy_runs (strategy_name, strategy_version, portfolio_id, data_mode, started_at)
       VALUES ($1,$2,$3,$4,NOW()) RETURNING id`,
      ['multi-strategy', 'framework-v1', portfolioId, dataMode],
    )
  ).rows[0]!.id;

  const { rows: tokMeta } = await query<{
    id: string;
    address: string;
    symbol: string;
    chain: string;
    created_at_onchain: Date | null;
    discovered_at: Date;
    first_liquidity_at: Date | null;
    first_observed_at: Date | null;
    discovery_source: string;
  }>(
    `SELECT id, address, symbol, chain, created_at_onchain, discovered_at,
            first_liquidity_at, first_observed_at, discovery_source
     FROM tokens WHERE data_mode = $1 ORDER BY discovered_at DESC LIMIT 50`,
    [dataMode],
  );
  const metaById = new Map(tokMeta.map((t) => [t.id, t]));

  for (const token of tokens) {
    const market = await getLatestMarketByToken(token.id);
    if (!market) continue;
    if (market.stale) {
      await logBotEvent({
        portfolioId,
        level: 'warn',
        category: 'signal',
        message: `Stale price — skip signal for ${token.symbol}`,
      });
      continue;
    }

    const holders = await getLatestHolders(token.id);
    const priorVol = await getPriorVolume5m(token.id, market.observed_at);
    const meta = metaById.get(token.id);
    const ageMinutes = meta
      ? effectiveAgeMinutes(meta)
      : (Date.now() - token.discovered_at.getTime()) / 60_000;

    const ticks = approximateTradesFromSnapshot({
      buyVolume5mUsd: market.buy_volume_5m_usd,
      sellVolume5mUsd: market.sell_volume_5m_usd,
      txCount5m: market.tx_count_5m,
      priceUsd: market.price_usd,
      observedAt: market.observed_at,
    });
    const flow = computeFlowFeatures(ticks);
    const safety = (await latestSafety(token.id)) ??
      assessSafety(
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
            },
      );

    // Safety BEFORE strategy tradability
    if (safety.blocked) {
      await openShadowTrade({
        portfolioId,
        tokenId: token.id,
        rejectionReason: 'SAFETY_REJECTION',
        rejectionDetails: { reasons: safety.reasons, class: safety.safetyClass },
        entryPriceUsd: market.price_usd,
        sizeUsd: null,
        costUsd: null,
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

    const accel =
      priorVol && priorVol > 0
        ? market.volume_5m_usd / priorVol
        : market.volume_1h_usd > 0
          ? (market.volume_5m_usd * 12) / market.volume_1h_usd
          : 1;
    const phase = detectTokenPhase({
      ageMinutes,
      priceChange2mPct: market.price_change_5m_pct,
      priceChange5mPct: market.price_change_5m_pct,
      priceChange1hPct: market.price_change_1h_pct,
      volumeAcceleration: accel,
      liquidityUsd: market.liquidity_usd,
      liquidityChangePct: null,
      uniqueBuyers5m: flow['5m']?.uniqueBuyers.value ?? null,
      uniqueSellers5m: flow['5m']?.uniqueSellers.value ?? null,
      netFlow5mUsd: flow['5m']?.netFlowUsd.value ?? null,
      holderGrowthPct: null,
      largeWalletSellPct: null,
      volatility5mPct: Math.abs(market.price_change_5m_pct),
    });
    await query(
      `INSERT INTO token_phases (token_id, phase, reasons, data_mode) VALUES ($1,$2,$3,$4)`,
      [token.id, phase.phase, JSON.stringify(phase.reasons), dataMode],
    );

    const ctx: StrategyContext = {
      tokenId: token.id,
      address: token.address,
      symbol: token.symbol,
      chain: token.chain,
      ageMinutes,
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
      priorVolume5mUsd: priorVol,
      flow,
      safety,
      regime: latestRegime ?? undefined,
      phase: phase.phase,
      buySellConfidence: 'LOW',
      discoverySource: meta?.discovery_source,
    };

    const { best, all } = evaluateAllStrategies(strategies, ctx);

    // Shadow every rejection meeting basic discovery criteria
    for (const sig of all) {
      if (sig.action === 'NO_TRADE' && market.liquidity_usd >= 1000) {
        await openShadowTrade({
          portfolioId,
          tokenId: token.id,
          strategyId: sig.strategyId,
          rejectionReason: (sig.rejectionReason ?? 'UNKNOWN') as RejectionReason,
          rejectionDetails: { reasons: sig.reasons },
          entryPriceUsd: market.price_usd,
          sizeUsd: null,
          costUsd: estimateRoundTripCostPct({
            liquidityUsd: market.liquidity_usd,
            tradeUsd: 5,
            venue: market.venue,
          }),
        });
      }
    }

    if (!best) continue;

    const costPct = estimateRoundTripCostPct({
      liquidityUsd: market.liquidity_usd,
      tradeUsd: 5,
      venue: market.venue,
    });
    const ev = estimateExpectedValue({
      signal: best,
      estimatedExecutionCostPct: costPct,
      failureProbability: realismProfile === 'CONSERVATIVE' ? 0.18 : 0.08,
      minExpectedNetValue: settings.minExpectedNetValue ?? env.MIN_EXPECTED_NET_VALUE,
      dataConfidence: 'LOW',
    });

    if (!ev.passes) {
      await openShadowTrade({
        portfolioId,
        tokenId: token.id,
        strategyId: best.strategyId,
        rejectionReason: 'EXPECTED_VALUE_TOO_LOW',
        rejectionDetails: { ev, reasons: best.reasons },
        entryPriceUsd: market.price_usd,
        sizeUsd: 5,
        costUsd: costPct * 5,
      });
      await recordMissedOpportunity({
        portfolioId,
        tokenId: token.id,
        rejectionReason: 'EXPECTED_VALUE_TOO_LOW',
        filterName: 'expected_value',
        evidence: { ev },
      });
      continue;
    }

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
        action, confidence, expected_value, strategy_id
      ) VALUES ($1,$2,$3,'BUY',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'BUY',$14,$15,$16)
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
        JSON.stringify({ reasons: best.reasons, warnings: [], factors: { ev } }),
        JSON.stringify({
          ...ctx,
          flow: undefined,
          safety: { score: safety.score, class: safety.safetyClass, reasons: safety.reasons },
          phase: phase.phase,
          regime: latestRegime,
        }),
        dataMode,
        best.confidence,
        JSON.stringify(ev),
        best.strategyId,
      ],
    );

    generated++;
    signalsGenerated++;
    await logBotEvent({
      portfolioId,
      level: 'info',
      category: 'signal',
      message: `Signal ${best.strategyId} for ${token.symbol}`,
      details: {
        signalId: rows[0]!.id,
        confidence: best.confidence,
        expectedNetValue: ev.expectedNetValue,
        disclaimer: 'Model score, not a probability of profit',
      },
    });
    publish('signal_generated', {
      signalId: rows[0]!.id,
      tokenId: token.id,
      symbol: token.symbol,
      strategyId: best.strategyId,
      confidence: best.confidence,
      scores,
    });
  }

  await query(
    `UPDATE strategy_runs SET finished_at = NOW(), tokens_evaluated = $2, signals_generated = $3 WHERE id = $1`,
    [runId, tokens.length, generated],
  );
}

async function jobPaperExecution(): Promise<void> {
  const portfolioId = await ensureDefaultPortfolio();
  const portfolio = await getPortfolio(portfolioId);
  if (!portfolio) return;
  const settings = await getPortfolioSettings(portfolioId);

  await manageOpenPositions(portfolioId, settings);

  if (portfolio.botStatus === 'KILLED' || (await isKillSwitchActive(portfolioId))) {
    return;
  }
  if (portfolio.botStatus !== 'RUNNING') return;

  const { rows: signals } = await query<{
    id: string;
    token_id: string;
    overall_score: string;
    confidence: string | null;
    expected_value: unknown;
    strategy_id: string | null;
    strategy_version: string;
  }>(
    `SELECT s.id, s.token_id, s.overall_score, s.confidence, s.expected_value,
            s.strategy_id, s.strategy_version
     FROM signals s
     WHERE s.data_mode = $1
       AND s.side = 'BUY'
       AND s.created_at > NOW() - INTERVAL '10 minutes'
       AND NOT EXISTS (
         SELECT 1 FROM paper_orders o WHERE o.signal_id = s.id AND o.portfolio_id = $2
       )
       AND NOT EXISTS (
         SELECT 1 FROM positions p WHERE p.token_id = s.token_id AND p.portfolio_id = $2 AND p.status = 'OPEN'
       )
     ORDER BY COALESCE(s.confidence, s.overall_score) DESC
     LIMIT 5`,
    [dataMode, portfolioId],
  );

  const gas = await providers.gasFee.getFeeEstimate();
  if (!isGasUsableForTrading(gas)) {
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

  const dayPnl = await query<{ pnl: string }>(
    `SELECT COALESCE(SUM(realized_pnl_usd),0) AS pnl FROM positions
     WHERE portfolio_id = $1 AND closed_at >= date_trunc('day', NOW())`,
    [portfolioId],
  );

  for (const signal of signals) {
    const latest = await getPortfolio(portfolioId);
    if (!latest || latest.botStatus !== 'RUNNING') break;

    // Per-signal duplicate check (fixes race across loop iterations)
    const openDup = await query(
      `SELECT id FROM positions WHERE portfolio_id = $1 AND token_id = $2 AND status = 'OPEN'`,
      [portfolioId, signal.token_id],
    );
    if (openDup.rows.length > 0) {
      await openShadowTrade({
        portfolioId,
        tokenId: signal.token_id,
        signalId: signal.id,
        rejectionReason: 'DUPLICATE_POSITION',
        entryPriceUsd: null,
        sizeUsd: null,
        costUsd: null,
      });
      continue;
    }

    const market = await getLatestMarketByToken(signal.token_id);
    if (!market) continue;
    if (market.stale || Date.now() - market.observed_at.getTime() > getStalePriceMaxAgeMs()) {
      await logBotEvent({
        portfolioId,
        level: 'warn',
        category: 'execution',
        message: "Stale price — don't trade",
        details: { tokenId: signal.token_id },
      });
      await openShadowTrade({
        portfolioId,
        tokenId: signal.token_id,
        signalId: signal.id,
        rejectionReason: 'STALE_DATA',
        entryPriceUsd: market.price_usd,
        sizeUsd: null,
        costUsd: null,
      });
      continue;
    }
    if (market.liquidity_usd <= 0) continue;

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
    await query(
      `UPDATE user_portfolios SET risk_state_changed_at = NOW() WHERE id = $1`,
      [portfolioId],
    );

    if (!risk.allowed) {
      const reason: RejectionReason =
        risk.riskState === 'HALTED' ? 'RISK_LIMIT' : 'RISK_LIMIT';
      await openShadowTrade({
        portfolioId,
        tokenId: signal.token_id,
        signalId: signal.id,
        rejectionReason: reason,
        rejectionDetails: { ...risk },
        entryPriceUsd: market.price_usd,
        sizeUsd: null,
        costUsd: null,
      });
      continue;
    }

    const exposurePct =
      latest.equityUsd > 0 ? latest.investedValueUsd / latest.equityUsd : 0;
    const sizing = computePositionSize({
      equityUsd: latest.equityUsd,
      cashUsd: latest.cashUsd,
      maxPositionPct: settings.maxPositionPct,
      maxRiskPerTradePct: settings.maxRiskPerTradePct,
      stopLossPct: settings.stopLossPct,
      confidence: Number(signal.confidence ?? signal.overall_score),
      liquidityUsd: market.liquidity_usd,
      volatilityPct: Math.abs(market.price_change_5m_pct),
      regime: latestRegime,
      phase: null,
      portfolioExposurePct: exposurePct,
      maxPortfolioExposurePct: 0.5,
      priceImpactPct: (risk.sizedAmountUsd / Math.max(market.liquidity_usd, 1)) * 100,
      expectedNetValue:
        signal.expected_value && typeof signal.expected_value === 'object'
          ? ((signal.expected_value as { expectedNetValue?: number }).expectedNetValue ?? null)
          : null,
      riskStateSizeMult: risk.sizeMultiplier,
    });

    const amountUsd = Math.min(risk.sizedAmountUsd, sizing.sizedAmountUsd);
    if (amountUsd < 1) continue;

    const quote: MarketQuote = {
      chain: 'solana',
      address: '',
      priceUsd: market.price_usd,
      marketCapUsd: market.market_cap_usd,
      volume5mUsd: market.volume_5m_usd,
      volume1hUsd: market.volume_1h_usd,
      volume24hUsd: 0,
      buyVolume5mUsd: market.buy_volume_5m_usd,
      sellVolume5mUsd: market.sell_volume_5m_usd,
      txCount5m: market.tx_count_5m,
      priceChange5mPct: market.price_change_5m_pct,
      priceChange1hPct: market.price_change_1h_pct,
      liquidityUsd: market.liquidity_usd,
      observedAt: market.observed_at,
      poolAddress: market.pool_address,
      venue: market.venue,
      feeBps: market.fee_bps,
      baseReserve: market.base_reserve,
      quoteReserve: market.quote_reserve,
    };

    // Realistic sim for audit trail (paper engine still uses base simulator for cash)
    const realistic = simulateRealisticTrade({
      side: 'BUY',
      requestedAmountUsd: amountUsd,
      midPriceUsd: market.price_usd,
      quote,
      gas,
      priorityFeeLamports: settings.priorityFeeLamports,
      failedTxStillChargesNetwork: settings.failedTxStillChargesNetwork,
      profile: settings.realismProfile ?? realismProfile,
      rng,
      jitoTipLamports: settings.jitoTipLamports ?? env.DEFAULT_JITO_TIP_LAMPORTS,
      quoteAgeMs: Date.now() - market.observed_at.getTime(),
    });

    if (realistic.execution.failed) {
      await logBotEvent({
        portfolioId,
        level: 'error',
        category: 'execution',
        message: `Realistic sim failure: ${realistic.failureMode}`,
        details: { latency: realistic.latency, failureMode: realistic.failureMode },
      });
      // Still attempt paper path with force via normal engine — charge failed-tx costs
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
    });

    if (result.success && result.orderId) {
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
          `signal:${signal.id}`,
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
              entryReasons: ['signal_passed_ev_and_risk'],
              safetyVersion: SAFETY_VERSION,
              sizing: sizing.multipliers,
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
        message: 'Paper BUY executed',
        details: { ...result, latencyMs: realistic.latency.totalMs },
      });
      publish('trade_opened', result);
      publish('portfolio_updated', await getPortfolio(portfolioId));
    } else {
      await logBotEvent({
        portfolioId,
        level: 'error',
        category: 'execution',
        message: `Paper BUY failed: ${result.reason}`,
        details: result,
      });
    }

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

async function jobShadow(): Promise<void> {
  const portfolioId = await ensureDefaultPortfolio();
  const tokens = await listActiveTokenIds(50);
  const priceByToken = new Map<string, { priceUsd: number; liquidityUsd: number }>();
  for (const t of tokens) {
    const m = await getLatestMarketByToken(t.id);
    if (m) priceByToken.set(t.id, { priceUsd: m.price_usd, liquidityUsd: m.liquidity_usd });
  }
  const n = await updateOpenShadowTrades(portfolioId, priceByToken);
  if (n > 0) publish('shadow_trade_updated', { updated: n });
}

async function manageOpenPositions(
  portfolioId: string,
  settings: Awaited<ReturnType<typeof getPortfolioSettings>>,
): Promise<void> {
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
  }>(
    `SELECT * FROM positions WHERE portfolio_id = $1 AND status = 'OPEN'`,
    [portfolioId],
  );

  const gas = await providers.gasFee.getFeeEstimate();

  for (const pos of positions) {
    const market = await getLatestMarketByToken(pos.token_id);
    if (!market) continue;

    await markPositionMarkToMarket(pos.id, market.price_usd);
    const entry = Number(pos.entry_price_usd);
    const ret = entry > 0 ? (market.price_usd - entry) / entry : 0;
    const mfe = Math.max(Number(pos.mfe_pct ?? 0), ret * 100);
    const mae = Math.min(Number(pos.mae_pct ?? 0), ret * 100);
    await query(`UPDATE positions SET mfe_pct = $2, mae_pct = $3 WHERE id = $1`, [
      pos.id,
      mfe,
      mae,
    ]);

    const costBasis = Number(pos.cost_basis_usd);
    const unrealizedPnlUsd = Number(pos.quantity) * market.price_usd - costBasis;
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

    const marketStale =
      market.stale ||
      Date.now() - market.observed_at.getTime() > getStalePriceMaxAgeMs();

    // LIQUIDITY_EMERGENCY can override price exits (already first in evaluateExitRules)
    const decision = evaluateExitRules({
      entryPriceUsd: Number(pos.entry_price_usd),
      markPriceUsd: market.price_usd,
      highestPriceUsd: Number(pos.highest_price_usd),
      stopLossPct: Number(pos.stop_loss_pct),
      takeProfitPct: Number(pos.take_profit_pct),
      trailingStopPct:
        pos.trailing_stop_pct != null ? Number(pos.trailing_stop_pct) : null,
      openedAt: pos.opened_at,
      now: new Date(),
      maxHoldingTimeSec: settings.maxHoldingTimeSec,
      liquidityUsd: market.liquidity_usd,
      minLiquidityUsd: settings.minLiquidityUsd,
      marketStale,
    });

    if (decision.deferredDueToStale) continue;
    const closeReason = decision.closeReason;
    if (!closeReason) continue;

    if (
      closeReason !== 'emergency_liquidity_collapse' &&
      !isGasUsableForTrading(gas)
    ) {
      continue;
    }

    if (closeReason === 'emergency_liquidity_collapse') {
      await query(`UPDATE positions SET exit_state = 'LIQUIDITY_EMERGENCY' WHERE id = $1`, [
        pos.id,
      ]);
      await sendAlert({
        severity: 'error',
        title: 'Liquidity emergency exit',
        body: `Position ${pos.id} exiting due to liquidity collapse`,
        cooldownKey: `liq-emergency:${pos.id}`,
      });
    }

    const quote: MarketQuote = {
      chain: 'solana',
      address: '',
      priceUsd: decision.exitMidPriceUsd,
      marketCapUsd: market.market_cap_usd,
      volume5mUsd: market.volume_5m_usd,
      volume1hUsd: market.volume_1h_usd,
      volume24hUsd: 0,
      buyVolume5mUsd: market.buy_volume_5m_usd,
      sellVolume5mUsd: market.sell_volume_5m_usd,
      txCount5m: market.tx_count_5m,
      priceChange5mPct: market.price_change_5m_pct,
      priceChange1hPct: market.price_change_1h_pct,
      liquidityUsd: market.liquidity_usd,
      observedAt: market.observed_at,
      poolAddress: market.pool_address,
      venue: market.venue,
      feeBps: market.fee_bps,
      baseReserve: market.base_reserve,
      quoteReserve: market.quote_reserve,
    };

    const result = await executePaperSell({
      portfolioId,
      positionId: pos.id,
      midPriceUsd: decision.exitMidPriceUsd,
      quote,
      gas,
      priorityFeeLamports: settings.priorityFeeLamports,
      failedTxStillChargesNetwork: settings.failedTxStillChargesNetwork,
      closeReason,
    });

    if (result.success) {
      await logBotEvent({
        portfolioId,
        level: 'info',
        category: 'execution',
        message: `Paper SELL executed (${closeReason})`,
        details: result,
      });
      publish('trade_closed', { ...result, positionId: pos.id, closeReason });
      publish('portfolio_updated', await getPortfolio(portfolioId));
    }
  }
}

async function jobPortfolioValuation(): Promise<void> {
  const portfolioId = await ensureDefaultPortfolio();
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

  publish('portfolio_updated', await getPortfolio(portfolioId));
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

export function registerAllJobs(): void {
  const intervals = defaultIntervals();
  registerJob('token_discovery', intervals.token_discovery, jobTokenDiscovery);
  registerJob('market_data', intervals.market_data, jobMarketData);
  registerJob('trade_stream', intervals.trade_stream, jobTradeStream);
  registerJob('onchain', intervals.onchain, jobOnchain);
  registerJob('safety', intervals.safety, jobSafety);
  registerJob('regime', intervals.regime, jobRegime);
  registerJob('signal', intervals.signal, jobSignals);
  registerJob('paper_execution', intervals.paper_execution, jobPaperExecution);
  registerJob('shadow', intervals.shadow, jobShadow);
  registerJob('portfolio_valuation', intervals.portfolio_valuation, jobPortfolioValuation);
  registerJob('analytics', intervals.analytics, jobAnalytics);
  registerJob('daily_report', intervals.daily_report, jobDailyReport);
}

export { startJobs, stopJobs, providers };
