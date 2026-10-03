import { z } from 'zod';
import { strategyParamDef } from './strategy-params.js';

export const botControlSchema = z.object({
  action: z.enum(['start', 'pause']),
});

export const resetSchema = z.object({
  confirm: z.literal(true),
  scope: z.enum(['paper_account', 'all_simulation']),
});

export const portfolioSettingsSchema = z.object({
  startingBalanceUsd: z.number().positive().max(1_000_000).optional(),
  maxPositionPct: z.number().positive().max(1).optional(),
  maxSimultaneousPositions: z.number().int().positive().max(50).optional(),
  maxRiskPerTradePct: z.number().positive().max(1).optional(),
  maxDailyLossPct: z.number().positive().max(1).optional(),
  maxDrawdownPct: z.number().positive().max(1).optional(),
  stopLossPct: z.number().positive().max(1).optional(),
  takeProfitPct: z.number().positive().max(10).optional(),
  trailingStopPct: z.number().positive().max(1).nullable().optional(),
  maxHoldingTimeSec: z.number().int().positive().max(86400 * 30).optional(),
  minLiquidityUsd: z.number().nonnegative().optional(),
  minTokenAgeMinutes: z.number().nonnegative().optional(),
  maxTokenAgeMinutes: z.number().positive().optional(),
  scanIntervalMs: z.number().int().positive().min(1000).max(300000).optional(),
  failedTxStillChargesNetwork: z.boolean().optional(),
  priorityFeeLamports: z.number().int().nonnegative().optional(),
  /** { [strategyId]: { [param]: value } } — only registered parameters, within their range */
  strategyParams: z
    .record(z.string(), z.record(z.string(), z.number().finite()))
    .superRefine((byStrategy, ctx) => {
      for (const [strategyId, params] of Object.entries(byStrategy)) {
        for (const [key, value] of Object.entries(params)) {
          const def = strategyParamDef(strategyId, key);
          if (!def) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${strategyId} does not consume ${key}` });
          } else if (value < def.min || value > def.max) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `${strategyId}.${key} must be within ${def.min}–${def.max}`,
            });
          }
        }
      }
    })
    .optional(),
});

export const scannerQuerySchema = z.object({
  sort: z
    .enum([
      'age',
      'volume5m',
      'momentum',
      'liquidity',
      'risk',
      'updated',
      'score',
    ])
    .optional()
    .default('updated'),
  order: z.enum(['asc', 'desc']).optional().default('desc'),
  filter: z
    .enum([
      'all',
      'new_launches',
      'high_volume',
      'high_momentum',
      'min_liquidity',
      'low_holder_concentration',
      'accelerating',
      'high_risk',
      'watchlist',
    ])
    .optional()
    .default('all'),
  minLiquidity: z.coerce.number().optional(),
  limit: z.coerce.number().int().positive().max(200).optional().default(50),
});

export const botEventsQuerySchema = z.object({
  q: z.string().max(200).optional(),
  level: z.enum(['info', 'warn', 'error']).optional(),
  category: z.string().max(64).optional(),
  limit: z.coerce.number().int().positive().max(500).optional().default(100),
});

export const solanaAddressSchema = z
  .string()
  .min(32)
  .max(64)
  .regex(/^[1-9A-HJ-NP-Za-km-z]+$/, 'Invalid Solana address');
