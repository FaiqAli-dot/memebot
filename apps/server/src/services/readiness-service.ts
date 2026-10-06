import type {
  BotReadiness,
  ReadinessCount,
  ReadinessFunnelStage,
  ReadinessGate,
  ReadinessNearMiss,
  ReadinessState,
} from '@memebot/shared';
import { OLDER_TOKEN_RESEARCH_PORTFOLIO_ID, RESEARCH_PORTFOLIO_ID } from '@memebot/shared';
import { query } from '../db/client.js';
import { dataMode, env } from '../config/env.js';
import { getPortfolio, getPortfolioSettings } from './portfolio-service.js';
import { evaluateRisk } from '../engines/risk/engine.js';
import { isKillSwitchActive } from '../monitoring/kill-switch.js';

const WINDOW_MINUTES = 10;
const MIN_HISTORY_MINUTES = 5;
const WORKER_HEARTBEAT_MAX_AGE_MS = 120_000;
const MARKET_DATA_MAX_AGE_MS = 60_000;

const STAGE_LABELS: Array<{ key: string; label: string; scope: 'now' | 'window' }> = [
  { key: 'discovered', label: 'Discovered (last 10 min)', scope: 'now' },
  { key: 'tracked', label: 'Tracked', scope: 'now' },
  { key: 'freshMarketData', label: 'Fresh market data', scope: 'now' },
  { key: 'knownLiquidity', label: 'Known AMM liquidity', scope: 'now' },
  { key: 'researchOnly', label: 'Research-only (pump.fun curve)', scope: 'now' },
  { key: 'evaluated', label: 'Evaluated', scope: 'window' },
  { key: 'safetyPassed', label: 'Safety passed', scope: 'window' },
  { key: 'strategyEligible', label: 'Strategy setup found', scope: 'window' },
  { key: 'evPassed', label: 'Profit vs. cost (EV) passed', scope: 'window' },
  { key: 'riskEvaluated', label: 'Risk evaluated (unique signals)', scope: 'window' },
  { key: 'riskSized', label: 'Risk: sized as requested', scope: 'window' },
  { key: 'riskResized', label: 'Risk: resized smaller', scope: 'window' },
  { key: 'riskRejected', label: 'Risk: rejected', scope: 'window' },
  { key: 'executionAttempted', label: 'Execution attempted', scope: 'window' },
  { key: 'executed', label: 'Executed', scope: 'window' },
];

const REJECTION_LABELS: Record<string, string> = {
  tooOld: 'Too old',
  tooYoung: 'Too young',
  staleData: 'Stale data',
  unknownLiquidity: 'Unknown liquidity',
  lowLiquidity: 'Low liquidity',
  safetyFailed: 'Safety failed',
  strategyFailed: 'Strategy conditions',
  volumeFailed: 'Volume / acceleration',
  priceFailed: 'Price momentum',
  transactionCountFailed: 'Too few transactions',
  evFailed: 'EV below threshold',
  riskFailed: 'Risk rejected (see risk reasons)',
  executionFailed: 'Execution failed',
  riskState: 'Drawdown / daily-loss state',
  invalidStop: 'Invalid stop loss',
  invalidExecution: 'Execution not priceable',
  volatilityExtreme: 'Extreme volatility',
  maxOpenPositions: 'Max open positions',
  insufficientCash: 'Insufficient cash',
  portfolioExposure: 'Portfolio exposure limit',
  strategyExposure: 'Strategy exposure limit',
  tokenExposure: 'Token exposure limit',
  maximumLossExceeded: 'Max planned loss per trade',
  priceImpactTooHigh: 'Price impact too high',
  executionCostTooHigh: 'Round-trip cost too high',
  minimumPositionSize: 'Below minimum position size',
};

const RISK_WINDOW_MINUTES = 60;

