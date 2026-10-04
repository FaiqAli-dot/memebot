/**
 * Token Intelligence ledger — persistent discovery identity + multi-source events.
 * Discovery ≠ trade eligibility; this is an observation layer only.
 */
import type { DecisionReasonCode, DecisionStage, DiscoverySource } from '@memebot/shared';
import { query } from '../db/client.js';
import { dataMode, env } from '../config/env.js';
import type { EnrichedDiscoveredToken } from '../providers/discovery/multi-source.js';
import { isSolanaAddress } from '../utils/helpers.js';
import { WriteDedupe } from '../db/write-dedupe.js';
import { researchWritesAllowed } from '../db/storage-guard.js';

/**
 * Stages evaluated on every market/signal tick. Re-recorded only when the outcome changes or the
 * dedupe window elapses; skipped entirely (returns '') when storage is critical.
 */
const HIGH_FREQUENCY_STAGES = new Set(['DISCOVERED', 'NORMALIZED', 'TRACKED', 'ELIGIBILITY', 'SIGNAL']);
/** Rejections re-evaluated every tick while a slot is full; deduped but always recorded once. */
const REPEATING_REJECTION_STAGES = new Set(['RISK_GATE', 'POSITION_CAPACITY']);
/**
 * Re-run on every execution tick for a live signal. With a signal id, each distinct
 * result + reason is recorded once per signal (PASS included), so rows stay bounded by the
 * number of outcomes, not the number of ticks.
 */
const EXECUTION_STAGES = new Set(['STRATEGY_REVALIDATION', 'RISK_GATE', 'POSITION_CAPACITY']);
const auditDedupe = new WriteDedupe<string>();
const discoveryDedupe = new WriteDedupe();

export function resetIntelligenceDedupeForTests(): void {
  auditDedupe.clear();
  discoveryDedupe.clear();
}

export interface RecordDiscoveryResult {
  tokenId: string | null;
  isNew: boolean;
  reasonCode?: DecisionReasonCode;
  normalized: boolean;
}

function metaString(meta: Record<string, unknown> | undefined, key: string): string | null {
  const v = meta?.[key];
  return typeof v === 'string' ? v : null;
}

