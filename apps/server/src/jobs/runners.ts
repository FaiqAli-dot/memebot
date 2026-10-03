import {
  createProviders,
  getStalePriceMaxAgeMs,
  isGasUsableForTrading,
} from '../providers/index.js';
import { dataMode } from '../config/env.js';
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
} from '../services/token-service.js';
import {
  ensureDefaultPortfolio,
  getPortfolio,
  getPortfolioSettings,
  setRiskState,
} from '../services/portfolio-service.js';
import { MomentumStrategyV1 } from '../engines/strategy/momentum-v1.js';
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

const strategy = new MomentumStrategyV1();
const providers = createProviders();

let lastScanAt: Date | null = null;
let tokensScanned = 0;
let signalsGenerated = 0;

export function getRuntimeBotStats() {
  return { lastScanAt, tokensScanned, signalsGenerated };
}

async function jobTokenDiscovery(): Promise<void> {
  const portfolioId = await ensureDefaultPortfolio();
  const discovered = await providers.tokenDiscovery.discoverRecentTokens(15);
  for (const token of discovered) {
    const existing = await query(
      `SELECT id FROM tokens WHERE chain = $1 AND address = $2 AND data_mode = $3`,
      [token.chain, token.address, dataMode],
    );
    const id = await upsertDiscoveredToken(token);
    if (id && existing.rows.length === 0) {
      await logBotEvent({
        portfolioId,
        level: 'info',
        category: 'discovery',
        message: `Discovered token ${token.symbol}`,
        details: { address: token.address, chain: token.chain },
      });
      publish('token_discovered', { tokenId: id, symbol: token.symbol, address: token.address });
      publish('bot_event', { message: `Discovered token ${token.symbol}` });
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
  }
  publish('scanner_updated', { count: quotes.length });
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

async function jobSignals(): Promise<void> {
  const portfolioId = await ensureDefaultPortfolio();
  const settings = await getPortfolioSettings(portfolioId);
  const tokens = await listActiveTokenIds(50);
  let generated = 0;

  const runId = (
    await query<{ id: string }>(
      `INSERT INTO strategy_runs (strategy_name, strategy_version, portfolio_id, data_mode, started_at)
       VALUES ($1,$2,$3,$4,NOW()) RETURNING id`,
      [strategy.name, strategy.version, portfolioId, dataMode],
    )
  ).rows[0]!.id;

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
    const ageMinutes =
      token.created_at_onchain != null
        ? (Date.now() - token.created_at_onchain.getTime()) / 60_000
        : (Date.now() - token.discovered_at.getTime()) / 60_000;

    const ctx = {
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
    };

    // Always log score evaluation path for visibility
    const evaluation = strategy.evaluate(ctx, settings.strategyParams);
    await logBotEvent({
      portfolioId,
      level: 'info',
      category: 'signal',
      message: `Momentum score: ${evaluation.scores.momentum.toFixed(0)} (${token.symbol})`,
      details: { scores: evaluation.scores, pass: evaluation.pass },
    });

    if (ctx.liquidityUsd >= settings.strategyParams.minLiquidityUsd) {
      await logBotEvent({
        portfolioId,
        level: 'info',
        category: 'filter',
        message: `Liquidity check passed for ${token.symbol}`,
        details: { liquidityUsd: ctx.liquidityUsd },
      });
    }

    if (!evaluation.pass) continue;

    const { rows } = await query<{ id: string }>(
      `INSERT INTO signals (
        token_id, strategy_name, strategy_version, side,
        momentum_score, liquidity_score, volume_score, holder_score, risk_score, overall_score,
        risk_label, explanation, market_state, data_mode
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
      RETURNING id`,
      [
        token.id,
        strategy.name,
        strategy.version,
        evaluation.side,
        evaluation.scores.momentum,
        evaluation.scores.liquidity,
        evaluation.scores.volume,
        evaluation.scores.holderDistribution,
        evaluation.scores.risk,
        evaluation.scores.overall,
        evaluation.riskLabel,
        JSON.stringify(evaluation.explanation),
        JSON.stringify(ctx),
        dataMode,
      ],
    );

    generated++;
    signalsGenerated++;
    await logBotEvent({
      portfolioId,
      level: 'info',
      category: 'signal',
      message: `Signal generated for ${token.symbol}`,
      details: {
        signalId: rows[0]!.id,
        overall: evaluation.scores.overall,
        disclaimer: 'Model score, not a probability of profit',
      },
    });
    publish('signal_generated', {
      signalId: rows[0]!.id,
      tokenId: token.id,
      symbol: token.symbol,
      scores: evaluation.scores,
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

  // Manage open positions regardless of bot status
  await manageOpenPositions(portfolioId, settings);

  if (portfolio.botStatus !== 'RUNNING') return;

  // Process recent unexecuted BUY signals
  const { rows: signals } = await query<{
    id: string;
    token_id: string;
    overall_score: string;
  }>(
    `SELECT s.id, s.token_id, s.overall_score
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
     ORDER BY s.overall_score DESC
     LIMIT 5`,
    [dataMode, portfolioId],
  );

  const gas = await providers.gasFee.getFeeEstimate();
  if (!isGasUsableForTrading(gas)) {
    await logBotEvent({
      portfolioId,
      level: 'error',
      category: 'fees',
      message:
        'SOL/USD price unavailable or stale — skipping new paper trades (fail-safe)',
      details: {
        solPriceUsd: gas.solPriceUsd,
        solPriceSource: gas.solPriceSource,
        solPriceStale: gas.solPriceStale,
        usable: gas.usable,
      },
    });
    return;
  }

  // Daily realized PnL
  const dayPnl = await query<{ pnl: string }>(
    `SELECT COALESCE(SUM(realized_pnl_usd),0) AS pnl FROM positions
     WHERE portfolio_id = $1 AND closed_at >= date_trunc('day', NOW())`,
    [portfolioId],
  );

  for (const signal of signals) {
    const latest = await getPortfolio(portfolioId);
    if (!latest || latest.botStatus !== 'RUNNING') break;

    const market = await getLatestMarketByToken(signal.token_id);
    if (!market) {
      await logBotEvent({
        portfolioId,
        level: 'warn',
        category: 'execution',
        message: 'Missing market data — skip trade (no invented price)',
        details: { tokenId: signal.token_id },
      });
      continue;
    }
    if (market.stale || Date.now() - market.observed_at.getTime() > getStalePriceMaxAgeMs()) {
      await logBotEvent({
        portfolioId,
        level: 'warn',
        category: 'execution',
        message: 'Stale price — don\'t trade',
        details: { tokenId: signal.token_id },
      });
      continue;
    }
    if (market.liquidity_usd <= 0) {
      await logBotEvent({
        portfolioId,
        level: 'warn',
        category: 'execution',
        message: 'Missing liquidity — token unavailable for trading',
        details: { tokenId: signal.token_id },
      });
      continue;
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
    });

    await setRiskState(portfolioId, risk.riskState);
    await logBotEvent({
      portfolioId,
      level: risk.allowed ? 'info' : 'warn',
      category: 'risk',
      message: risk.allowed ? 'Risk check passed' : risk.reason,
      details: { ...risk },
    });

    if (!risk.allowed) continue;

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

    const result = await executePaperBuy({
      portfolioId,
      tokenId: signal.token_id,
      signalId: signal.id,
      amountUsd: risk.sizedAmountUsd,
      midPriceUsd: market.price_usd,
      quote,
      gas,
      priorityFeeLamports: settings.priorityFeeLamports,
      failedTxStillChargesNetwork: settings.failedTxStillChargesNetwork,
      stopLossPct: settings.stopLossPct,
      takeProfitPct: settings.takeProfitPct,
      trailingStopPct: settings.trailingStopPct,
    });

    if (result.success) {
      await logBotEvent({
        portfolioId,
        level: 'info',
        category: 'execution',
        message: 'Paper BUY executed',
        details: result,
      });
      await logBotEvent({
        portfolioId,
        level: 'info',
        category: 'execution',
        message: `Estimated slippage: reviewed in order ${result.orderId}`,
        details: result,
      });
      await logBotEvent({
        portfolioId,
        level: 'info',
        category: 'execution',
        message: 'Position opened',
        details: { positionId: result.positionId },
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
      publish('bot_event', { level: 'error', message: result.reason });
    }
  }
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
  }>(
    `SELECT * FROM positions WHERE portfolio_id = $1 AND status = 'OPEN'`,
    [portfolioId],
  );

  const gas = await providers.gasFee.getFeeEstimate();

  for (const pos of positions) {
    const market = await getLatestMarketByToken(pos.token_id);
    if (!market) continue;

    await markPositionMarkToMarket(pos.id, market.price_usd);
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

    if (decision.deferredDueToStale) {
      await logBotEvent({
        portfolioId,
        level: 'warn',
        category: 'exit',
        message: 'Stale price — delaying non-emergency exit',
        details: { positionId: pos.id },
      });
      continue;
    }

    const closeReason = decision.closeReason;
    if (!closeReason) continue;

    // Emergency exits may proceed even if SOL price is stale (mark unavailable);
    // non-emergency exits require usable SOL/USD for fee conversion.
    if (
      closeReason !== 'emergency_liquidity_collapse' &&
      !isGasUsableForTrading(gas)
    ) {
      await logBotEvent({
        portfolioId,
        level: 'error',
        category: 'fees',
        message:
          'SOL/USD unavailable or stale — delaying non-emergency exit',
        details: { positionId: pos.id, closeReason },
      });
      continue;
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

    // Exit at market mid → simulated executable price — never theoretical stop/TP
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
    } else {
      await logBotEvent({
        portfolioId,
        level: 'error',
        category: 'execution',
        message: `Paper SELL failed: ${result.reason}`,
        details: result,
      });
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
  // Analytics are computed on read; this job keeps a heartbeat event
  const portfolioId = await ensureDefaultPortfolio();
  await logBotEvent({
    portfolioId,
    level: 'info',
    category: 'analytics',
    message: 'Analytics aggregation tick',
    details: getRuntimeBotStats(),
  });
}

export function registerAllJobs(): void {
  const intervals = defaultIntervals();
  registerJob('token_discovery', intervals.token_discovery, jobTokenDiscovery);
  registerJob('market_data', intervals.market_data, jobMarketData);
  registerJob('onchain', intervals.onchain, jobOnchain);
  registerJob('signal', intervals.signal, jobSignals);
  registerJob('paper_execution', intervals.paper_execution, jobPaperExecution);
  registerJob('portfolio_valuation', intervals.portfolio_valuation, jobPortfolioValuation);
  registerJob('analytics', intervals.analytics, jobAnalytics);
  registerJob('daily_report', intervals.daily_report, jobDailyReport);
}

async function jobDailyReport(): Promise<void> {
  await runDailyReportIfDue(await ensureDefaultPortfolio());
}

export { startJobs, stopJobs, providers };
