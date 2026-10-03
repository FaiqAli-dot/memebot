import { query } from '../db/client.js';
import { dataMode } from '../config/env.js';
import { rejectionBucket } from './reasons.js';
import { listSourceHealth } from './source-health.js';
import { getStorageMonitor } from './storage.js';

export interface IntelligenceListFilters {
  q?: string;
  discoverySource?: string;
  venue?: string;
  status?: string;
  rejectionReason?: string;
  traded?: 'yes' | 'no' | 'all';
  signalGenerated?: 'yes' | 'no' | 'all';
  minAgeMinutes?: number;
  maxAgeMinutes?: number;
  minMarketCap?: number;
  maxMarketCap?: number;
  minLiquidity?: number;
  maxLiquidity?: number;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

export async function getIntelligenceSummary(): Promise<Record<string, unknown>> {
  const { rows: totals } = await query<{
    discovered: string;
    unique_tokens: string;
    tracked: string;
    eligible: string;
    signals: string;
    traded: string;
    rejected: string;
    position_cap: string;
  }>(
    `SELECT
       COUNT(*)::text AS discovered,
       COUNT(*)::text AS unique_tokens,
       COUNT(*) FILTER (WHERE tracking_started OR lifecycle_state IN ('TRACKING','ELIGIBLE','ACTIVE','STALE'))::text AS tracked,
       COUNT(*) FILTER (WHERE trading_eligibility = 'TRADING_ELIGIBLE' OR lifecycle_state IN ('ELIGIBLE','ACTIVE'))::text AS eligible,
       COUNT(*) FILTER (WHERE last_signal_score IS NOT NULL OR intelligence_status IN ('SIGNAL','RISK_GATE','TRADED'))::text AS signals,
       COUNT(*) FILTER (WHERE trade_status = 'TRADED')::text AS traded,
       COUNT(*) FILTER (WHERE last_rejection_reason IS NOT NULL AND trade_status <> 'TRADED')::text AS rejected,
       COUNT(*) FILTER (WHERE last_rejection_reason = 'MAX_OPEN_POSITIONS')::text AS position_cap
     FROM tokens WHERE data_mode = $1`,
    [dataMode],
  );

  const { rows: reasonRows } = await query<{ reason_code: string; c: string }>(
    `SELECT reason_code, COUNT(*)::text AS c
     FROM token_decision_audits
     WHERE data_mode = $1 AND result = 'FAIL' AND reason_code IS NOT NULL
     GROUP BY reason_code
     ORDER BY COUNT(*) DESC
     LIMIT 40`,
    [dataMode],
  );

  const rejectionBreakdown: Record<string, number> = {
    liquidity: 0,
    age: 0,
    market_cap: 0,
    volume: 0,
    risk: 0,
    signal_threshold: 0,
    position_capacity: 0,
    other: 0,
  };
  for (const r of reasonRows) {
    const bucket = rejectionBucket(r.reason_code);
    rejectionBreakdown[bucket] = (rejectionBreakdown[bucket] ?? 0) + Number(r.c);
  }

  const t = totals[0]!;
  return {
    tokensDiscovered: Number(t.discovered),
    uniqueTokens: Number(t.unique_tokens),
    currentlyTracked: Number(t.tracked),
    eligible: Number(t.eligible),
    signalsGenerated: Number(t.signals),
    tradesOpened: Number(t.traded),
    rejected: Number(t.rejected),
    positionCapRejections: Number(t.position_cap),
    rejectionBreakdown,
    reasonCounts: Object.fromEntries(reasonRows.map((r) => [r.reason_code, Number(r.c)])),
  };
}

export async function listIntelligenceTokens(filters: IntelligenceListFilters): Promise<{
  rows: Record<string, unknown>[];
  total: number;
}> {
  const lim = Math.min(filters.limit ?? 50, 200);
  const off = Math.max(filters.offset ?? 0, 0);
  const params: unknown[] = [dataMode];
  const where: string[] = ['t.data_mode = $1'];

  const add = (clause: string, value: unknown) => {
    params.push(value);
    where.push(clause.replace(/\$X/g, `$${params.length}`));
  };

  if (filters.q) {
    add(
      `(t.symbol ILIKE $X OR t.name ILIKE $X OR t.address ILIKE $X)`,
      `%${filters.q}%`,
    );
  }
  if (filters.discoverySource) {
    add(
      `(t.discovery_source = $X OR t.discovery_sources ? $X)`,
      filters.discoverySource,
    );
  }
  if (filters.venue) add(`t.dex_venue = $X`, filters.venue);
  if (filters.status) add(`t.intelligence_status = $X`, filters.status);
  if (filters.rejectionReason) add(`t.last_rejection_reason = $X`, filters.rejectionReason);
  if (filters.traded === 'yes') where.push(`t.trade_status = 'TRADED'`);
  if (filters.traded === 'no') where.push(`t.trade_status <> 'TRADED'`);
  if (filters.signalGenerated === 'yes') where.push(`t.last_signal_score IS NOT NULL`);
  if (filters.signalGenerated === 'no') where.push(`t.last_signal_score IS NULL`);
  if (filters.minLiquidity != null) {
    add(`COALESCE(m.liquidity_usd, t.initial_liquidity_usd, 0) >= $X`, filters.minLiquidity);
  }
  if (filters.maxLiquidity != null) {
    add(`COALESCE(m.liquidity_usd, t.initial_liquidity_usd, 0) <= $X`, filters.maxLiquidity);
  }
  if (filters.minMarketCap != null) {
    add(`COALESCE(m.market_cap_usd, t.initial_market_cap_usd, 0) >= $X`, filters.minMarketCap);
  }
  if (filters.maxMarketCap != null) {
    add(`COALESCE(m.market_cap_usd, t.initial_market_cap_usd, 0) <= $X`, filters.maxMarketCap);
  }
  if (filters.from) add(`t.discovered_at >= $X::timestamptz`, filters.from);
  if (filters.to) add(`t.discovered_at <= $X::timestamptz`, filters.to);

  const whereSql = where.join(' AND ');
  const { rows: countRows } = await query<{ c: string }>(
    `SELECT COUNT(*)::text AS c
     FROM tokens t
     LEFT JOIN LATERAL (
       SELECT liquidity_usd, market_cap_usd, volume_24h_usd, price_usd, observed_at
       FROM market_snapshots ms WHERE ms.token_id = t.id
       ORDER BY observed_at DESC LIMIT 1
     ) m ON TRUE
     WHERE ${whereSql}`,
    params,
  );

  const limIdx = params.length + 1;
  const offIdx = params.length + 2;
  params.push(lim, off);
  const { rows } = await query(
    `SELECT
       t.id, t.address, t.symbol, t.name, t.discovered_at, t.first_observed_at,
       t.last_discovered_at, t.discovery_source, t.discovery_sources, t.dex_venue,
       t.launch_mechanism, t.dbc_status, t.migration_status, t.post_migration_venue,
       t.intelligence_status, t.last_rejection_reason, t.last_signal_score,
       t.last_risk_status, t.trade_status, t.tracking_started, t.snapshot_count,
       t.initial_liquidity_usd, t.initial_market_cap_usd, t.initial_price_usd,
       t.lifecycle_state, t.trading_eligibility,
       m.price_usd, m.market_cap_usd, m.liquidity_usd, m.volume_24h_usd, m.observed_at AS last_market_at,
       EXTRACT(EPOCH FROM (NOW() - COALESCE(t.pool_created_at, t.first_observed_at, t.discovered_at))) / 60 AS age_minutes
     FROM tokens t
     LEFT JOIN LATERAL (
       SELECT liquidity_usd, market_cap_usd, volume_24h_usd, price_usd, observed_at
       FROM market_snapshots ms WHERE ms.token_id = t.id
       ORDER BY observed_at DESC LIMIT 1
     ) m ON TRUE
     WHERE ${whereSql}
     ORDER BY t.last_discovered_at DESC NULLS LAST, t.discovered_at DESC
     LIMIT $${limIdx} OFFSET $${offIdx}`,
    params,
  );

  return {
    total: Number(countRows[0]?.c ?? 0),
    rows: rows.map((r) => ({
      tokenId: r.id,
      address: r.address,
      symbol: r.symbol,
      name: r.name,
      ageMinutes: r.age_minutes != null ? Number(r.age_minutes) : null,
      marketCap: r.market_cap_usd != null ? Number(r.market_cap_usd) : r.initial_market_cap_usd != null ? Number(r.initial_market_cap_usd) : null,
      liquidity: r.liquidity_usd != null ? Number(r.liquidity_usd) : r.initial_liquidity_usd != null ? Number(r.initial_liquidity_usd) : null,
      volume: r.volume_24h_usd != null ? Number(r.volume_24h_usd) : null,
      venue: r.dex_venue,
      discoverySource: r.discovery_source,
      discoverySources: r.discovery_sources,
      firstSeen: r.discovered_at,
      status: r.intelligence_status,
      signalScore: r.last_signal_score != null ? Number(r.last_signal_score) : null,
      riskStatus: r.last_risk_status,
      tradeStatus: r.trade_status,
      rejectionReason: r.last_rejection_reason,
      dbcStatus: r.dbc_status,
      migrationStatus: r.migration_status,
      lifecycleState: r.lifecycle_state,
    })),
  };
}

export async function getIntelligenceTokenDetail(tokenId: string): Promise<Record<string, unknown> | null> {
  const { rows } = await query(`SELECT * FROM tokens WHERE id = $1 AND data_mode = $2`, [
    tokenId,
    dataMode,
  ]);
  const t = rows[0];
  if (!t) return null;

  const events = await query(
    `SELECT * FROM token_discovery_events WHERE token_id = $1 ORDER BY observed_at ASC`,
    [tokenId],
  );
  const decisions = await query(
    `SELECT * FROM token_decision_audits WHERE token_id = $1 ORDER BY decided_at ASC`,
    [tokenId],
  );
  const features = await query(
    `SELECT * FROM token_decision_feature_snapshots WHERE token_id = $1 ORDER BY observed_at ASC`,
    [tokenId],
  );
  const checkpoints = await query(
    `SELECT * FROM token_outcome_checkpoints WHERE token_id = $1 ORDER BY due_at ASC`,
    [tokenId],
  );
  const summaries = await query(
    `SELECT * FROM token_outcome_summaries WHERE token_id = $1 ORDER BY created_at DESC`,
    [tokenId],
  );

  return {
    token: t,
    discoveryEvents: events.rows,
    decisions: decisions.rows,
    featureSnapshots: features.rows,
    outcomeCheckpoints: checkpoints.rows,
    outcomeSummaries: summaries.rows,
  };
}

export async function getMissedOpportunityAnalysis(): Promise<{
  falseNegatives: Record<string, unknown>[];
  successfulRejections: Record<string, unknown>[];
}> {
  const { rows } = await query(
    `SELECT s.*, t.symbol, t.address, t.last_rejection_reason, t.trade_status
     FROM token_outcome_summaries s
     JOIN tokens t ON t.id = s.token_id
     WHERE s.data_mode = $1
     ORDER BY s.created_at DESC
     LIMIT 100`,
    [dataMode],
  );
  const falseNegatives = rows
    .filter((r) => r.classification === 'FALSE_NEGATIVE_CANDIDATE')
    .map((r) => ({
      tokenId: r.token_id,
      symbol: r.symbol,
      address: r.address,
      decision: 'NOT_TRADED',
      reason: r.last_rejection_reason,
      decisionMarketCap: r.decision_market_cap != null ? Number(r.decision_market_cap) : null,
      decisionLiquidity: r.decision_liquidity != null ? Number(r.decision_liquidity) : null,
      laterMarketCap: null,
      maxGain24h: r.max_gain_24h != null ? Number(r.max_gain_24h) : null,
      outcomeSummary: r.outcome_summary,
    }));
  const successfulRejections = rows
    .filter((r) => r.classification === 'SUCCESSFUL_REJECTION')
    .map((r) => ({
      tokenId: r.token_id,
      symbol: r.symbol,
      address: r.address,
      decision: 'NOT_TRADED',
      reason: r.last_rejection_reason,
      maxDrawdown24h: r.max_drawdown_24h != null ? Number(r.max_drawdown_24h) : null,
      outcomeSummary: r.outcome_summary,
    }));
  return { falseNegatives, successfulRejections };
}

export async function getIntelligenceDashboard(): Promise<Record<string, unknown>> {
  const { getMeteoraDbcHealth } = await import('./meteora-dbc-health.js');
  const [summary, sources, storage, missed, meteoraDbc] = await Promise.all([
    getIntelligenceSummary(),
    listSourceHealth(),
    getStorageMonitor(),
    getMissedOpportunityAnalysis(),
    getMeteoraDbcHealth(),
  ]);
  return { summary, sources, storage, missed, meteoraDbc };
}