export async function recordDiscoveryObservation(
  token: EnrichedDiscoveredToken,
  tokenId: string | null,
): Promise<RecordDiscoveryResult> {
  if (!tokenId) {
    const reason: DecisionReasonCode =
      dataMode === 'live' && !isSolanaAddress(token.address)
        ? 'INVALID_ADDRESS'
        : 'UNSUPPORTED_TOKEN_FORMAT';
    return { tokenId: null, isNew: false, reasonCode: reason, normalized: false };
  }

  const meta = (token.metadata ?? {}) as Record<string, unknown>;
  const launchMechanism =
    metaString(meta, 'launchMechanism') ??
    (token.discoverySource === 'METEORA_DBC' ? 'meteora_dbc' : null);
  const dbcStatus = metaString(meta, 'dbcStatus');
  const migrationStatus = metaString(meta, 'migrationStatus');
  const postMigrationVenue = metaString(meta, 'postMigrationVenue');
  const dbcPoolAddress =
    metaString(meta, 'dbcPoolAddress') ??
    (token.discoverySource === 'METEORA_DBC' ? token.poolAddress ?? null : null);

  const existing = await query<{
    id: string;
    discovery_sources: unknown;
    intelligence_status: string;
  }>(
    `SELECT id, discovery_sources, intelligence_status FROM tokens WHERE id = $1`,
    [tokenId],
  );
  const row = existing.rows[0];
  const prevSources = Array.isArray(row?.discovery_sources)
    ? (row!.discovery_sources as string[])
    : [];
  const sources = [...new Set([...prevSources, token.discoverySource])];

  await query(
    `UPDATE tokens SET
       discovery_sources = $2::jsonb,
       last_discovered_at = NOW(),
       launch_mechanism = COALESCE(launch_mechanism, $3),
       dbc_status = COALESCE($4, dbc_status),
       migration_status = COALESCE($5, migration_status),
       post_migration_venue = COALESCE($6, post_migration_venue),
       dbc_pool_address = COALESCE(dbc_pool_address, $7),
       dex_venue = CASE
         WHEN $8::text IS NOT NULL AND (dex_venue IS NULL OR dex_venue = 'unknown') THEN $8
         WHEN $8::text = 'meteora_damm' THEN $8
         ELSE dex_venue
       END,
       pool_address = COALESCE(pool_address, $9),
       intelligence_status = CASE
         WHEN intelligence_status = 'DISCOVERED' THEN 'DISCOVERED'
         ELSE intelligence_status
       END
     WHERE id = $1`,
    [
      tokenId,
      JSON.stringify(sources),
      launchMechanism,
      dbcStatus,
      migrationStatus,
      postMigrationVenue,
      dbcPoolAddress,
      token.dexVenue ?? null,
      token.poolAddress ?? null,
    ],
  );

  const discoveryKey = `${tokenId}|${token.discoverySource}`;
  const discoveryWindowMs = env.DISCOVERY_EVENT_DEDUPE_MINUTES * 60_000;
  const isRepeatSighting = discoveryDedupe.recent(discoveryKey, '', discoveryWindowMs) != null;
  if (!isRepeatSighting && researchWritesAllowed()) {
    discoveryDedupe.remember(discoveryKey, '');
    await query(
      `INSERT INTO token_discovery_events (
         token_id, discovery_source, venue, pool_address, launch_mechanism,
         dbc_status, migration_status, observed_at, payload, data_mode
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,NOW(),$8,$9)`,
      [
        tokenId,
        token.discoverySource,
        token.dexVenue ?? null,
        token.poolAddress ?? null,
        launchMechanism,
        dbcStatus,
        migrationStatus,
        JSON.stringify({
          symbol: token.symbol,
          name: token.name,
          paidBoost: token.discoverySource === 'DEXSCREENER_BOOST',
          metadata: token.metadata ?? {},
          discoveryPath:
            typeof token.metadata?.discoveryPath === 'string' ? token.metadata.discoveryPath : null,
          demoFixture: token.address.startsWith('Demo'),
          dbcStatus: token.metadata?.dbcStatus ?? null,
          migrationStatus: token.metadata?.migrationStatus ?? null,
        }),
        dataMode,
      ],
    );
  }

  return {
    tokenId,
    isNew: (row?.intelligence_status ?? 'DISCOVERED') === 'DISCOVERED' && prevSources.length <= 1,
    normalized: true,
  };
}

/**
 * One row version per market tick (snapshot counter, tracking start, first-seen market values)
 * instead of three separate UPDATEs.
 */
export async function recordMarketTick(
  tokenId: string,
  snap: {
    priceUsd?: number | null;
    marketCapUsd?: number | null;
    liquidityUsd?: number | null;
    volumeUsd?: number | null;
    holders?: number | null;
    ageMinutes?: number | null;
  },
): Promise<void> {
  await query(
    `UPDATE tokens SET
       snapshot_count = snapshot_count + 1,
       tracking_started = TRUE,
       tracking_started_at = COALESCE(tracking_started_at, NOW()),
       intelligence_status = CASE
         WHEN intelligence_status IN ('DISCOVERED', 'NORMALIZED') THEN 'TRACKED'
         ELSE intelligence_status
       END,
       initial_price_usd = COALESCE(initial_price_usd, $2),
       initial_market_cap_usd = COALESCE(initial_market_cap_usd, $3),
       initial_liquidity_usd = COALESCE(initial_liquidity_usd, $4),
       initial_volume_usd = COALESCE(initial_volume_usd, $5),
       initial_holders = COALESCE(initial_holders, $6),
       initial_token_age_minutes = COALESCE(initial_token_age_minutes, $7)
     WHERE id = $1`,
    [
      tokenId,
      snap.priceUsd ?? null,
      snap.marketCapUsd ?? null,
      snap.liquidityUsd ?? null,
      snap.volumeUsd ?? null,
      snap.holders ?? null,
      snap.ageMinutes ?? null,
    ],
  );
}

