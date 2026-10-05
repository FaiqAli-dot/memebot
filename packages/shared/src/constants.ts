export const DEFAULT_PORTFOLIO_ID = '00000000-0000-4000-8000-000000000001';
/** Separate paper portfolio for borderline research trades — never mixed into production stats. */
export const RESEARCH_PORTFOLIO_ID = '00000000-0000-4000-8000-000000000002';
/** Separate paper portfolio for older-token momentum research — never mixed into production stats. */
export const OLDER_TOKEN_RESEARCH_PORTFOLIO_ID = '00000000-0000-4000-8000-000000000003';

export const PORTFOLIO_TYPES = ['PRODUCTION', 'RESEARCH'] as const;
export type PortfolioType = (typeof PORTFOLIO_TYPES)[number];

export const SIGNAL_LANES = ['PRODUCTION', 'RESEARCH'] as const;
export type SignalLane = (typeof SIGNAL_LANES)[number];

export const TOKEN_LIFECYCLE_STATES = [
  'DISCOVERED',
  'TRACKING',
  'ELIGIBLE',
  'ACTIVE',
  'STALE',
  'ARCHIVED',
] as const;
export type TokenLifecycleState = (typeof TOKEN_LIFECYCLE_STATES)[number];

export const LIQUIDITY_STATUSES = ['KNOWN', 'UNKNOWN', 'BONDING_CURVE'] as const;
export type LiquidityStatus = (typeof LIQUIDITY_STATUSES)[number];

export const TRADING_ELIGIBILITIES = ['TRADING_ELIGIBLE', 'RESEARCH_ONLY', 'UNKNOWN'] as const;
export type TradingEligibility = (typeof TRADING_ELIGIBILITIES)[number];

export const AGE_SOURCES = ['POOL_CREATED_AT', 'FIRST_OBSERVED_AT'] as const;
export type AgeSource = (typeof AGE_SOURCES)[number];
export const INITIAL_BALANCE_USD = 100;
export const SOLANA_CHAIN = 'solana' as const;

export const RISK_LABELS = ['LOWER_RISK', 'MODERATE', 'HIGH', 'EXTREME'] as const;
export type RiskLabel = (typeof RISK_LABELS)[number];

export const SAFETY_CLASSES = [
  'BLOCKED',
  'EXTREME_RISK',
  'HIGH_RISK',
  'MEDIUM_RISK',
  'LOWER_RISK',
  'UNKNOWN',
] as const;
export type SafetyClass = (typeof SAFETY_CLASSES)[number];

export const BOT_STATUSES = ['RUNNING', 'PAUSED', 'STOPPED', 'KILLED'] as const;
export type BotStatus = (typeof BOT_STATUSES)[number];

export const RISK_STATES = ['NORMAL', 'CAUTION', 'HALTED', 'RECOVERY', 'OK', 'MAX_DRAWDOWN', 'MAX_DAILY_LOSS', 'MAX_POSITIONS', 'INSUFFICIENT_CASH', 'KILL_SWITCH'] as const;
export type RiskState = (typeof RISK_STATES)[number];

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

export const TRADING_MODES = ['PAPER'] as const;
export type TradingMode = (typeof TRADING_MODES)[number];

export const MARKET_REGIMES = ['DEAD', 'COLD', 'NORMAL', 'HOT', 'EXTREME'] as const;
export type MarketRegime = (typeof MARKET_REGIMES)[number];

export const TOKEN_PHASES = [
  'LAUNCH',
  'DISCOVERY',
  'EARLY_MOMENTUM',
  'ACCELERATION',
  'PEAKING',
  'DISTRIBUTION',
  'DECLINE',
  'DEAD',
] as const;
export type TokenPhase = (typeof TOKEN_PHASES)[number];

export const DISCOVERY_SOURCES = [
  'DEXSCREENER_BOOST',
  'DEXSCREENER_NEW_PAIR',
  'GECKO_NEW_POOL',
  'METEORA_DBC',
  'PUMPFUN_LAUNCH',
  'TRADE_STREAM',
  'DEMO_ORGANIC',
  'DEMO_SYNTHETIC',
  'MANUAL',
  'UNKNOWN',
] as const;
export type DiscoverySource = (typeof DISCOVERY_SOURCES)[number];

/** Canonical discoverySource keys used in APIs / dashboards (snake/lower where helpful). */
export const DISCOVERY_SOURCE_LABELS: Record<DiscoverySource, string> = {
  DEXSCREENER_BOOST: 'dexscreener_boosts',
  DEXSCREENER_NEW_PAIR: 'dexscreener_profiles',
  GECKO_NEW_POOL: 'geckoterminal_new_pools',
  METEORA_DBC: 'meteora_dbc',
  PUMPFUN_LAUNCH: 'pumpfun_launch',
  TRADE_STREAM: 'trade_stream',
  DEMO_ORGANIC: 'demo_organic',
  DEMO_SYNTHETIC: 'demo_synthetic',
  MANUAL: 'manual',
  UNKNOWN: 'unknown',
};

