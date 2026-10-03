import type { LearningAnomalyItem, LearningCandidateItem, LearningStatus, LearningStrategyStat } from '@memebot/shared';
import { query } from '../db/client.js';
import { dataMode, env } from '../config/env.js';
import { localDateTime } from '../services/report-service.js';
import { stageFor } from './calibration.js';
import { evaluateCalibrationGate } from './calibration-service.js';
import { lastHealthCheck, observationsSince } from './health-service.js';
import { summarize } from './health.js';
import { loadObservations } from './repository.js';
import { finite, mean } from './stats.js';
import { getDataQuality } from './quality.js';
import { learningModeInfo } from './mode.js';

const TYPE_GROUP: Record<string, keyof LearningStatus['health']['byType']> = {
  EXECUTION_COST_ANOMALY: 'execution',
  EV_CALIBRATION_ANOMALY: 'prediction',
  WIN_PROBABILITY_CALIBRATION_ANOMALY: 'prediction',
  DATA_QUALITY_ANOMALY: 'data',
  RISK_MODEL_ANOMALY: 'risk',
  STRATEGY_PERFORMANCE_DEGRADATION: 'degradation',
};

export async function getLearningStatus(now = new Date()): Promise<LearningStatus> {
  const [counts, open, gate, lastCheck] = await Promise.all([
    query<{ portfolio_type: string; snapshot_source: string; n: string; last: Date | null }>(
      `SELECT portfolio_type, snapshot_source, COUNT(*) AS n, MAX(recorded_at) AS last
       FROM trade_observations WHERE data_mode = $1 GROUP BY 1, 2`,
      [dataMode],
    ),
    query<{ n: string }>(`SELECT COUNT(*) AS n FROM positions WHERE status = 'OPEN' AND data_mode = $1`, [dataMode]),
    evaluateCalibrationGate(now),
    lastHealthCheck(),
  ]);
  const sum = (pred: (r: (typeof counts.rows)[number]) => boolean) =>
    counts.rows.filter(pred).reduce((a, r) => a + Number(r.n), 0);
  const lastObs = counts.rows.map((r) => r.last).filter((d): d is Date => d != null);

  const pending = await observationsSince(lastCheck?.seqTo ?? 0);
  const { rows: checkRows } = await query<{
    warning_count: number;
    critical_count: number;
    protection_action: string | null;
    anomalies: Array<{ type: string }>;
  }>(
    `SELECT warning_count, critical_count, protection_action, anomalies FROM learning_health_checks
     WHERE data_mode = $1 ORDER BY created_at DESC LIMIT 1`,
    [dataMode],
  );
  const check = checkRows[0];
  const byType: LearningStatus['health']['byType'] = { execution: 0, prediction: 0, data: 0, risk: 0, degradation: 0 };
  for (const a of check?.anomalies ?? []) {
    const g = TYPE_GROUP[a.type];
    if (g) byType[g]++;
  }

  const { rows: anomalyRows } = await query<{
    severity: LearningAnomalyItem['severity'];
    anomaly_type: string;
    scope: string;
    strategy_id: string | null;
    message: string;
    sample_size: number;
    low_sample: boolean;
    safety: boolean;
    created_at: Date;
  }>(
    `SELECT severity, anomaly_type, scope, strategy_id, message, sample_size, low_sample, safety, created_at
     FROM learning_anomalies WHERE data_mode = $1 AND created_at > $2
     ORDER BY created_at DESC LIMIT 20`,
    [dataMode, new Date(now.getTime() - 24 * 3600_000)],
  );

  const all = await loadObservations({ limit: 20_000 });
  const strategies: LearningStrategyStat[] = [];
  for (const scope of ['PRODUCTION', 'RESEARCH'] as const) {
    const scoped = all.filter((o) => o.portfolioType === scope);
    for (const strategyId of [...new Set(scoped.map((o) => o.strategyId))].sort()) {
      const rows = scoped.filter((o) => o.strategyId === strategyId);
      const s = summarize(rows, env.ANOMALY_RECENT_WINDOW_TRADES);
      strategies.push({
        scope,
        strategyId,
        n: s.n,
        lowSample: s.lowSample,
        winRate: s.outcome.winRate,
        winRateCI: s.outcome.winRateCI,
        avgReturn: s.outcome.avgReturn,
        avgReturnCI: s.outcome.avgReturnCI,
        profitFactor: s.outcome.profitFactor,
        avgPredictedEv: mean(finite(rows.map((o) => o.predictedEv))),
        avgPredictedWinProbability: s.prediction.avgPredictedWinProbability,
      });
    }
  }

  const { rows: activeRows } = await query<{
    strategy_id: string;
    version: string | null;
    candidate_parameters: { offset: number; scale: number } | null;
    created_at: Date;
  }>(
    `SELECT DISTINCT ON (a.strategy_id) a.strategy_id, v.version, v.candidate_parameters, a.created_at
     FROM calibration_activations a LEFT JOIN calibration_versions v ON v.id = a.version_id
     WHERE a.scope = 'PRODUCTION' AND a.data_mode = $1
     ORDER BY a.strategy_id, a.created_at DESC`,
    [dataMode],
  );
  const { rows: runRows } = await query<{
    decision: string;
    reason: string;
    created_at: Date;
    new_observations: number;
    required_observations: number;
  }>(
    `SELECT decision, reason, created_at, new_observations, required_observations FROM calibration_runs
     WHERE data_mode = $1 ORDER BY created_at DESC LIMIT 1`,
    [dataMode],
  );
  const { rows: candRows } = await query<{
    strategy_id: string;
    version: string;
    status: LearningCandidateItem['status'];
    promotion_decision: string;
    training_count: number;
    validation_count: number;
    created_at: Date;
  }>(
    `SELECT strategy_id, version, status, promotion_decision, training_count, validation_count, created_at
     FROM calibration_versions WHERE data_mode = $1 ORDER BY created_at DESC LIMIT 10`,
    [dataMode],
  );

  const today = localDateTime(now, env.REPORT_TIMEZONE);
  const { rows: todayReport } = await query(
    `SELECT 1 FROM daily_reports WHERE report_date = $1::date AND data_mode = $2 LIMIT 1`,
    [today.date, dataMode],
  );
  const nextEvaluation = `${todayReport.length || today.time >= env.REPORT_TIME ? 'tomorrow' : 'today'} at ${env.REPORT_TIME} (${env.REPORT_TIMEZONE}), with the daily report`;
  const nextEligibleAt = gate.intervalStartsAt
    ? new Date(gate.intervalStartsAt.getTime() + env.LEARNING_INTERVAL_HOURS * 3600_000).toISOString()
    : null;
  const production = sum((r) => r.portfolio_type === 'PRODUCTION');
  const quality = await getDataQuality();
  // Data-sufficiency stage is judged on calibration-grade evidence only
  const stage = stageFor(quality.calibrationEligible);
  const run = runRows[0];
  const { rows: versionRows } = await query<{ status: LearningCandidateItem['status']; n: string }>(
    `SELECT status, COUNT(*) AS n FROM calibration_versions WHERE data_mode = $1 GROUP BY 1`,
    [dataMode],
  );
  const versionCounts: Record<LearningCandidateItem['status'], number> = {
    CANDIDATE: 0,
    VALIDATED: 0,
    PROMOTED: 0,
    REJECTED: 0,
  };
  for (const r of versionRows) versionCounts[r.status] = Number(r.n);
  const { rows: checks24 } = await query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM learning_health_checks WHERE data_mode = $1 AND created_at > $2`,
    [dataMode, new Date(now.getTime() - 24 * 3600_000)],
  );

  return {
    config: {
      learningIntervalHours: env.LEARNING_INTERVAL_HOURS,
      minNewObservations: env.MIN_NEW_OBSERVATIONS_FOR_LEARNING,
      anomalyCheckEvery: env.ANOMALY_CHECK_INTERVAL_TRADES,
      recentWindow: env.ANOMALY_RECENT_WINDOW_TRADES,
      baselineWindow: env.ANOMALY_BASELINE_WINDOW_TRADES,
      alertCooldownMinutes: env.ANOMALY_ALERT_COOLDOWN_MINUTES,
      reportTime: env.REPORT_TIME,
      reportTimezone: env.REPORT_TIMEZONE,
    },
    observation: {
      completed: sum(() => true),
      production,
      research: sum((r) => r.portfolio_type === 'RESEARCH'),
      openTrades: Number(open.rows[0]?.n ?? 0),
      newSinceCalibration: gate.newObservations,
      lastObservationAt: lastObs.length ? new Date(Math.max(...lastObs.map((d) => d.getTime()))).toISOString() : null,
      entrySnapshots: sum((r) => r.snapshot_source === 'ENTRY_SNAPSHOT'),
      signalBackfills: sum((r) => r.snapshot_source === 'SIGNAL_BACKFILL'),
      quality,
    },
    mode: learningModeInfo(),
    health: {
      checksLast24h: Number(checks24[0]?.n ?? 0),
      lastCheckAt: lastCheck?.createdAt.toISOString() ?? null,
      observationsSinceLastCheck: pending.count,
      warnings: check?.warning_count ?? 0,
      critical: check?.critical_count ?? 0,
      byType,
      protectionAction: check?.protection_action ?? null,
      recentAnomalies: anomalyRows.map((a) => ({
        severity: a.severity,
        type: a.anomaly_type,
        scope: a.scope,
        strategyId: a.strategy_id,
        message: a.message,
        sampleSize: a.sample_size,
        lowSample: a.low_sample,
        safety: a.safety,
        createdAt: a.created_at.toISOString(),
      })),
      strategies,
    },
    calibration: {
      stage: stage.stage,
      stageNote: stage.note,
      productionObservations: quality.calibrationEligible,
      active: activeRows
        .filter((r) => r.version && r.candidate_parameters)
        .map((r) => ({
          strategyId: r.strategy_id,
          version: r.version!,
          offset: r.candidate_parameters!.offset,
          scale: r.candidate_parameters!.scale,
          activatedAt: r.created_at.toISOString(),
        })),
      lastPerformedAt: gate.lastPerformedAt?.toISOString() ?? null,
      lastRun: run
        ? {
            decision: run.decision,
            reason: run.reason,
            createdAt: run.created_at.toISOString(),
            newObservations: run.new_observations,
            requiredObservations: run.required_observations,
          }
        : null,
      gate: {
        decision: gate.decision,
        reason: gate.reason,
        newObservations: gate.newObservations,
        requiredObservations: gate.requiredObservations,
        hoursSinceLast: gate.hoursSinceLast,
        requiredHours: gate.requiredHours,
      },
      nextEvaluation,
      nextEligibleAt,
      observationsNeeded: Math.max(0, gate.requiredObservations - gate.newObservations),
      candidates: candRows.map((c) => ({
        strategyId: c.strategy_id,
        version: c.version,
        status: c.status,
        promotionDecision: c.promotion_decision,
        trainingCount: c.training_count,
        validationCount: c.validation_count,
        createdAt: c.created_at.toISOString(),
      })),
      versionCounts,
    },
  };
}
