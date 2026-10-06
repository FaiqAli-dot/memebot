import { query } from '../db/client.js';
import { dataMode } from '../config/env.js';
import { rejectionBucket } from './reasons.js';
import { listSourceHealth } from './source-health.js';
import { getStorageMonitor } from './storage.js';
import { portfolioLane, signalLane } from '../services/lanes.js';

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
       EXTRACT(EPOCH FROM (NOW() - COALESCE(t.pool_created_at, t.first_observed_at, t.discovered_at))) / 60 AS age_minutes,
       ls.lane AS signal_lane, ls.target_portfolio_id AS signal_target_portfolio_id, ls.strategy_name AS signal_strategy
     FROM tokens t
     LEFT JOIN LATERAL (
       SELECT liquidity_usd, market_cap_usd, volume_24h_usd, price_usd, observed_at
       FROM market_snapshots ms WHERE ms.token_id = t.id
       ORDER BY observed_at DESC LIMIT 1
     ) m ON TRUE
     LEFT JOIN LATERAL (
       SELECT lane, target_portfolio_id, strategy_name
       FROM signals sg WHERE sg.token_id = t.id
       ORDER BY created_at DESC LIMIT 1
     ) ls ON TRUE
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
      signalLane: r.signal_lane ? signalLane(r.signal_lane, r.signal_target_portfolio_id) : null,
      signalStrategyId: r.signal_strategy ?? null,
    })),
  };
}

export async function getIntelligenceTokenDetail(tokenId: string): Promise<Record<string, unknown> | null> {
  if (!UUID_RE.test(tokenId)) return null;
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

  const signals = await query(
    `SELECT id, created_at, lane, target_portfolio_id, strategy_name AS strategy_id, strategy_version, overall_score,
            confidence, data_confidence, expected_value, market_state, explanation
     FROM signals WHERE token_id = $1 ORDER BY created_at ASC`,
    [tokenId],
  );
  const attempts = await query(
    `SELECT * FROM signal_execution_attempts WHERE token_id = $1 ORDER BY first_attempt_at ASC`,
    [tokenId],
  );
  const riskDecisions = await query(
    `SELECT id, portfolio_id, signal_id, strategy_id, lane, decision, rejection_reason, detail,
            final_size_usd, max_viable_size_usd, expected_net_value, ev_threshold, multipliers,
            attempts, first_evaluated_at, evaluated_at, execution_status, execution_reason, position_id
     FROM risk_decisions WHERE token_id = $1 ORDER BY first_evaluated_at ASC`,
    [tokenId],
  );
  const orders = await query(
    `SELECT o.id, o.portfolio_id, o.signal_id, o.position_id, o.side, o.status, o.created_at, o.filled_at,
            o.requested_amount_usd, o.filled_amount_usd, o.requested_price_usd, o.executed_price_usd,
            o.token_quantity, o.total_cost_usd, o.failure_reason, o.attempt_count, o.last_attempt_at,
            COALESCE((SELECT json_agg(f ORDER BY f.created_at) FROM paper_fills f WHERE f.order_id = o.id), '[]') AS fills
     FROM paper_orders o WHERE o.token_id = $1 ORDER BY o.created_at ASC`,
    [tokenId],
  );
  const positions = await query(
    `SELECT * FROM positions WHERE token_id = $1 ORDER BY opened_at ASC`,
    [tokenId],
  );
  const pools = await query(`SELECT * FROM pools WHERE token_id = $1 ORDER BY first_seen_at ASC`, [tokenId]);
  const latestMarket = await query(
    `SELECT * FROM market_snapshots WHERE token_id = $1 ORDER BY observed_at DESC LIMIT 1`,
    [tokenId],
  );

  const byPortfolio = (rows: Row[]) =>
    rows.map((r) => ({ ...r, portfolio_lane: portfolioLane(r.portfolio_id as string | null) }));

  return {
    token: t,
    discoveryEvents: events.rows,
    decisions: decisions.rows,
    featureSnapshots: features.rows,
    outcomeCheckpoints: checkpoints.rows,
    outcomeSummaries: summaries.rows,
    signals: signals.rows.map((r) => ({
      ...r,
      portfolio_lane: signalLane(r.lane as string | null, r.target_portfolio_id as string | null),
    })),
    executionAttempts: byPortfolio(attempts.rows),
    riskDecisions: byPortfolio(riskDecisions.rows),
    orders: byPortfolio(orders.rows),
    positions: byPortfolio(positions.rows),
    pools: pools.rows,
    latestMarket: latestMarket.rows[0] ?? null,
    timeline: buildTimeline({
      token: t,
      discoveryEvents: events.rows,
      decisions: decisions.rows,
      signals: signals.rows,
      attempts: attempts.rows,
      orders: orders.rows,
      positions: positions.rows,
      checkpoints: checkpoints.rows,
    }),
  };
}