export const REJECTION_REASONS = [
  'SAFETY_REJECTION',
  'LIQUIDITY_REJECTION',
  'VOLUME_REJECTION',
  'MOMENTUM_REJECTION',
  'REGIME_REJECTION',
  'POSITION_LIMIT',
  'RISK_LIMIT',
  'EXPECTED_VALUE_TOO_LOW',
  'DUPLICATE_POSITION',
  'COOLDOWN',
  'STALE_DATA',
  'KILL_SWITCH',
  'UNKNOWN',
] as const;
export type RejectionReason = (typeof REJECTION_REASONS)[number];

/**
 * Machine-readable decision audit reason codes.
 * Mapped onto existing gates — do not invent new trading gates.
 */
export const DECISION_REASON_CODES = [
  // Discovery
  'INVALID_ADDRESS',
  'UNSUPPORTED_TOKEN_FORMAT',
  // Eligibility / universe
  'TOKEN_TOO_YOUNG',
  'TOKEN_TOO_OLD',
  'LIQUIDITY_TOO_LOW',
  'LIQUIDITY_UNKNOWN',
  'MARKET_CAP_TOO_LOW',
  'MARKET_CAP_TOO_HIGH',
  'INSUFFICIENT_VOLUME',
  'INSUFFICIENT_HOLDERS',
  'UNSUPPORTED_VENUE',
  'HIGH_RISK',
  'STALE_MARKET_DATA',
  // Signal
  'SCORE_BELOW_THRESHOLD',
  'EXPECTED_VALUE_TOO_LOW',
  'STRATEGY_REJECTED',
  'KILL_SWITCH_ACTIVE',
  // Risk
  'LIQUIDITY_RISK',
  'EXECUTION_RISK',
  'POSITION_SIZE_TOO_LARGE',
  'CORRELATED_EXPOSURE',
  'VOLATILITY_EXTREME',
  'INSUFFICIENT_CASH',
  'RISK_STATE_BLOCKED',
  // Position capacity
  'MAX_OPEN_POSITIONS',
  'INSUFFICIENT_CAPACITY',
  // Execution-time strategy revalidation
  'SIGNAL_INVALIDATED',
  // Outcomes
  'TRADED',
  'NOT_TRADED',
  'UNKNOWN',
] as const;
export type DecisionReasonCode = (typeof DECISION_REASON_CODES)[number];

export const DECISION_STAGES = [
  'DISCOVERED',
  'NORMALIZED',
  'TRACKED',
  'ELIGIBILITY',
  'SIGNAL',
  'STRATEGY_REVALIDATION',
  'RISK_GATE',
  'POSITION_CAPACITY',
  'FINAL_OUTCOME',
] as const;
export type DecisionStage = (typeof DECISION_STAGES)[number];

export const DBC_STATUSES = [
  'PRE_BONDING_CURVE',
  'POST_BONDING_CURVE',
  'LOCKED_VESTING',
  'CREATED_POOL',
  'UNKNOWN',
] as const;
export type DbcStatus = (typeof DBC_STATUSES)[number];

export const MIGRATION_STATUSES = [
  'NOT_MIGRATED',
  'MIGRATING',
  'MIGRATED',
  'UNKNOWN',
] as const;
export type MigrationStatus = (typeof MIGRATION_STATUSES)[number];

export const OUTCOME_CHECKPOINT_LABELS = [
  '5m',
  '15m',
  '30m',
  '1h',
  '3h',
  '6h',
  '12h',
  '24h',
] as const;
export type OutcomeCheckpointLabel = (typeof OUTCOME_CHECKPOINT_LABELS)[number];

export const FRESHNESS_LEVELS = ['FRESH', 'STALE', 'VERY_STALE', 'UNKNOWN'] as const;
export type FreshnessLevel = (typeof FRESHNESS_LEVELS)[number];

export const CONFIDENCE_LEVELS = ['HIGH', 'MEDIUM', 'LOW', 'UNKNOWN'] as const;
export type ConfidenceLevel = (typeof CONFIDENCE_LEVELS)[number];

export const REALISM_PROFILES = ['OPTIMISTIC', 'REALISTIC', 'CONSERVATIVE'] as const;
export type RealismProfile = (typeof REALISM_PROFILES)[number];

export const FLOW_WINDOWS_MS = {
  '10s': 10_000,
  '30s': 30_000,
  '1m': 60_000,
  '3m': 180_000,
  '5m': 300_000,
  '15m': 900_000,
  '30m': 1_800_000,
  '1h': 3_600_000,
} as const;
export type FlowWindow = keyof typeof FLOW_WINDOWS_MS;

export const SCORE_DISCLAIMER =
  'Scores are model scores based on measurable market features, not probabilities of profit. Past simulated results do not predict future outcomes. This is paper trading only — no real money.';

export const PAPER_ONLY_DISCLAIMER =
  'PAPER TRADING ONLY. No wallets, private keys, signing, real swaps, or mainnet execution. REAL_EXECUTION_ENABLED and WALLET_SIGNING_ENABLED must remain false.';