export async function updateIntelligenceStatus(
  tokenId: string,
  status: string,
  extras?: {
    rejectionReason?: DecisionReasonCode | string | null;
    signalScore?: number | null;
    riskStatus?: string | null;
    tradeStatus?: string | null;
  },
): Promise<void> {
  await query(
    `UPDATE tokens SET
       intelligence_status = $2,
       last_rejection_reason = COALESCE($3, last_rejection_reason),
       last_signal_score = COALESCE($4, last_signal_score),
       last_risk_status = COALESCE($5, last_risk_status),
       trade_status = COALESCE($6, trade_status)
     WHERE id = $1`,
    [
      tokenId,
      status,
      extras?.rejectionReason ?? null,
      extras?.signalScore ?? null,
      extras?.riskStatus ?? null,
      extras?.tradeStatus ?? null,
    ],
  );
}

export async function recordDecisionAudit(opts: {
  tokenId: string;
  portfolioId?: string | null;
  stage: DecisionStage | string;
  result: 'PASS' | 'FAIL' | 'SKIP' | 'TRADED' | 'NOT_TRADED';
  reasonCode?: DecisionReasonCode | string | null;
  actualValues?: Record<string, unknown>;
  requiredValues?: Record<string, unknown>;
  details?: Record<string, unknown>;
  strategyId?: string | null;
  signalId?: string | null;
  riskDecisionId?: string | null;
  features?: Record<string, unknown> | null;
}): Promise<string> {
  const stage = String(opts.stage);
  const highFrequency = HIGH_FREQUENCY_STAGES.has(stage);
  const perSignal = EXECUTION_STAGES.has(stage) && !!opts.signalId;
  const deduped =
    highFrequency || perSignal || (opts.result === 'FAIL' && REPEATING_REJECTION_STAGES.has(stage));
  const signature = `${opts.result}|${opts.reasonCode ?? ''}`;
  const dedupeKey = perSignal
    ? `${opts.tokenId}|${stage}|${opts.signalId}|${signature}`
    : `${opts.tokenId}|${opts.stage}|${opts.strategyId ?? ''}`;
  if (deduped) {
    const prev = auditDedupe.recent(dedupeKey, signature, env.DECISION_AUDIT_DEDUPE_MINUTES * 60_000);
    if (prev?.value) return prev.value;
  }
  if (highFrequency && !researchWritesAllowed()) return '';

  const { rows } = await query<{ id: string }>(
    `INSERT INTO token_decision_audits (
       token_id, portfolio_id, stage, result, reason_code,
       actual_values, required_values, details, strategy_id, signal_id,
       risk_decision_id, data_mode
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING id`,
    [
      opts.tokenId,
      opts.portfolioId ?? null,
      opts.stage,
      opts.result,
      opts.reasonCode ?? null,
      JSON.stringify(opts.actualValues ?? {}),
      JSON.stringify(opts.requiredValues ?? {}),
      JSON.stringify(opts.details ?? {}),
      opts.strategyId ?? null,
      opts.signalId ?? null,
      opts.riskDecisionId ?? null,
      dataMode,
    ],
  );
  const decisionId = rows[0]!.id;
  if (deduped) auditDedupe.remember(dedupeKey, signature, decisionId);

  if (opts.features && Object.keys(opts.features).length > 0) {
    await query(
      `INSERT INTO token_decision_feature_snapshots (
         decision_id, token_id, stage, features, data_mode
       ) VALUES ($1,$2,$3,$4,$5)`,
      [decisionId, opts.tokenId, opts.stage, JSON.stringify(opts.features), dataMode],
    );
  }

  if (opts.result === 'FAIL' && opts.reasonCode) {
    await updateIntelligenceStatus(opts.tokenId, String(opts.stage), {
      rejectionReason: opts.reasonCode,
    });
  } else if (opts.result === 'TRADED') {
    await updateIntelligenceStatus(opts.tokenId, 'TRADED', { tradeStatus: 'TRADED' });
  } else if (opts.result === 'PASS') {
    await updateIntelligenceStatus(opts.tokenId, String(opts.stage));
  }

  return decisionId;
}

export function discoverySourceList(token: {
  discoverySource?: DiscoverySource;
  discovery_source?: string;
}): string[] {
  const s = token.discoverySource ?? token.discovery_source;
  return s ? [s] : [];
}
