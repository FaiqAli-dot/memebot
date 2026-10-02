import type {
  BotStatus,
  DataMode,
  PortfolioSettings,
  PortfolioSummary,
} from '@memebot/shared';
import { query, withTransaction } from '../db/client.js';
import { env, dataMode } from '../config/env.js';
import { defaultPortfolioSettings } from '../engines/risk/engine.js';

export async function ensureDefaultPortfolio(): Promise<string> {
  const id = env.DEFAULT_PORTFOLIO_ID;
  const existing = await query(`SELECT id FROM user_portfolios WHERE id = $1`, [id]);
  if (existing.rows.length > 0) return id;

  const settings = defaultPortfolioSettings();
  await query(
    `INSERT INTO user_portfolios (
      id, name, data_mode, starting_balance_usd, cash_usd, peak_equity_usd,
      bot_status, settings
    ) VALUES ($1, $2, $3, $4, $4, $4, 'RUNNING', $5)
    ON CONFLICT (id) DO NOTHING`,
    [id, 'Demo Portfolio', dataMode, env.INITIAL_BALANCE_USD, JSON.stringify(settings)],
  );

  await query(
    `INSERT INTO strategies (name, version, description, params, active)
     VALUES ($1, $2, $3, $4, TRUE)
     ON CONFLICT (name, version) DO NOTHING`,
    [
      'Momentum Scanner v1',
      '1.0.0',
      'Baseline momentum/volume acceleration scanner. Model scores are not probabilities of profit.',
      JSON.stringify(settings.strategyParams),
    ],
  );

  return id;
}

export async function getPortfolio(portfolioId: string): Promise<PortfolioSummary | null> {
  const { rows } = await query<{
    id: string;
    name: string;
    data_mode: DataMode;
    starting_balance_usd: string;
    cash_usd: string;
    peak_equity_usd: string;
    max_drawdown_pct: string;
    realized_pnl_usd: string;
    total_fees_usd: string;
    total_network_cost_usd: string;
    total_slippage_cost_usd: string;
    total_price_impact_cost_usd: string;
    bot_status: BotStatus;
    risk_state: string;
    created_at: Date;
    updated_at: Date;
  }>(`SELECT * FROM user_portfolios WHERE id = $1`, [portfolioId]);

  const p = rows[0];
  if (!p) return null;

  const pos = await query<{
    invested: string;
    unrealized: string;
    open_count: string;
  }>(
    `SELECT
       COALESCE(SUM(current_value_usd), 0) AS invested,
       COALESCE(SUM(unrealized_pnl_usd), 0) AS unrealized,
       COUNT(*) FILTER (WHERE status = 'OPEN') AS open_count
     FROM positions WHERE portfolio_id = $1 AND status = 'OPEN'`,
    [portfolioId],
  );

  const invested = Number(pos.rows[0]?.invested ?? 0);
  const unrealized = Number(pos.rows[0]?.unrealized ?? 0);
  const cash = Number(p.cash_usd);
  const equity = cash + invested;
  const realized = Number(p.realized_pnl_usd);
  const starting = Number(p.starting_balance_usd);
  const totalPnl = equity - starting;

  return {
    id: p.id,
    name: p.name,
    dataMode: p.data_mode,
    startingBalanceUsd: starting,
    cashUsd: cash,
    investedValueUsd: invested,
    equityUsd: equity,
    unrealizedPnlUsd: unrealized,
    realizedPnlUsd: realized,
    totalPnlUsd: totalPnl,
    returnPct: starting > 0 ? (totalPnl / starting) * 100 : 0,
    totalFeesUsd: Number(p.total_fees_usd),
    totalNetworkCostUsd: Number(p.total_network_cost_usd),
    totalSlippageCostUsd: Number(p.total_slippage_cost_usd),
    totalPriceImpactCostUsd: Number(p.total_price_impact_cost_usd),
    maxDrawdownPct: Number(p.max_drawdown_pct) * 100,
    peakEquityUsd: Number(p.peak_equity_usd),
    openPositions: Number(pos.rows[0]?.open_count ?? 0),
    botStatus: p.bot_status,
    riskState: p.risk_state,
    createdAt: p.created_at.toISOString(),
    updatedAt: p.updated_at.toISOString(),
  };
}

