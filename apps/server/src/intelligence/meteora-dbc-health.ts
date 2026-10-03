/**
 * Detailed Meteora DBC discovery health — proves real launches are flowing
 * (not only demo fixtures) after deploy.
 */
import { query } from '../db/client.js';
import { env, dataMode } from '../config/env.js';

export type DbcDiscoveryPath = 'rpc' | 'datapi' | 'realtime';

export type DbcHealthStatus = 'OK' | 'DEGRADED' | 'STALE' | 'DISABLED' | 'UNKNOWN';

interface TimedEvent {
  at: number;
}

interface InitEvent {
  at: number;
  mint: string;
  path: DbcDiscoveryPath;
  preMigration: boolean;
}

const rpcPolls: TimedEvent[] = [];
const rpcErrors: Array<TimedEvent & { status?: number; message: string }> = [];
const inits: InitEvent[] = [];

const HOUR_MS = 3_600_000;
const MAX_BUFFER = 5_000;

function trimOld(): void {
  const cutoff = Date.now() - 48 * HOUR_MS;
  while (rpcPolls.length && rpcPolls[0]!.at < cutoff) rpcPolls.shift();
  while (rpcErrors.length && rpcErrors[0]!.at < cutoff) rpcErrors.shift();
  while (inits.length && inits[0]!.at < cutoff) inits.shift();
  if (rpcPolls.length > MAX_BUFFER) rpcPolls.splice(0, rpcPolls.length - MAX_BUFFER);
  if (rpcErrors.length > MAX_BUFFER) rpcErrors.splice(0, rpcErrors.length - MAX_BUFFER);
  if (inits.length > MAX_BUFFER) inits.splice(0, inits.length - MAX_BUFFER);
}

export function recordDbcRpcPollSuccess(): void {
  rpcPolls.push({ at: Date.now() });
  trimOld();
}

export function recordDbcRpcError(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  const statusMatch = message.match(/\b(429|5\d\d|4\d\d)\b/);
  rpcErrors.push({
    at: Date.now(),
    status: statusMatch ? Number(statusMatch[1]) : undefined,
    message: message.slice(0, 300),
  });
  trimOld();
}

export function recordDbcInitSeen(opts: {
  mint: string;
  path: DbcDiscoveryPath;
  preMigration: boolean;
}): void {
  // Demo synthetic addresses are not "real" launches for health.
  if (opts.mint.startsWith('Demo')) return;
  inits.push({
    at: Date.now(),
    mint: opts.mint,
    path: opts.path,
    preMigration: opts.preMigration,
  });
  trimOld();
}

export function computeDbcHealthStatus(opts: {
  enabled: boolean;
  consecutiveFailures: number;
  lastInitAt: number | null;
  now?: number;
}): DbcHealthStatus {
  if (!opts.enabled) return 'DISABLED';
  const now = opts.now ?? Date.now();
  const silenceMs = env.METEORA_DBC_STALE_SILENCE_MINUTES * 60_000;
  if (opts.consecutiveFailures >= 5) return 'DEGRADED';
  if (opts.lastInitAt == null) {
    // Never seen a real init since process start — UNKNOWN until first success,
    // DEGRADED if failures are mounting.
    return opts.consecutiveFailures > 0 ? 'DEGRADED' : 'UNKNOWN';
  }
  if (now - opts.lastInitAt >= silenceMs) return 'STALE';
  if (opts.consecutiveFailures > 0) return 'DEGRADED';
  return 'OK';
}

export async function persistMeteoraDbcHealthDetails(
  extras: Record<string, unknown> = {},
): Promise<void> {
  const snapshot = await getMeteoraDbcHealth();
  await query(
    `INSERT INTO discovery_source_health (source_key, enabled, details, updated_at)
     VALUES ('meteora_dbc', $1, $2::jsonb, NOW())
     ON CONFLICT (source_key) DO UPDATE SET
       details = COALESCE(discovery_source_health.details, '{}'::jsonb) || $2::jsonb,
       updated_at = NOW()`,
    [env.METEORA_DBC_ENABLED, JSON.stringify({ ...snapshot, ...extras })],
  );
}

