export const DEFAULT_PORTFOLIO_ID = '00000000-0000-4000-8000-000000000001';
export const INITIAL_BALANCE_USD = 100;
export const SOLANA_CHAIN = 'solana' as const;

export const RISK_LABELS = ['LOWER_RISK', 'MODERATE', 'HIGH', 'EXTREME'] as const;
export type RiskLabel = (typeof RISK_LABELS)[number];

export const BOT_STATUSES = ['RUNNING', 'PAUSED', 'STOPPED'] as const;
export type BotStatus = (typeof BOT_STATUSES)[number];

export const ORDER_SIDES = ['BUY', 'SELL'] as const;
export type OrderSide = (typeof ORDER_SIDES)[number];

export const ORDER_STATUSES = [
  'PENDING',
  'PARTIAL',
  'FILLED',
  'FAILED',
  'CANCELLED',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const POSITION_STATUSES = ['OPEN', 'CLOSED'] as const;
export type PositionStatus = (typeof POSITION_STATUSES)[number];

export const DATA_MODES = ['demo', 'live'] as const;
export type DataMode = (typeof DATA_MODES)[number];

export const SCORE_DISCLAIMER =
  'Scores are model scores based on measurable market features, not probabilities of profit. Past simulated results do not predict future outcomes. This is paper trading only — no real money.';
