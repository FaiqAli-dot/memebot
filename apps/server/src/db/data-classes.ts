/**
 * Every table is in exactly one class (asserted by tests). Retention and emergency cleanup only
 * ever delete from RESEARCH tables (and COMPACT_RESEARCH past the research period); CRITICAL and
 * OPERATIONAL tables are never pruned by storage jobs.
 */

/** Must survive: identity, trading, accounting, audit of trading decisions. */
export const CRITICAL_TABLES = [
  'tokens',
  'positions',
  'paper_orders',
  'paper_fills',
  'fee_records',
  'signals',
  'risk_decisions',
  'signal_execution_attempts',
  'portfolio_snapshots',
  'strategy_runs',
  'trade_observations',
  'daily_reports',
  'user_portfolios',
  'users',
  'wallets',
] as const;

/** Kept for the research period (COMPACT_RESEARCH_RETENTION_DAYS) or permanently. */
export const COMPACT_RESEARCH_TABLES = [
  'token_decision_audits',
  'token_decision_feature_snapshots',
  'token_outcome_checkpoints',
  'token_outcome_summaries',
  'token_discovery_events',
  'missed_opportunities',
  'learning_runs',
  'learning_health_checks',
  'learning_anomalies',
  'calibration_runs',
  'calibration_versions',
  'calibration_activations',
  'backtest_runs',
  'experiments',
] as const;

/** Temporary: expired aggressively, first to go under storage pressure. */
export const RESEARCH_TABLES = [
  'market_snapshots',
  'liquidity_snapshots',
  'holder_snapshots',
  'holder_details',
  'safety_assessments',
  'feature_snapshots',
  'trade_events',
  'token_raw_feature_observations',
  'token_phases',
  'shadow_trades',
  'funnel_snapshots',
  'opportunities',
  'opportunity_trackers',
  'opportunity_outcomes',
  'regime_snapshots',
  'market_events',
  'system_health',
  'bot_events',
  'alert_log',
  'quote_snapshots',
  'token_snapshots',
  'provider_disagreements',
  'storage_monitor_snapshots',
  'retention_runs',
] as const;

/** Configuration / bookkeeping. */
export const OPERATIONAL_TABLES = [
  'schema_migrations',
  'config_registry',
  'strategies',
  'pools',
  'discovery_source_health',
] as const;

export type DataClass = 'CRITICAL' | 'COMPACT_RESEARCH' | 'RESEARCH' | 'OPERATIONAL';

export function dataClassOf(table: string): DataClass | null {
  if ((CRITICAL_TABLES as readonly string[]).includes(table)) return 'CRITICAL';
  if ((COMPACT_RESEARCH_TABLES as readonly string[]).includes(table)) return 'COMPACT_RESEARCH';
  if ((RESEARCH_TABLES as readonly string[]).includes(table)) return 'RESEARCH';
  if ((OPERATIONAL_TABLES as readonly string[]).includes(table)) return 'OPERATIONAL';
  return null;
}