export async function getMeteoraDbcHealth(): Promise<{
  status: DbcHealthStatus;
  enabled: boolean;
  lastSuccessfulRpcPollAt: string | null;
  lastRealDbcInitAt: string | null;
  lastRealDbcInitMint: string | null;
  discoveredLast1h: number;
  discoveredLast24h: number;
  viaRpcLast24h: number;
  viaDatapiLast24h: number;
  viaRealtimeLast24h: number;
  preMigrationLast24h: number;
  migratedLast24h: number;
  rpcErrorsLast1h: number;
  rpc429sLast1h: number;
  consecutiveFailures: number;
  staleSilenceMinutes: number;
  note: string;
}> {
  trimOld();
  const now = Date.now();
  const oneH = now - HOUR_MS;
  const day = now - 24 * HOUR_MS;

  const lastPoll = rpcPolls.length ? rpcPolls[rpcPolls.length - 1]!.at : null;
  const lastInit = inits.length ? inits[inits.length - 1]! : null;

  let consecutiveFailures = 0;
  try {
    const { rows } = await query<{ consecutive_failures: number }>(
      `SELECT consecutive_failures FROM discovery_source_health WHERE source_key = 'meteora_dbc'`,
    );
    consecutiveFailures = rows[0]?.consecutive_failures ?? 0;
  } catch {
    consecutiveFailures = 0;
  }

  // Prefer DB ledger counts for 1h/24h (survives restarts); fall back to in-memory.
  let discoveredLast1h = inits.filter((i) => i.at >= oneH).length;
  let discoveredLast24h = inits.filter((i) => i.at >= day).length;
  let viaRpcLast24h = inits.filter((i) => i.at >= day && i.path === 'rpc').length;
  let viaDatapiLast24h = inits.filter((i) => i.at >= day && i.path === 'datapi').length;
  let viaRealtimeLast24h = inits.filter((i) => i.at >= day && i.path === 'realtime').length;
  let preMigrationLast24h = inits.filter((i) => i.at >= day && i.preMigration).length;
  let migratedLast24h = inits.filter((i) => i.at >= day && !i.preMigration).length;

  try {
    const { rows } = await query<{
      h1: string;
      h24: string;
      rpc24: string;
      datapi24: string;
      realtime24: string;
      pre24: string;
      mig24: string;
    }>(
      `SELECT
         COUNT(*) FILTER (WHERE observed_at >= NOW() - INTERVAL '1 hour')::text AS h1,
         COUNT(*) FILTER (WHERE observed_at >= NOW() - INTERVAL '24 hours')::text AS h24,
         COUNT(*) FILTER (
           WHERE observed_at >= NOW() - INTERVAL '24 hours'
             AND COALESCE(payload->>'discoveryPath', '') = 'rpc'
         )::text AS rpc24,
         COUNT(*) FILTER (
           WHERE observed_at >= NOW() - INTERVAL '24 hours'
             AND COALESCE(payload->>'discoveryPath', '') = 'datapi'
         )::text AS datapi24,
         COUNT(*) FILTER (
           WHERE observed_at >= NOW() - INTERVAL '24 hours'
             AND COALESCE(payload->>'discoveryPath', '') = 'realtime'
         )::text AS realtime24,
         COUNT(*) FILTER (
           WHERE observed_at >= NOW() - INTERVAL '24 hours'
             AND COALESCE(dbc_status, payload->>'dbcStatus', '') = 'PRE_BONDING_CURVE'
         )::text AS pre24,
         COUNT(*) FILTER (
           WHERE observed_at >= NOW() - INTERVAL '24 hours'
             AND COALESCE(migration_status, payload->>'migrationStatus', '') = 'MIGRATED'
         )::text AS mig24
       FROM token_discovery_events
       WHERE discovery_source = 'METEORA_DBC'
         AND data_mode = $1
         AND COALESCE(payload->>'demoFixture', 'false') <> 'true'`,
      [dataMode],
    );
    const r = rows[0];
    if (r) {
      discoveredLast1h = Math.max(discoveredLast1h, Number(r.h1));
      discoveredLast24h = Math.max(discoveredLast24h, Number(r.h24));
      viaRpcLast24h = Math.max(viaRpcLast24h, Number(r.rpc24));
      viaDatapiLast24h = Math.max(viaDatapiLast24h, Number(r.datapi24));
      viaRealtimeLast24h = Math.max(viaRealtimeLast24h, Number(r.realtime24));
      preMigrationLast24h = Math.max(preMigrationLast24h, Number(r.pre24));
      migratedLast24h = Math.max(migratedLast24h, Number(r.mig24));
    }
  } catch {
    /* table may be empty early */
  }

  let lastRealFromDb: { at: Date; mint: string } | null = null;
  try {
    const { rows } = await query<{ observed_at: Date; address: string }>(
      `SELECT e.observed_at, t.address
       FROM token_discovery_events e
       JOIN tokens t ON t.id = e.token_id
       WHERE e.discovery_source = 'METEORA_DBC'
         AND e.data_mode = $1
         AND COALESCE(e.payload->>'demoFixture', 'false') <> 'true'
         AND t.address NOT LIKE 'Demo%'
       ORDER BY e.observed_at DESC
       LIMIT 1`,
      [dataMode],
    );
    if (rows[0]) lastRealFromDb = { at: rows[0].observed_at, mint: rows[0].address };
  } catch {
    lastRealFromDb = null;
  }

  const lastInitAt = Math.max(
    lastInit?.at ?? 0,
    lastRealFromDb?.at.getTime() ?? 0,
  ) || null;
  const lastInitMint = lastInit?.mint ?? lastRealFromDb?.mint ?? null;

  const status = computeDbcHealthStatus({
    enabled: env.METEORA_DBC_ENABLED,
    consecutiveFailures,
    lastInitAt,
  });

  const rpcErrorsLast1h = rpcErrors.filter((e) => e.at >= oneH).length;
  const rpc429sLast1h = rpcErrors.filter(
    (e) => e.at >= oneH && (e.status === 429 || /429|Too Many Requests/i.test(e.message)),
  ).length;

  return {
    status,
    enabled: env.METEORA_DBC_ENABLED,
    lastSuccessfulRpcPollAt: lastPoll ? new Date(lastPoll).toISOString() : null,
    lastRealDbcInitAt: lastInitAt ? new Date(lastInitAt).toISOString() : null,
    lastRealDbcInitMint: lastInitMint,
    discoveredLast1h,
    discoveredLast24h,
    viaRpcLast24h,
    viaDatapiLast24h,
    viaRealtimeLast24h,
    preMigrationLast24h,
    migratedLast24h,
    rpcErrorsLast1h,
    rpc429sLast1h,
    consecutiveFailures,
    staleSilenceMinutes: env.METEORA_DBC_STALE_SILENCE_MINUTES,
    note:
      status === 'OK'
        ? 'Real DBC inits flowing within the silence window.'
        : status === 'STALE'
          ? `No real DBC init for ≥${env.METEORA_DBC_STALE_SILENCE_MINUTES}m — feed likely broken.`
          : status === 'DEGRADED'
            ? 'RPC/datapi errors or consecutive failures — check rpc429sLast1h / lastError.'
            : status === 'DISABLED'
              ? 'METEORA_DBC_ENABLED=false'
              : 'Waiting for first real (non-demo) DBC init after deploy.',
  };
}

/** Test helper — clear in-memory buffers. */
export function resetMeteoraDbcHealthForTests(): void {
  rpcPolls.length = 0;
  rpcErrors.length = 0;
  inits.length = 0;
}