interface RiskRow {
  symbol: string;
  strategy_id: string | null;
  decision: 'SIZED' | 'RESIZED' | 'REJECTED';
  rejection_reason: string | null;
  binding_constraint: string | null;
  expected_net_value: string | null;
  requested_size_usd: string | null;
  final_size_usd: string | null;
  max_viable_size_usd: string | null;
  position_size_multiplier: string | null;
  maximum_planned_loss_usd: string | null;
  max_risk_per_trade_usd: string | null;
  execution_cost_rate: string | null;
  execution_status: string | null;
  evaluated_at: Date;
}

const num = (v: string | null | undefined) => (v == null ? 0 : Number(v));
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const ratio = (n: number, d: number) => (d > 0 ? n / d : null);

function toCounts(obj: Record<string, number>): ReadinessCount[] {
  return Object.entries(obj)
    .filter(([, n]) => n > 0)
    .map(([key, count]) => ({ key, label: REJECTION_LABELS[key] ?? key, count }))
    .sort((a, b) => b.count - a.count);
}

function addInto(target: Record<string, number>, src: Record<string, number> | undefined): void {
  for (const [k, v] of Object.entries(src ?? {})) target[k] = (target[k] ?? 0) + Number(v);
}

function fmtPct(fraction: number): string {
  const v = fraction * 100;
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
}

interface FunnelRow {
  kind: string;
  counts: { stages?: Record<string, number>; rejections?: Record<string, number> };
  details: { strategyRejections?: Record<string, Record<string, number>> };
  observed_at: Date;
}

interface OppRow {
  token_id: string;
  symbol: string;
  strategy_id: string;
  ev_net: string;
  ev_threshold: string;
  observed_at: Date;
  data_confidence: string | null;
  execution_cost_rate: string | null;
  position_size_usd: string | null;
}

function toNearMiss(r: OppRow): ReadinessNearMiss {
  return {
    tokenId: r.token_id,
    symbol: r.symbol,
    strategyId: r.strategy_id,
    expectedNetValue: Number(r.ev_net),
    threshold: Number(r.ev_threshold),
    observedAt: r.observed_at.toISOString(),
    dataConfidence: r.data_confidence,
    executionCostRate: r.execution_cost_rate != null ? Number(r.execution_cost_rate) : null,
    positionSizeUsd: r.position_size_usd != null ? Number(r.position_size_usd) : null,
  };
}