export async function getPortfolioSettings(portfolioId: string): Promise<PortfolioSettings> {
  const { rows } = await query<{ settings: PortfolioSettings }>(
    `SELECT settings FROM user_portfolios WHERE id = $1`,
    [portfolioId],
  );
  return { ...defaultPortfolioSettings(), ...(rows[0]?.settings ?? {}) };
}

export async function updatePortfolioSettings(
  portfolioId: string,
  patch: Partial<Omit<PortfolioSettings, 'strategyParams'>> & {
    strategyParams?: Partial<PortfolioSettings['strategyParams']>;
  },
): Promise<PortfolioSettings> {
  const current = await getPortfolioSettings(portfolioId);
  const next: PortfolioSettings = {
    ...current,
    ...patch,
    strategyParams: {
      ...current.strategyParams,
      ...(patch.strategyParams ?? {}),
    },
  };
  await query(
    `UPDATE user_portfolios SET settings = $2, updated_at = NOW() WHERE id = $1`,
    [portfolioId, JSON.stringify(next)],
  );
  return next;
}

export async function setBotStatus(
  portfolioId: string,
  status: BotStatus,
): Promise<void> {
  await query(
    `UPDATE user_portfolios SET bot_status = $2, updated_at = NOW() WHERE id = $1`,
    [portfolioId, status],
  );
}

export async function setRiskState(portfolioId: string, riskState: string): Promise<void> {
  await query(
    `UPDATE user_portfolios SET risk_state = $2, updated_at = NOW() WHERE id = $1`,
    [portfolioId, riskState],
  );
}

export async function resetPaperAccount(portfolioId: string): Promise<void> {
  const settings = await getPortfolioSettings(portfolioId);
  await withTransaction(async (client) => {
    await client.query(`DELETE FROM paper_fills WHERE order_id IN (SELECT id FROM paper_orders WHERE portfolio_id = $1)`, [portfolioId]);
    await client.query(`DELETE FROM fee_records WHERE portfolio_id = $1`, [portfolioId]);
    await client.query(`UPDATE paper_orders SET position_id = NULL WHERE portfolio_id = $1`, [portfolioId]);
    await client.query(`DELETE FROM positions WHERE portfolio_id = $1`, [portfolioId]);
    await client.query(`DELETE FROM paper_orders WHERE portfolio_id = $1`, [portfolioId]);
    await client.query(`DELETE FROM portfolio_snapshots WHERE portfolio_id = $1`, [portfolioId]);
    await client.query(
      `UPDATE user_portfolios SET
        cash_usd = $2,
        starting_balance_usd = $2,
        peak_equity_usd = $2,
        max_drawdown_pct = 0,
        realized_pnl_usd = 0,
        total_fees_usd = 0,
        total_network_cost_usd = 0,
        total_slippage_cost_usd = 0,
        total_price_impact_cost_usd = 0,
        risk_state = 'OK',
        bot_status = 'PAUSED',
        updated_at = NOW()
       WHERE id = $1`,
      [portfolioId, settings.startingBalanceUsd],
    );
  });
}

export async function resetAllSimulationData(portfolioId: string): Promise<void> {
  await resetPaperAccount(portfolioId);
  await withTransaction(async (client) => {
    await client.query(`DELETE FROM bot_events WHERE portfolio_id = $1 OR data_mode = $2`, [
      portfolioId,
      dataMode,
    ]);
    await client.query(`DELETE FROM signals WHERE data_mode = $1`, [dataMode]);
    await client.query(`DELETE FROM strategy_runs WHERE data_mode = $1`, [dataMode]);
    await client.query(`DELETE FROM holder_snapshots WHERE data_mode = $1`, [dataMode]);
    await client.query(`DELETE FROM liquidity_snapshots WHERE data_mode = $1`, [dataMode]);
    await client.query(`DELETE FROM market_snapshots WHERE data_mode = $1`, [dataMode]);
    await client.query(`DELETE FROM token_snapshots WHERE data_mode = $1`, [dataMode]);
    await client.query(`DELETE FROM tokens WHERE data_mode = $1`, [dataMode]);
  });
}
