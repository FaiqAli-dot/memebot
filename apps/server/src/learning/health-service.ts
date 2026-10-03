import { query } from '../db/client.js';
import { dataMode, env } from '../config/env.js';
import { getStalePriceMaxAgeMs } from '../providers/index.js';
import { isKillSwitchActive, setKillSwitch } from '../monitoring/kill-switch.js';
import { logBotEvent } from '../services/token-service.js';
import { publish } from '../ws/hub.js';
import { logger } from '../utils/logger.js';
import { computeHealth, shouldEmit, type Anomaly, type HealthResult } from './health.js';
import { loadObservations } from './repository.js';

export interface HealthCheckOutcome {
  id: string;
  newObservations: number;
  result: HealthResult;
  emitted: Anomaly[];
  suppressed: number;
  protectionAction: string | null;
}

export async function lastHealthCheck(): Promise<{ seqTo: number; createdAt: Date } | null> {
  const { rows } = await query<{ seq_to: string; created_at: Date }>(
    `SELECT seq_to, created_at FROM learning_health_checks WHERE data_mode = $1
     ORDER BY created_at DESC LIMIT 1`,
    [dataMode],
  );
  return rows[0] ? { seqTo: Number(rows[0].seq_to), createdAt: rows[0].created_at } : null;
}

export async function observationsSince(seq: number): Promise<{ count: number; maxSeq: number }> {
  const { rows } = await query<{ n: string; max_seq: string | null }>(
    `SELECT COUNT(*) AS n, MAX(seq) AS max_seq FROM trade_observations WHERE data_mode = $1 AND seq > $2`,
    [dataMode, seq],
  );
  return { count: Number(rows[0]?.n ?? 0), maxSeq: Number(rows[0]?.max_seq ?? seq) };
}

/**
 * Runs the Level 2 health check once ANOMALY_CHECK_INTERVAL_TRADES new observations exist.
 * Alerts only. The single permitted action is pausing new paper entries (kill switch) on a
 * CRITICAL safety anomaly — never a parameter or strategy change.
 */
export async function runHealthCheckIfDue(
  productionPortfolioId: string,
  now = new Date(),
): Promise<HealthCheckOutcome | null> {
  const last = await lastHealthCheck();
  const lastSeq = last?.seqTo ?? 0;
  const pending = await observationsSince(lastSeq);
  if (pending.count < env.ANOMALY_CHECK_INTERVAL_TRADES) return null;

  const all = await loadObservations({ limit: 5000 });
  const newRows = all.filter((o) => o.seq > lastSeq);
  const dup = await query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM (
       SELECT 1 FROM positions WHERE status = 'OPEN' GROUP BY portfolio_id, token_id HAVING COUNT(*) > 1
     ) d`,
  );
  const result = computeHealth(all, newRows, { duplicateOpenPositions: Number(dup.rows[0]?.n ?? 0) }, {
    recentWindow: env.ANOMALY_RECENT_WINDOW_TRADES,
    baselineWindow: env.ANOMALY_BASELINE_WINDOW_TRADES,
    staleQuoteMs: getStalePriceMaxAgeMs(),
  });

  const emitted: Anomaly[] = [];
  for (const a of result.anomalies) {
    const prev = await query<{ created_at: Date; metric: string | null }>(
      `SELECT created_at, metric FROM learning_anomalies WHERE anomaly_key = $1 AND data_mode = $2
       ORDER BY created_at DESC LIMIT 1`,
      [a.key, dataMode],
    );
    const p = prev.rows[0];
    if (
      shouldEmit(
        a,
        p ? { createdAt: p.created_at, metric: p.metric == null ? null : Number(p.metric) } : null,
        now,
        env.ANOMALY_ALERT_COOLDOWN_MINUTES,
      )
    ) {
      emitted.push(a);
    }
  }

  let protectionAction: string | null = null;
  const criticalSafety = result.anomalies.filter((a) => a.severity === 'CRITICAL' && a.safety);
  if (criticalSafety.length && !(await isKillSwitchActive(productionPortfolioId))) {
    await setKillSwitch(productionPortfolioId, true, 'data_corruption');
    protectionAction = `paused_new_entries: ${criticalSafety.map((a) => a.key).join(', ')}`;
  }

  const counts = {
    warning: result.anomalies.filter((a) => a.severity === 'WARNING').length,
    critical: result.anomalies.filter((a) => a.severity === 'CRITICAL').length,
  };
  const { rows } = await query<{ id: string }>(
    `INSERT INTO learning_health_checks (
       seq_from, seq_to, new_observations, total_observations, metrics, anomalies,
       warning_count, critical_count, protection_action, data_mode, created_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [
      lastSeq + 1,
      pending.maxSeq,
      newRows.length,
      all.length,
      JSON.stringify({ groups: result.groups }),
      JSON.stringify(result.anomalies.map((a) => ({ ...a, emitted: emitted.includes(a) }))),
      counts.warning,
      counts.critical,
      protectionAction,
      dataMode,
      now,
    ],
  );
  const id = rows[0]!.id;

  for (const a of emitted) {
    await query(
      `INSERT INTO learning_anomalies (
         health_check_id, anomaly_key, anomaly_type, severity, scope, strategy_id, safety, message,
         metric, sample_size, low_sample, evidence, data_mode, created_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        id,
        a.key,
        a.type,
        a.severity,
        a.scope,
        a.strategyId,
        a.safety,
        a.message,
        a.metric,
        a.sampleSize,
        a.lowSample,
        JSON.stringify(a.evidence),
        dataMode,
        now,
      ],
    );
    if (a.severity !== 'INFO') {
      await logBotEvent({
        portfolioId: productionPortfolioId,
        level: a.severity === 'CRITICAL' ? 'error' : 'warn',
        category: 'learning',
        message: `${a.severity} ${a.type}${a.strategyId ? ` [${a.strategyId}]` : ''}: ${a.message}`,
        details: { anomalyKey: a.key, sampleSize: a.sampleSize, lowSample: a.lowSample, healthCheckId: id },
      });
    }
  }
  if (protectionAction) {
    logger.error({ protectionAction }, 'Health check paused new paper entries');
  }
  publish('learning_updated', { kind: 'health_check', id, emitted: emitted.length, ...counts });
  return {
    id,
    newObservations: newRows.length,
    result,
    emitted,
    suppressed: result.anomalies.length - emitted.length,
    protectionAction,
  };
}
