import { v4 as uuid } from 'uuid';
import type { CostBreakdown, ExecutionRecord } from '@memebot/shared';
import { query, withTransaction, isDbAvailable } from '../../db/client.js';
import { dataMode } from '../../config/env.js';
import { simulateTrade, emptyCosts } from '../cost/simulator.js';
import type { GasFeeEstimate, MarketQuote } from '../../providers/types.js';
import { logger } from '../../utils/logger.js';

export async function executePaperBuy(opts: {
  portfolioId: string;
  tokenId: string;
  signalId: string | null;
  amountUsd: number;
  midPriceUsd: number;
  quote: MarketQuote;
  gas: GasFeeEstimate;
  priorityFeeLamports: number;
  failedTxStillChargesNetwork: boolean;
  stopLossPct: number;
  takeProfitPct: number;
  trailingStopPct: number | null;
}): Promise<{ success: boolean; positionId?: string; orderId?: string; reason?: string }> {
  if (!isDbAvailable()) {
    return { success: false, reason: 'Database unavailable — new executions stopped' };
  }

  const sim = simulateTrade({
    side: 'BUY',
    requestedAmountUsd: opts.amountUsd,
    midPriceUsd: opts.midPriceUsd,
    quote: opts.quote,
    gas: opts.gas,
    priorityFeeLamports: opts.priorityFeeLamports,
    failedTxStillChargesNetwork: opts.failedTxStillChargesNetwork,
  });

  try {
    return await withTransaction(async (client) => {
      const port = await client.query<{ cash_usd: string }>(
        `SELECT cash_usd FROM user_portfolios WHERE id = $1 FOR UPDATE`,
        [opts.portfolioId],
      );
      const cash = Number(port.rows[0]?.cash_usd ?? 0);
      const totalDebit = sim.execution.filledAmountUsd + sim.costs.networkFeeUsd + sim.costs.priorityFeeUsd;
      // DEX fee and slippage are embedded in executed price / fill; network fees are extra cash out

      if (sim.execution.failed) {
        const orderId = uuid();
        await client.query(
          `INSERT INTO paper_orders (
            id, portfolio_id, token_id, signal_id, side, status,
            requested_price_usd, executed_price_usd, requested_amount_usd, filled_amount_usd,
            token_quantity, dex_fee_usd, network_fee_usd, priority_fee_usd, slippage_pct,
            slippage_cost_usd, price_impact_pct, price_impact_cost_usd, total_cost_usd,
            execution_record, failure_reason, data_mode, filled_at, sol_price_usd, sol_price_source
          ) VALUES ($1,$2,$3,$4,'BUY','FAILED',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,NOW(),$21,$22)`,
          [
            orderId,
            opts.portfolioId,
            opts.tokenId,
            opts.signalId,
            sim.execution.requestedPriceUsd,
            0,
            opts.amountUsd,
            0,
            0,
            0,
            sim.costs.networkFeeUsd,
            sim.costs.priorityFeeUsd,
            0,
            0,
            0,
            0,
            sim.costs.totalCostUsd,
            JSON.stringify(sim.execution),
            sim.execution.failureReason,
            dataMode,
            sim.costs.solPriceUsd,
            sim.costs.solPriceSource,
          ],
        );
        if (sim.costs.totalCostUsd > 0 && cash >= sim.costs.totalCostUsd) {
          await client.query(
            `UPDATE user_portfolios SET
              cash_usd = cash_usd - $2,
              total_network_cost_usd = total_network_cost_usd + $3,
              updated_at = NOW()
             WHERE id = $1`,
            [opts.portfolioId, sim.costs.totalCostUsd, sim.costs.networkFeeUsd + sim.costs.priorityFeeUsd],
          );
          await client.query(
            `INSERT INTO fee_records (portfolio_id, order_id, fee_type, amount_usd, details, data_mode, sol_price_usd, sol_price_source)
             VALUES ($1,$2,'network_failed_tx',$3,$4,$5,$6,$7)`,
            [opts.portfolioId, orderId, sim.costs.totalCostUsd, JSON.stringify(sim.costs), dataMode, sim.costs.solPriceUsd, sim.costs.solPriceSource],
          );
        }
        return { success: false, orderId, reason: sim.execution.failureReason ?? 'Failed' };
      }

      if (cash < totalDebit) {
        return { success: false, reason: 'Insufficient cash for fill + network fees' };
      }

      const orderId = uuid();
      const positionId = uuid();
      const status = sim.execution.partial ? 'PARTIAL' : 'FILLED';
      const costBasis = sim.execution.filledAmountUsd + sim.costs.networkFeeUsd + sim.costs.priorityFeeUsd;

      // Insert order first (without position_id) so position can reference entry_order_id
      await client.query(
        `INSERT INTO paper_orders (
          id, portfolio_id, token_id, signal_id, side, status,
          requested_price_usd, executed_price_usd, requested_amount_usd, filled_amount_usd,
          token_quantity, dex_fee_usd, network_fee_usd, priority_fee_usd, slippage_pct,
          slippage_cost_usd, price_impact_pct, price_impact_cost_usd, total_cost_usd,
          execution_record, data_mode, filled_at, sol_price_usd, sol_price_source
        ) VALUES ($1,$2,$3,$4,'BUY',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,NOW(),$21,$22)`,
        [
          orderId,
          opts.portfolioId,
          opts.tokenId,
          opts.signalId,
          status,
          sim.execution.requestedPriceUsd,
          sim.execution.executedPriceUsd,
          opts.amountUsd,
          sim.execution.filledAmountUsd,
          sim.execution.tokenQuantity,
          sim.costs.dexFeeUsd,
          sim.costs.networkFeeUsd,
          sim.costs.priorityFeeUsd,
          sim.execution.slippagePct,
          sim.costs.slippageCostUsd,
          sim.costs.priceImpactPct,
          sim.costs.priceImpactCostUsd,
          sim.costs.totalCostUsd,
          JSON.stringify(sim.execution),
          dataMode,
          sim.costs.solPriceUsd,
          sim.costs.solPriceSource,
        ],
      );

      await client.query(
        `INSERT INTO paper_fills (order_id, price_usd, amount_usd, token_quantity)
         VALUES ($1,$2,$3,$4)`,
        [orderId, sim.execution.executedPriceUsd, sim.execution.filledAmountUsd, sim.execution.tokenQuantity],
      );

      await client.query(
        `INSERT INTO positions (
          id, portfolio_id, token_id, entry_signal_id, status, quantity, entry_price_usd,
          current_price_usd, cost_basis_usd, current_value_usd, unrealized_pnl_usd,
          stop_loss_pct, take_profit_pct, trailing_stop_pct, highest_price_usd,
          entry_costs, entry_order_id, data_mode
        ) VALUES ($1,$2,$3,$4,'OPEN',$5,$6,$6,$7,$8,$9,$10,$11,$12,$6,$13,$14,$15)`,
        [
          positionId,
          opts.portfolioId,
          opts.tokenId,
          opts.signalId,
          sim.execution.tokenQuantity,
          sim.execution.executedPriceUsd,
          costBasis,
          sim.execution.tokenQuantity * sim.execution.executedPriceUsd,
          sim.execution.tokenQuantity * sim.execution.executedPriceUsd - costBasis,
          opts.stopLossPct,
          opts.takeProfitPct,
          opts.trailingStopPct,
          JSON.stringify(sim.costs),
          orderId,
          dataMode,
        ],
      );

      await client.query(`UPDATE paper_orders SET position_id = $2 WHERE id = $1`, [
        orderId,
        positionId,
      ]);

      await client.query(
        `UPDATE user_portfolios SET
          cash_usd = cash_usd - $2,
          total_fees_usd = total_fees_usd + $3,
          total_network_cost_usd = total_network_cost_usd + $4,
          total_slippage_cost_usd = total_slippage_cost_usd + $5,
          total_price_impact_cost_usd = total_price_impact_cost_usd + $6,
          updated_at = NOW()
         WHERE id = $1`,
        [
          opts.portfolioId,
          totalDebit,
          sim.costs.dexFeeUsd,
          sim.costs.networkFeeUsd + sim.costs.priorityFeeUsd,
          sim.costs.slippageCostUsd,
          sim.costs.priceImpactCostUsd,
        ],
      );

      for (const [feeType, amount] of [
        ['dex', sim.costs.dexFeeUsd],
        ['network', sim.costs.networkFeeUsd],
        ['priority', sim.costs.priorityFeeUsd],
        ['slippage', sim.costs.slippageCostUsd],
        ['price_impact', sim.costs.priceImpactCostUsd],
      ] as const) {
        if (amount > 0) {
          await client.query(
            `INSERT INTO fee_records (portfolio_id, order_id, fee_type, amount_usd, details, data_mode, sol_price_usd, sol_price_source)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [opts.portfolioId, orderId, feeType, amount, JSON.stringify(sim.costs), dataMode, sim.costs.solPriceUsd, sim.costs.solPriceSource],
          );
        }
      }

      return { success: true, positionId, orderId };
    });
  } catch (err) {
    logger.error({ err }, 'Paper buy failed');
    return { success: false, reason: 'DB error during paper buy' };
  }
}

export async function executePaperSell(opts: {
  portfolioId: string;
  positionId: string;
  midPriceUsd: number;
  quote: MarketQuote;
  gas: GasFeeEstimate;
  priorityFeeLamports: number;
  failedTxStillChargesNetwork: boolean;
  closeReason: string;
  exitSignalId?: string | null;
}): Promise<{ success: boolean; orderId?: string; reason?: string; netPnl?: number }> {
  if (!isDbAvailable()) {
    return { success: false, reason: 'Database unavailable — new executions stopped' };
  }

  try {
    return await withTransaction(async (client) => {
      const posRes = await client.query<{
        id: string;
        token_id: string;
        quantity: string;
        cost_basis_usd: string;
        entry_price_usd: string;
        status: string;
        entry_costs: CostBreakdown;
      }>(`SELECT * FROM positions WHERE id = $1 AND portfolio_id = $2 FOR UPDATE`, [
        opts.positionId,
        opts.portfolioId,
      ]);
      const pos = posRes.rows[0];
      if (!pos || pos.status !== 'OPEN') {
        return { success: false, reason: 'Position not open' };
      }

      const qty = Number(pos.quantity);
      const notional = qty * opts.midPriceUsd;
      const sim = simulateTrade({
        side: 'SELL',
        requestedAmountUsd: notional,
        midPriceUsd: opts.midPriceUsd,
        quote: opts.quote,
        gas: opts.gas,
        priorityFeeLamports: opts.priorityFeeLamports,
        failedTxStillChargesNetwork: opts.failedTxStillChargesNetwork,
        forceFail: opts.quote.liquidityUsd <= 0,
        forceFailReason: opts.quote.liquidityUsd <= 0 ? 'Emergency: token untradeable / liquidity collapsed' : undefined,
      });

      const orderId = uuid();

      if (sim.execution.failed) {
        // Still charge network if configured; keep position open unless emergency untradeable with forced close
        await client.query(
          `INSERT INTO paper_orders (
            id, portfolio_id, token_id, position_id, side, status,
            requested_price_usd, executed_price_usd, requested_amount_usd, filled_amount_usd,
            token_quantity, dex_fee_usd, network_fee_usd, priority_fee_usd, slippage_pct,
            slippage_cost_usd, price_impact_pct, price_impact_cost_usd, total_cost_usd,
            execution_record, failure_reason, data_mode, filled_at, sol_price_usd, sol_price_source
          ) VALUES ($1,$2,$3,$4,'SELL','FAILED',$5,0,$6,0,0,0,$7,$8,0,0,0,0,$9,$10,$11,$12,NOW(),$13,$14)`,
          [
            orderId,
            opts.portfolioId,
            pos.token_id,
            opts.positionId,
            opts.midPriceUsd,
            notional,
            sim.costs.networkFeeUsd,
            sim.costs.priorityFeeUsd,
            sim.costs.totalCostUsd,
            JSON.stringify(sim.execution),
            sim.execution.failureReason,
            dataMode,
            sim.costs.solPriceUsd,
            sim.costs.solPriceSource,
          ],
        );
        if (sim.costs.totalCostUsd > 0) {
          await client.query(
            `UPDATE user_portfolios SET cash_usd = GREATEST(0, cash_usd - $2),
              total_network_cost_usd = total_network_cost_usd + $2, updated_at = NOW()
             WHERE id = $1`,
            [opts.portfolioId, sim.costs.totalCostUsd],
          );
        }
        // Mark closed at zero if untradeable emergency
        if (opts.closeReason.startsWith('emergency')) {
          const costBasis = Number(pos.cost_basis_usd);
          const netPnl = -costBasis - sim.costs.totalCostUsd;
          await client.query(
            `UPDATE positions SET status = 'CLOSED', current_price_usd = 0, current_value_usd = 0,
              unrealized_pnl_usd = 0, realized_pnl_usd = $2, gross_pnl_usd = $3, net_pnl_usd = $2,
              exit_costs = $4, exit_order_id = $5, close_reason = $6, closed_at = NOW(),
              exit_signal_id = $7
             WHERE id = $1`,
            [
              opts.positionId,
              netPnl,
              -costBasis,
              JSON.stringify(sim.costs),
              orderId,
              opts.closeReason,
              opts.exitSignalId ?? null,
            ],
          );
          await client.query(
            `UPDATE user_portfolios SET realized_pnl_usd = realized_pnl_usd + $2, updated_at = NOW() WHERE id = $1`,
            [opts.portfolioId, netPnl],
          );
          return { success: true, orderId, netPnl, reason: sim.execution.failureReason ?? undefined };
        }
        return { success: false, orderId, reason: sim.execution.failureReason ?? 'Sell failed' };
      }

      // Proceeds from sell minus network/priority (DEX/slippage already in executed price)
      const proceeds = sim.execution.filledAmountUsd - sim.costs.networkFeeUsd - sim.costs.priorityFeeUsd;
      const costBasis = Number(pos.cost_basis_usd);
      const grossPnl = sim.execution.filledAmountUsd - costBasis;
      const netPnl = proceeds - costBasis;

      await client.query(
        `INSERT INTO paper_orders (
          id, portfolio_id, token_id, position_id, side, status,
          requested_price_usd, executed_price_usd, requested_amount_usd, filled_amount_usd,
          token_quantity, dex_fee_usd, network_fee_usd, priority_fee_usd, slippage_pct,
          slippage_cost_usd, price_impact_pct, price_impact_cost_usd, total_cost_usd,
          execution_record, data_mode, filled_at, sol_price_usd, sol_price_source
        ) VALUES ($1,$2,$3,$4,'SELL',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,NOW(),$21,$22)`,
        [
          orderId,
          opts.portfolioId,
          pos.token_id,
          opts.positionId,
          sim.execution.partial ? 'PARTIAL' : 'FILLED',
          sim.execution.requestedPriceUsd,
          sim.execution.executedPriceUsd,
          notional,
          sim.execution.filledAmountUsd,
          sim.execution.tokenQuantity,
          sim.costs.dexFeeUsd,
          sim.costs.networkFeeUsd,
          sim.costs.priorityFeeUsd,
          sim.execution.slippagePct,
          sim.costs.slippageCostUsd,
          sim.costs.priceImpactPct,
          sim.costs.priceImpactCostUsd,
          sim.costs.totalCostUsd,
          JSON.stringify(sim.execution),
          dataMode,
          sim.costs.solPriceUsd,
          sim.costs.solPriceSource,
        ],
      );

      await client.query(
        `INSERT INTO paper_fills (order_id, price_usd, amount_usd, token_quantity)
         VALUES ($1,$2,$3,$4)`,
        [orderId, sim.execution.executedPriceUsd, sim.execution.filledAmountUsd, qty],
      );

      await client.query(
        `UPDATE positions SET
          status = 'CLOSED',
          current_price_usd = $2,
          current_value_usd = 0,
          unrealized_pnl_usd = 0,
          realized_pnl_usd = $3,
          gross_pnl_usd = $4,
          net_pnl_usd = $3,
          exit_costs = $5,
          exit_order_id = $6,
          close_reason = $7,
          closed_at = NOW(),
          exit_signal_id = $8,
          quantity = 0
         WHERE id = $1`,
        [
          opts.positionId,
          sim.execution.executedPriceUsd,
          netPnl,
          grossPnl,
          JSON.stringify(sim.costs),
          orderId,
          opts.closeReason,
          opts.exitSignalId ?? null,
        ],
      );

      await client.query(
        `UPDATE user_portfolios SET
          cash_usd = cash_usd + $2,
          realized_pnl_usd = realized_pnl_usd + $3,
          total_fees_usd = total_fees_usd + $4,
          total_network_cost_usd = total_network_cost_usd + $5,
          total_slippage_cost_usd = total_slippage_cost_usd + $6,
          total_price_impact_cost_usd = total_price_impact_cost_usd + $7,
          updated_at = NOW()
         WHERE id = $1`,
        [
          opts.portfolioId,
          Math.max(0, proceeds),
          netPnl,
          sim.costs.dexFeeUsd,
          sim.costs.networkFeeUsd + sim.costs.priorityFeeUsd,
          sim.costs.slippageCostUsd,
          sim.costs.priceImpactCostUsd,
        ],
      );

      return { success: true, orderId, netPnl };
    });
  } catch (err) {
    logger.error({ err }, 'Paper sell failed');
    return { success: false, reason: 'DB error during paper sell' };
  }
}

export async function markPositionMarkToMarket(
  positionId: string,
  priceUsd: number,
): Promise<void> {
  await query(
    `UPDATE positions SET
      current_price_usd = $2,
      current_value_usd = quantity * $2,
      unrealized_pnl_usd = (quantity * $2) - cost_basis_usd,
      highest_price_usd = GREATEST(highest_price_usd, $2)
     WHERE id = $1 AND status = 'OPEN'`,
    [positionId, priceUsd],
  );
}

export { emptyCosts };
export type { ExecutionRecord };