export interface TimelineEvent {
  at: string;
  kind: string;
  result: string | null;
  summary: string;
  ref: string | null;
}

type Row = Record<string, unknown>;

function iso(v: unknown): string | null {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Chronological story of one token assembled from every table that mentions it. */
export function buildTimeline(src: {
  token: Row;
  discoveryEvents: Row[];
  decisions: Row[];
  signals: Row[];
  attempts: Row[];
  orders: Row[];
  positions: Row[];
  checkpoints: Row[];
}): TimelineEvent[] {
  const out: TimelineEvent[] = [];
  const push = (at: unknown, kind: string, result: string | null, summary: string, ref: unknown = null) => {
    const ts = iso(at);
    if (ts) out.push({ at: ts, kind, result, summary, ref: ref == null ? null : String(ref) });
  };
  const short = (v: unknown) => (v == null ? '' : String(v).slice(0, 8));

  push(src.token.discovered_at, 'DISCOVERED', null, `discovered via ${src.token.discovery_source ?? 'unknown'}`);
  for (const e of src.discoveryEvents) {
    push(e.observed_at, 'DISCOVERY_EVENT', null, `seen by ${e.discovery_source ?? 'unknown'}`, e.id);
  }
  for (const d of src.decisions) {
    if (d.stage === 'DISCOVERED') continue;
    const reason = d.reason_code ? ` (${d.reason_code})` : '';
    const sig = d.signal_id ? ` signal ${short(d.signal_id)}` : '';
    push(d.decided_at, String(d.stage), String(d.result), `${d.stage} ${d.result}${reason}${sig}`, d.id);
  }
  for (const s of src.signals) {
    push(
      s.created_at,
      'SIGNAL_CREATED',
      String(s.lane),
      `${s.lane} BUY signal ${short(s.id)} by ${s.strategy_id} (score ${Number(s.overall_score).toFixed(1)})`,
      s.id,
    );
  }
  for (const a of src.attempts) {
    push(
      a.first_attempt_at,
      'EXECUTION_ATTEMPTS',
      String(a.status),
      `execution attempts for signal ${short(a.signal_id)}: ${a.attempts} tick(s), final status ${a.status}` +
        (a.status_reason ? ` (${a.status_reason})` : ''),
      a.id,
    );
    if (a.revalidated_at) {
      push(
        a.revalidated_at,
        'STRATEGY_REVALIDATION',
        String(a.revalidation_result),
        `strategy revalidation ${a.revalidation_result}` + (a.revalidation_reason ? ` (${a.revalidation_reason})` : ''),
        a.id,
      );
    }
  }
  for (const o of src.orders) {
    const attempts = Number(o.attempt_count ?? 1);
    push(
      o.created_at,
      'ORDER',
      String(o.status),
      `${o.side} order ${short(o.id)} ${o.status}` +
        (o.failure_reason ? ` (${o.failure_reason})` : '') +
        (attempts > 1 ? ` x${attempts}` : ''),
      o.id,
    );
  }
  for (const p of src.positions) {
    push(p.opened_at, 'POSITION_OPENED', 'OPEN', `position ${short(p.id)} opened`, p.id);
    if (p.closed_at) {
      const pnl = p.net_pnl_usd ?? p.realized_pnl_usd;
      push(
        p.closed_at,
        'POSITION_CLOSED',
        'CLOSED',
        `position ${short(p.id)} closed (${p.close_reason ?? 'unknown'})` +
          (pnl != null ? `, P&L $${Number(pnl).toFixed(4)}` : ''),
        p.id,
      );
    }
  }
  for (const c of src.checkpoints) {
    if (c.status !== 'CAPTURED') continue;
    push(
      c.observed_at,
      'OUTCOME_CHECKPOINT',
      String(c.checkpoint_label),
      `outcome ${c.checkpoint_label}` + (c.change_pct != null ? `: ${Number(c.change_pct).toFixed(1)}%` : ''),
      c.id,
    );
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BASE58_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export type TokenSearchMatch =
  | 'token_id'
  | 'signal_id'
  | 'order_id'
  | 'position_id'
  | 'risk_decision_id'
  | 'mint'
  | 'pool_address'
  | 'symbol'
  | 'name'
  | 'partial';

export interface TokenSearchResult {
  query: string;
  /** True when the query was an identifier (UUID or address): only exact matches are returned. */
  exactQuery: boolean;
  matchType: TokenSearchMatch | 'none';
  found: boolean;
  message: string | null;
  tokens: Array<Record<string, unknown> & { matchedOn: TokenSearchMatch }>;
}

const SEARCH_COLUMNS = `t.id AS "tokenId", t.address, t.symbol, t.name, t.chain, t.dex_venue AS venue,
  t.discovered_at AS "discoveredAt", t.last_discovered_at AS "lastDiscoveredAt",
  t.lifecycle_state AS "lifecycleState", t.intelligence_status AS "intelligenceStatus",
  t.trade_status AS "tradeStatus", t.last_rejection_reason AS "rejectionReason"`;

/**
 * Resolves any identifier to tokens. Identifiers (UUIDs, Solana addresses) only ever match
 * exactly, so an exact mint never falls back to a same-named token. Plain text matches
 * symbol / name, exact matches first.
 */
export async function searchTokens(raw: string): Promise<TokenSearchResult> {
  const q = raw.trim();
  const result = (
    matchType: TokenSearchMatch | 'none',
    tokens: TokenSearchResult['tokens'],
    exactQuery: boolean,
    message: string | null = null,
  ): TokenSearchResult => ({ query: q, exactQuery, matchType, found: tokens.length > 0, message, tokens });

  if (!q) return result('none', [], false, 'Enter a mint address, symbol, name or ID');

  const byIds = async (match: TokenSearchMatch, sql: string): Promise<TokenSearchResult['tokens']> => {
    const { rows } = await query(
      `SELECT ${SEARCH_COLUMNS} FROM tokens t WHERE t.data_mode = $2 AND t.id IN (${sql})`,
      [q, dataMode],
    );
    return rows.map((r) => ({ ...r, matchedOn: match }));
  };

  if (UUID_RE.test(q)) {
    const lookups: Array<[TokenSearchMatch, string]> = [
      ['token_id', `SELECT $1::uuid`],
      ['signal_id', `SELECT token_id FROM signals WHERE id = $1::uuid`],
      ['order_id', `SELECT token_id FROM paper_orders WHERE id = $1::uuid`],
      ['position_id', `SELECT token_id FROM positions WHERE id = $1::uuid`],
      ['risk_decision_id', `SELECT token_id FROM risk_decisions WHERE id = $1::uuid`],
    ];
    for (const [match, sql] of lookups) {
      const tokens = await byIds(match, sql);
      if (tokens.length) return result(match, tokens, true);
    }
    return result('none', [], true, 'No token, signal, order, position or risk decision has this ID');
  }

  if (BASE58_ADDRESS_RE.test(q)) {
    const mint = await byIds('mint', `SELECT id FROM tokens WHERE address = $1`);
    if (mint.length) return result('mint', mint, true);
    const pool = await byIds(
      'pool_address',
      `SELECT token_id FROM pools WHERE pool_address = $1
       UNION SELECT id FROM tokens WHERE pool_address = $1 OR dbc_pool_address = $1
       UNION SELECT token_id FROM token_discovery_events WHERE pool_address = $1 AND token_id IS NOT NULL`,
    );
    if (pool.length) return result('pool_address', pool, true);
    return result(
      'none',
      [],
      true,
      'Not discovered: no token with this mint or pool address has been recorded',
    );
  }

  const { rows } = await query(
    `SELECT ${SEARCH_COLUMNS},
            CASE WHEN lower(t.symbol) = lower($1) THEN 'symbol'
                 WHEN lower(t.name) = lower($1) THEN 'name'
                 ELSE 'partial' END AS "matchedOn"
     FROM tokens t
     WHERE t.data_mode = $2
       AND (t.symbol ILIKE $3 OR t.name ILIKE $3 OR t.address ILIKE $3)
     ORDER BY (lower(t.symbol) = lower($1) OR lower(t.name) = lower($1)) DESC,
              t.last_discovered_at DESC NULLS LAST, t.discovered_at DESC
     LIMIT 50`,
    [q, dataMode, `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`],
  );
  const tokens = rows as TokenSearchResult['tokens'];
  return result(tokens[0]?.matchedOn ?? 'none', tokens, false, tokens.length ? null : 'No token matches this text');
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