export async function getBotReadiness(portfolioId: string): Promise<BotReadiness> {
  const [portfolio, settings, killSwitch] = await Promise.all([
    getPortfolio(portfolioId),
    getPortfolioSettings(portfolioId),
    isKillSwitchActive(portfolioId),
  ]);

  const [heartbeat, lastMarket, solError, dayPnl, warmup, funnelRows, opps, signals, trades, research, riskRows, exposure] =
    await Promise.all([
      query<{ observed_at: Date }>(
        `SELECT observed_at FROM system_health WHERE component = 'worker'
         ORDER BY observed_at DESC LIMIT 1`,
      ),
      query<{ last: Date | null }>(
        `SELECT MAX(observed_at) AS last FROM market_snapshots WHERE data_mode = $1`,
        [dataMode],
      ),
      query<{ created_at: Date }>(
        `SELECT created_at FROM bot_events
         WHERE category = 'fees' AND level = 'error' AND created_at > NOW() - INTERVAL '2 minutes'
         ORDER BY created_at DESC LIMIT 1`,
      ),
      query<{ pnl: string }>(
        `SELECT COALESCE(SUM(realized_pnl_usd),0) AS pnl FROM positions
         WHERE portfolio_id = $1 AND closed_at >= date_trunc('day', NOW())`,
        [portfolioId],
      ),
      // Eligible tokens and those with a snapshot >= 5 min old (non-overlapping acceleration baseline)
      query<{ eligible: string; ready: string }>(
        `SELECT COUNT(*)::text AS eligible,
                COUNT(*) FILTER (WHERE EXISTS (
                  SELECT 1 FROM market_snapshots m
                  WHERE m.token_id = t.id
                    AND m.observed_at <= NOW() - make_interval(mins => $2)
                    AND m.observed_at >= NOW() - make_interval(mins => $2 * 2)
                ))::text AS ready
         FROM tokens t
         WHERE t.data_mode = $1 AND t.lifecycle_state IN ('ELIGIBLE','ACTIVE')`,
        [dataMode, MIN_HISTORY_MINUTES],
      ),
      query<FunnelRow>(
        `SELECT kind, counts, details, observed_at FROM funnel_snapshots
         WHERE data_mode = $1 AND observed_at > NOW() - make_interval(mins => $2)
         ORDER BY observed_at DESC`,
        [dataMode, WINDOW_MINUTES],
      ),
      query<OppRow>(
        `SELECT DISTINCT ON (o.token_id, o.strategy_id)
                o.token_id, t.symbol, o.strategy_id, o.ev_net, o.ev_threshold, o.observed_at,
                o.data_confidence, o.execution_cost_rate, o.position_size_usd
         FROM opportunities o JOIN tokens t ON t.id = o.token_id
         WHERE o.data_mode = $1 AND o.ev_net IS NOT NULL
           AND o.observed_at > NOW() - make_interval(mins => $2)
         ORDER BY o.token_id, o.strategy_id, o.observed_at DESC`,
        [dataMode, WINDOW_MINUTES],
      ),
      query<{ prod: string; research: string; last: Date | null }>(
        `SELECT COUNT(*) FILTER (WHERE lane = 'PRODUCTION' AND created_at > NOW() - make_interval(mins => $2))::text AS prod,
                COUNT(*) FILTER (
                  WHERE lane = 'RESEARCH' AND (target_portfolio_id IS NULL OR target_portfolio_id = $3)
                    AND created_at > NOW() - make_interval(mins => $2)
                )::text AS research,
                MAX(created_at) FILTER (WHERE lane = 'PRODUCTION') AS last
         FROM signals WHERE data_mode = $1`,
        [dataMode, WINDOW_MINUTES, RESEARCH_PORTFOLIO_ID],
      ),
      query<{ in_window: string; last: Date | null }>(
        `SELECT COUNT(*) FILTER (WHERE opened_at > NOW() - make_interval(mins => $2))::text AS in_window,
                MAX(opened_at) AS last
         FROM positions WHERE portfolio_id = $1`,
        [portfolioId, WINDOW_MINUTES],
      ),
      query<{ today: string; open: string }>(
        `SELECT COUNT(*) FILTER (WHERE opened_at >= date_trunc('day', NOW()))::text AS today,
                COUNT(*) FILTER (WHERE status = 'OPEN')::text AS open
         FROM positions WHERE portfolio_id = $1`,
        [RESEARCH_PORTFOLIO_ID],
      ),
      query<RiskRow>(
        `SELECT t.symbol, r.strategy_id, r.decision, r.rejection_reason, r.binding_constraint,
                r.expected_net_value, r.requested_size_usd, r.final_size_usd, r.max_viable_size_usd,
                r.position_size_multiplier, r.maximum_planned_loss_usd, r.max_risk_per_trade_usd,
                r.execution_cost_rate, r.execution_status, r.evaluated_at
         FROM risk_decisions r LEFT JOIN tokens t ON t.id = r.token_id
         WHERE r.portfolio_id = $1 AND r.evaluated_at > NOW() - make_interval(mins => $2)
         ORDER BY r.evaluated_at DESC`,
        [portfolioId, RISK_WINDOW_MINUTES],
      ),
      query<{ exposure: string }>(
        `SELECT COALESCE(SUM(cost_basis_usd), 0) AS exposure FROM positions
         WHERE portfolio_id = $1 AND status = 'OPEN'`,
        [portfolioId],
      ),
    ]);

  // ---- Gates ----
  const gates: ReadinessGate[] = [];
  const running = portfolio?.botStatus === 'RUNNING';
  gates.push({
    key: 'bot_running',
    label: 'Bot running',
    ok: running,
    detail: running ? 'Bot is RUNNING' : `Bot is ${portfolio?.botStatus ?? 'PAUSED'} — press START BOT`,
  });
  gates.push({
    key: 'kill_switch',
    label: 'Kill switch off',
    ok: !killSwitch,
    detail: killSwitch ? 'Kill switch is active — clear it to allow trades' : 'Not active',
  });

  const hbAt = heartbeat.rows[0]?.observed_at ?? null;
  const workerAlive = hbAt != null && Date.now() - hbAt.getTime() < WORKER_HEARTBEAT_MAX_AGE_MS;
  gates.push({
    key: 'worker',
    label: 'Worker alive',
    ok: workerAlive,
    detail: workerAlive
      ? `Last heartbeat ${Math.round((Date.now() - hbAt!.getTime()) / 1000)}s ago`
      : 'No worker heartbeat in the last 2 minutes — is the worker process running?',
  });

  const lastMarketAt = lastMarket.rows[0]?.last ?? null;
  const marketFresh = lastMarketAt != null && Date.now() - lastMarketAt.getTime() < MARKET_DATA_MAX_AGE_MS;
  gates.push({
    key: 'market_data',
    label: 'Market data flowing',
    ok: marketFresh,
    detail: marketFresh
      ? `Last price update ${Math.round((Date.now() - lastMarketAt!.getTime()) / 1000)}s ago`
      : 'No fresh price snapshots in the last minute',
  });

  const solBlocked = solError.rows.length > 0;
  gates.push({
    key: 'sol_price',
    label: 'SOL/USD price fresh',
    ok: !solBlocked,
    detail: solBlocked
      ? 'SOL/USD unavailable or stale — new trades are skipped (fail-safe)'
      : 'Fresh enough for fee conversion',
  });

  if (portfolio) {
    const risk = evaluateRisk({
      equityUsd: portfolio.equityUsd,
      cashUsd: portfolio.cashUsd,
      openPositions: portfolio.openPositions,
      startingBalanceUsd: portfolio.startingBalanceUsd,
      peakEquityUsd: portfolio.peakEquityUsd,
      realizedPnlTodayUsd: Number(dayPnl.rows[0]?.pnl ?? 0),
      proposedSizeUsd: portfolio.equityUsd * settings.maxPositionPct,
      stopLossPct: settings.stopLossPct,
      settings,
      currentRiskState: portfolio.riskState,
      killSwitchActive: settings.killSwitchActive,
    });
    const baseUsd = portfolio.equityUsd * settings.maxPositionPct;
    gates.push({
      key: 'risk',
      label: 'Risk limits allow new entries',
      ok: risk.allowed,
      detail: risk.allowed
        ? `Risk state ${risk.riskState}; base size $${baseUsd.toFixed(2)} scaled by confidence/EV/volatility, max planned loss $${(portfolio.equityUsd * settings.maxRiskPerTradePct).toFixed(2)}`
        : `${risk.reason} (risk state ${risk.riskState})`,
    });
  }

  // ---- Funnel ----
  const signalRows = funnelRows.rows.filter((r) => r.kind === 'signal');
  const execRows = funnelRows.rows.filter((r) => r.kind === 'execution_production');
  const latest = signalRows[0];
  const windowStages: Record<string, number> = {};
  const rejections: Record<string, number> = {};
  const byStrategy: Record<string, Record<string, number>> = {};
  for (const r of signalRows) {
    for (const k of ['evaluated', 'safetyPassed', 'strategyEligible', 'evPassed']) {
      windowStages[k] = (windowStages[k] ?? 0) + Number(r.counts.stages?.[k] ?? 0);
    }
    addInto(rejections, r.counts.rejections);
    for (const [sid, counts] of Object.entries(r.details.strategyRejections ?? {})) {
      addInto((byStrategy[sid] ??= {}), counts);
    }
  }
  for (const r of execRows) {
    for (const k of ['executionAttempted', 'executed']) {
      windowStages[k] = (windowStages[k] ?? 0) + Number(r.counts.stages?.[k] ?? 0);
    }
    addInto(rejections, r.counts.rejections);
  }
  // Risk stages from unique decisions (one per signal), not per-tick retries
  const rr = riskRows.rows.filter((r) => r.evaluated_at.getTime() > Date.now() - WINDOW_MINUTES * 60_000);
  windowStages.riskEvaluated = rr.length;
  windowStages.riskSized = rr.filter((r) => r.decision === 'SIZED').length;
  windowStages.riskResized = rr.filter((r) => r.decision === 'RESIZED').length;
  windowStages.riskRejected = rr.filter((r) => r.decision === 'REJECTED').length;

  const stages: ReadinessFunnelStage[] = STAGE_LABELS.map((s) => ({
    key: s.key,
    label: s.label,
    scope: s.scope,
    count: s.scope === 'now' ? Number(latest?.counts.stages?.[s.key] ?? 0) : windowStages[s.key] ?? 0,
  }));

  // ---- EV summary over distinct opportunities ----
  const oppRows = opps.rows;
  const best = [...oppRows].sort((a, b) => Number(b.ev_net) - Number(a.ev_net))[0];
  const misses = oppRows
    .map((r) => ({ r, shortfall: Number(r.ev_threshold) - Number(r.ev_net) }))
    .filter((m) => m.shortfall > 0)
    .sort((a, b) => a.shortfall - b.shortfall);
  const within = (x: number) => misses.filter((m) => m.shortfall <= x).length;
  const ev = {
    candidates: oppRows.length,
    best: best ? toNearMiss(best) : null,
    closestMiss: misses[0] ? toNearMiss(misses[0].r) : null,
    within0_5pct: within(0.005),
    within1pct: within(0.01),
    within2pct: within(0.02),
    minExpectedNetValue: settings.minExpectedNetValue ?? env.MIN_EXPECTED_NET_VALUE,
    lowConfidenceMultiplier: env.LOW_CONFIDENCE_EV_MULTIPLIER,
  };

  // ---- Risk calibration metrics ----
  const all = riskRows.rows;
  const passed = all.filter((r) => r.decision !== 'REJECTED');
  const riskRejections: Record<string, number> = {};
  const resizedBy: Record<string, number> = {};
  for (const r of all) {
    if (r.decision === 'REJECTED') riskRejections[r.rejection_reason ?? 'unknown'] = (riskRejections[r.rejection_reason ?? 'unknown'] ?? 0) + 1;
    if (r.decision === 'RESIZED') resizedBy[r.binding_constraint ?? 'unknown'] = (resizedBy[r.binding_constraint ?? 'unknown'] ?? 0) + 1;
  }
  const equity = portfolio?.equityUsd ?? settings.startingBalanceUsd;
  const riskInfo = {
    windowMinutes: RISK_WINDOW_MINUTES,
    candidates: all.length,
    sized: all.filter((r) => r.decision === 'SIZED').length,
    resized: all.filter((r) => r.decision === 'RESIZED').length,
    rejected: all.filter((r) => r.decision === 'REJECTED').length,
    passRate: ratio(passed.length, all.length),
    resizeRate: ratio(all.filter((r) => r.decision === 'RESIZED').length, all.length),
    rejectRate: ratio(all.filter((r) => r.decision === 'REJECTED').length, all.length),
    passIfSmaller: all.filter((r) => r.decision === 'RESIZED').length,
    executed: all.filter((r) => r.execution_status === 'EXECUTED').length,
    evFailedAtFinalSize: all.filter((r) => r.execution_status === 'EV_FAILED_AT_FINAL_SIZE').length,
    limitBlocked: all.filter((r) => r.execution_status === 'LIMIT_BLOCKED').length,
    avgRequestedSizeUsd: avg(passed.map((r) => num(r.requested_size_usd))),
    avgFinalSizeUsd: avg(passed.map((r) => num(r.final_size_usd))),
    avgPositionMultiplier: avg(passed.map((r) => num(r.position_size_multiplier))),
    avgMaxPlannedLossUsd: avg(passed.map((r) => num(r.maximum_planned_loss_usd))),
    avgExecutionCostRate: avg(passed.filter((r) => r.execution_cost_rate != null).map((r) => num(r.execution_cost_rate))),
    baseSizeUsd: equity * settings.maxPositionPct,
    minSizeUsd: env.PAPER_MIN_POSITION_USD,
    maxRiskPerTradeUsd: equity * settings.maxRiskPerTradePct,
    maxPortfolioExposureUsd: equity * env.MAX_PORTFOLIO_EXPOSURE_PCT,
    openExposureUsd: Number(exposure.rows[0]?.exposure ?? 0),
    rejections: toCounts(riskRejections),
    resizedBy: toCounts(resizedBy),
    examples: all.slice(0, 6).map((r) => ({
      symbol: r.symbol ?? '?',
      strategyId: r.strategy_id,
      decision: r.decision,
      reason: r.rejection_reason ?? r.binding_constraint,
      expectedNetValue: r.expected_net_value != null ? Number(r.expected_net_value) : null,
      requestedSizeUsd: num(r.requested_size_usd),
      finalSizeUsd: num(r.final_size_usd),
      maxViableSizeUsd: num(r.max_viable_size_usd),
      maximumPlannedLossUsd: num(r.maximum_planned_loss_usd),
      maxRiskPerTradeUsd: num(r.max_risk_per_trade_usd),
      executionStatus: r.execution_status,
      evaluatedAt: r.evaluated_at.toISOString(),
    })),
  };

  const researchInfo = {
    enabled: env.RESEARCH_EXPLORATION_ENABLED,
    tradesToday: Number(research.rows[0]?.today ?? 0),
    maxTradesPerDay: env.RESEARCH_MAX_TRADES_PER_DAY,
    maxEvShortfall: env.RESEARCH_MAX_EV_SHORTFALL,
    openPositions: Number(research.rows[0]?.open ?? 0),
    signalsInWindow: Number(signals.rows[0]?.research ?? 0),
  };

  const tokensEligible = Number(warmup.rows[0]?.eligible ?? 0);
  const tokensReady = Number(warmup.rows[0]?.ready ?? 0);
  const signalCount = Number(signals.rows[0]?.prod ?? 0);
  const tradesOpened = Number(trades.rows[0]?.in_window ?? 0);

  // ---- Overall state ----
  let state: ReadinessState;
  let headline: string;
  let detail: string;
  const blocking = gates.find((g) => !g.ok && g.key !== 'bot_running');
  const openPositions = portfolio?.openPositions ?? 0;

  if (!running) {
    state = 'PAUSED';
    headline = 'Bot is paused';
    detail = 'Press START BOT to resume scanning and trading.';
  } else if (blocking) {
    state = 'BLOCKED';
    headline = `Trading blocked: ${blocking.label.toLowerCase()}`;
    detail = blocking.detail;
  } else if (signalRows.length === 0 || (tokensEligible > 0 && tokensReady === 0)) {
    state = 'WARMING_UP';
    headline = 'Warming up — building non-overlapping price history';
    detail = `${tokensReady}/${tokensEligible} tradeable tokens have a snapshot at least ${MIN_HISTORY_MINUTES} minutes old. Volume acceleration compares the current 5-minute window with the previous completed one, so this takes ~${MIN_HISTORY_MINUTES} minutes after start.`;
  } else if (openPositions > 0 || tradesOpened > 0) {
    state = 'TRADING';
    headline =
      openPositions > 0
        ? `Trading — ${openPositions} open position${openPositions === 1 ? '' : 's'}`
        : `Trading — ${tradesOpened} trade${tradesOpened === 1 ? '' : 's'} opened in the last ${WINDOW_MINUTES} min`;
    detail = 'Managing open positions and still scanning for new setups.';
  } else {
    state = 'HUNTING';
    headline = 'Ready — waiting for a token that passes every check';
    const top = toCounts(rejections)[0];
    const parts = [
      `Tracking ${Number(latest?.counts.stages?.tracked ?? 0)} tokens (${Number(
        latest?.counts.stages?.knownLiquidity ?? 0,
      )} with known AMM liquidity); ${windowStages.evaluated ?? 0} evaluations in the last ${WINDOW_MINUTES} min.`,
    ];
    if (top) parts.push(`Most common rejection: ${top.label.toLowerCase()} (${top.count}).`);
    if (ev.closestMiss) {
      parts.push(
        `Closest EV miss: ${ev.closestMiss.symbol} ${fmtPct(ev.closestMiss.expectedNetValue)} vs ${fmtPct(ev.closestMiss.threshold)} needed.`,
      );
    }
    parts.push('Thresholds are not loosened to force trades — it buys only when a token qualifies.');
    detail = parts.join(' ');
  }

  const researchStats = await query<{
    id: string;
    last_trade: Date | null;
    last_signal: Date | null;
    open_positions: number;
    trades_today: number;
  }>(
    `SELECT p.id,
            (SELECT MAX(opened_at) FROM positions WHERE portfolio_id = p.id) AS last_trade,
            (SELECT MAX(created_at) FROM signals WHERE target_portfolio_id = p.id) AS last_signal,
            (SELECT COUNT(*)::int FROM positions WHERE portfolio_id = p.id AND status = 'OPEN') AS open_positions,
            (SELECT COUNT(*)::int FROM positions
              WHERE portfolio_id = p.id AND opened_at >= date_trunc('day', NOW())) AS trades_today
       FROM user_portfolios p WHERE p.id = ANY($1::uuid[])`,
    [[RESEARCH_PORTFOLIO_ID, OLDER_TOKEN_RESEARCH_PORTFOLIO_ID]],
  );
  const researchLane = (key: 'exploration' | 'olderToken', id: string) => {
    const r = researchStats.rows.find((row) => row.id === id);
    return {
      key,
      lastTradeAt: r?.last_trade?.toISOString() ?? null,
      lastSignalAt: r?.last_signal?.toISOString() ?? null,
      openPositions: r?.open_positions ?? 0,
      tradesToday: r?.trades_today ?? 0,
      dailyCap:
        id === OLDER_TOKEN_RESEARCH_PORTFOLIO_ID
          ? env.OLDER_TOKEN_RESEARCH_MAX_TRADES_PER_DAY
          : env.RESEARCH_MAX_TRADES_PER_DAY,
    };
  };

  return {
    state,
    headline,
    detail,
    windowMinutes: WINDOW_MINUTES,
    researchLanes: [
      researchLane('exploration', RESEARCH_PORTFOLIO_ID),
      researchLane('olderToken', OLDER_TOKEN_RESEARCH_PORTFOLIO_ID),
    ],
    gates,
    warmup: { tokensEligible, tokensReady, minHistoryMinutes: MIN_HISTORY_MINUTES },
    funnel: {
      ticks: signalRows.length,
      stages,
      rejections: toCounts(rejections),
      byStrategy: Object.entries(byStrategy).map(([strategyId, counts]) => ({
        strategyId,
        rejections: toCounts(counts),
      })),
      signals: signalCount,
      tradesOpened,
    },
    ev,
    risk: riskInfo,
    research: researchInfo,
    lastSignalAt: signals.rows[0]?.last?.toISOString() ?? null,
    lastTradeAt: trades.rows[0]?.last?.toISOString() ?? null,
  };
}
