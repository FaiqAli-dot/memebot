/**
 * Per-source discovery health. One broken feed must not look like a healthy bot.
 */
import { query } from '../db/client.js';
import { env } from '../config/env.js';

export type SourceHealthKey =
  | 'dexscreener_boosts'
  | 'dexscreener_profiles'
  | 'geckoterminal_new_pools'
  | 'meteora_dbc'
  | 'demo_multi';

const PROVIDER_TO_KEY: Record<string, SourceHealthKey> = {
  'dexscreener-boosts': 'dexscreener_boosts',
  'dexscreener-new-pairs': 'dexscreener_profiles',
  'gecko-new-pools': 'geckoterminal_new_pools',
  'meteora-dbc': 'meteora_dbc',
  'demo-multi-discovery': 'demo_multi',
};

export function sourceKeyForProvider(providerName: string): SourceHealthKey | null {
  return PROVIDER_TO_KEY[providerName] ?? null;
}

export async function ensureSourceHealthRows(): Promise<void> {
  const rows: Array<{ key: SourceHealthKey; enabled: boolean; interval: number }> = [
    {
      key: 'dexscreener_boosts',
      enabled: true,
      interval: env.JOB_TOKEN_DISCOVERY_INTERVAL_MS,
    },
    {
      key: 'dexscreener_profiles',
      enabled: true,
      interval: env.JOB_TOKEN_DISCOVERY_INTERVAL_MS,
    },
    {
      key: 'geckoterminal_new_pools',
      enabled: true,
      interval: env.JOB_TOKEN_DISCOVERY_INTERVAL_MS,
    },
    {
      key: 'meteora_dbc',
      enabled: env.METEORA_DBC_ENABLED,
      interval: env.JOB_TOKEN_DISCOVERY_INTERVAL_MS,
    },
    {
      key: 'demo_multi',
      enabled: true,
      interval: env.JOB_TOKEN_DISCOVERY_INTERVAL_MS,
    },
  ];
  for (const r of rows) {
    await query(
      `INSERT INTO discovery_source_health (source_key, enabled, polling_interval_ms)
       VALUES ($1,$2,$3)
       ON CONFLICT (source_key) DO UPDATE SET
         enabled = EXCLUDED.enabled,
         polling_interval_ms = EXCLUDED.polling_interval_ms,
         updated_at = NOW()`,
      [r.key, r.enabled, r.interval],
    );
  }
}

export async function recordSourceSuccess(
  providerName: string,
  discoveredCount: number,
): Promise<void> {
  const key = sourceKeyForProvider(providerName);
  if (!key) return;
  await query(
    `INSERT INTO discovery_source_health (
       source_key, enabled, last_success_at, last_discovery_at,
       consecutive_failures, tokens_discovered_approx, polling_interval_ms, updated_at
     ) VALUES ($1, TRUE, NOW(), CASE WHEN $2 > 0 THEN NOW() ELSE NULL END, 0, $2, $3, NOW())
     ON CONFLICT (source_key) DO UPDATE SET
       last_success_at = NOW(),
       last_discovery_at = CASE
         WHEN $2 > 0 THEN NOW()
         ELSE discovery_source_health.last_discovery_at
       END,
       consecutive_failures = 0,
       last_error = NULL,
       tokens_discovered_approx = discovery_source_health.tokens_discovered_approx + $2,
       polling_interval_ms = $3,
       updated_at = NOW()`,
    [key, discoveredCount, env.JOB_TOKEN_DISCOVERY_INTERVAL_MS],
  );
}

export async function recordSourceFailure(
  providerName: string,
  error: unknown,
): Promise<void> {
  const key = sourceKeyForProvider(providerName);
  if (!key) return;
  const message = error instanceof Error ? error.message : String(error);
  await query(
    `INSERT INTO discovery_source_health (
       source_key, enabled, last_error, last_error_at, consecutive_failures,
       polling_interval_ms, updated_at
     ) VALUES ($1, TRUE, $2, NOW(), 1, $3, NOW())
     ON CONFLICT (source_key) DO UPDATE SET
       last_error = $2,
       last_error_at = NOW(),
       consecutive_failures = discovery_source_health.consecutive_failures + 1,
       polling_interval_ms = $3,
       updated_at = NOW()`,
    [key, message.slice(0, 500), env.JOB_TOKEN_DISCOVERY_INTERVAL_MS],
  );
}

export async function listSourceHealth(): Promise<
  Array<{
    sourceKey: string;
    enabled: boolean;
    lastSuccessAt: string | null;
    lastDiscoveryAt: string | null;
    lastError: string | null;
    lastErrorAt: string | null;
    consecutiveFailures: number;
    tokensDiscoveredApprox: number;
    pollingIntervalMs: number | null;
    healthy: boolean;
    status?: string;
    meteoraDbc?: Awaited<ReturnType<typeof import('./meteora-dbc-health.js').getMeteoraDbcHealth>>;
  }>
> {
  await ensureSourceHealthRows();
  const { rows } = await query<{
    source_key: string;
    enabled: boolean;
    last_success_at: Date | null;
    last_discovery_at: Date | null;
    last_error: string | null;
    last_error_at: Date | null;
    consecutive_failures: number;
    tokens_discovered_approx: string;
    polling_interval_ms: number | null;
  }>(`SELECT * FROM discovery_source_health ORDER BY source_key`);

  const staleMs = Math.max(env.JOB_TOKEN_DISCOVERY_INTERVAL_MS * 10, 5 * 60_000);
  const now = Date.now();
  const { getMeteoraDbcHealth } = await import('./meteora-dbc-health.js');
  const meteoraDbc = await getMeteoraDbcHealth();

  return rows.map((r) => {
    const lastOk = r.last_success_at?.getTime() ?? 0;
    const healthy =
      !r.enabled ||
      (r.consecutive_failures < 5 && (lastOk === 0 || now - lastOk < staleMs * 3));
    const base = {
      sourceKey: r.source_key,
      enabled: r.enabled,
      lastSuccessAt: r.last_success_at?.toISOString() ?? null,
      lastDiscoveryAt: r.last_discovery_at?.toISOString() ?? null,
      lastError: r.last_error,
      lastErrorAt: r.last_error_at?.toISOString() ?? null,
      consecutiveFailures: r.consecutive_failures,
      tokensDiscoveredApprox: Number(r.tokens_discovered_approx),
      pollingIntervalMs: r.polling_interval_ms,
      healthy: r.source_key === 'meteora_dbc' ? meteoraDbc.status === 'OK' : healthy,
      status:
        r.source_key === 'meteora_dbc'
          ? meteoraDbc.status
          : !r.enabled
            ? 'DISABLED'
            : healthy
              ? 'OK'
              : 'DEGRADED',
    };
    if (r.source_key === 'meteora_dbc') {
      return { ...base, meteoraDbc };
    }
    return base;
  });
}
