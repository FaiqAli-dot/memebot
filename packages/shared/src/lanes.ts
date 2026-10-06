/**
 * Display lanes for the dashboard. The backend resolves a row's lane from the paper portfolio it
 * belongs to (positions/orders/events) or was routed to (signals); clients only render it.
 */
export const PORTFOLIO_LANES = ['PRODUCTION', 'OLDER_TOKEN_RESEARCH', 'EXPLORATION_RESEARCH'] as const;
export type PortfolioLane = (typeof PORTFOLIO_LANES)[number];

export const PORTFOLIO_LANE_LABELS: Record<PortfolioLane, string> = {
  PRODUCTION: 'NEW TOKEN · PRODUCTION',
  OLDER_TOKEN_RESEARCH: 'OLDER TOKEN · RESEARCH',
  EXPLORATION_RESEARCH: 'EXPLORATION · RESEARCH',
};

export const PORTFOLIO_LANE_SHORT_LABELS: Record<PortfolioLane, string> = {
  PRODUCTION: 'NEW TOKEN',
  OLDER_TOKEN_RESEARCH: 'OLDER TOKEN',
  EXPLORATION_RESEARCH: 'EXPLORATION',
};

/** Which portfolios a list endpoint returns. `production` is the default and the only scope used for stats. */
export const PORTFOLIO_SCOPES = ['production', 'older-research', 'exploration', 'all'] as const;
export type PortfolioScope = (typeof PORTFOLIO_SCOPES)[number];

export const STRATEGY_LABELS: Record<string, string> = {
  'early-volume-expansion': 'EARLY VOLUME',
  'liquidity-expansion': 'LIQUIDITY EXPANSION',
  'momentum-breakout': 'MOMENTUM BREAKOUT',
  'older-breakout': 'OLDER BREAKOUT',
  'older-revival': 'REVIVAL',
};

export function strategyLabel(strategyId: string | null | undefined): string | null {
  if (!strategyId) return null;
  return STRATEGY_LABELS[strategyId] ?? strategyId.toUpperCase();
}
