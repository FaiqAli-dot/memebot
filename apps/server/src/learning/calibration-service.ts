import { query } from '../db/client.js';
import { dataMode, env } from '../config/env.js';
import type { EvCalibration } from '../risk/expected-value.js';
import { logBotEvent } from '../services/token-service.js';
import { publish } from '../ws/hub.js';
import {
  brierScore,
  calibrateStrategy,
  evBuckets,
  segmentTables,
  stageFor,
  winProbabilityBuckets,
  type CalibrationObservation,
  type EvCalibrationParams,
  type StrategyCalibrationResult,
} from './calibration.js';
import { loadObservations, type ObservationRecord } from './repository.js';
import { CALIBRATION_GRADE_QUALITY } from './observations.js';

/** Absorbs the minute-level jitter of the daily report tick against a 24h interval. */
export const LEARNING_INTERVAL_GRACE_MINUTES = 10;

export type GateDecision =
  | 'PERFORMED'
  | 'SKIPPED_INSUFFICIENT_OBSERVATIONS'
  | 'SKIPPED_INTERVAL_NOT_REACHED'
  | 'SKIPPED_DISABLED';

export interface CalibrationGate {
  decision: GateDecision;
  reason: string;
  newObservations: number;
  requiredObservations: number;
  hoursSinceLast: number | null;
  requiredHours: number;
  totalObservations: number;
  lastPerformedAt: Date | null;
  cutoffSeq: number;
  intervalStartsAt: Date | null;
}

/**
 * Pure gate: BOTH enough new calibration-grade (TRUE_ENTRY_SNAPSHOT) production observations
 * AND the learning interval. Backfilled/partial observations never count toward the minimum.
 */
export function decideGate(opts: {
  enabled: boolean;
  newObservations: number;
  requiredObservations: number;
  intervalStartsAt: Date | null;
  requiredHours: number;
  now: Date;
  /** New production observations that are not calibration-grade (reported, never counted) */
  excludedObservations?: number;
}): { decision: GateDecision; reason: string; hoursSinceLast: number | null } {
  const hours = opts.intervalStartsAt ? (opts.now.getTime() - opts.intervalStartsAt.getTime()) / 3_600_000 : null;
  if (!opts.enabled) {
    return { decision: 'SKIPPED_DISABLED', reason: 'Learning is disabled (LEARNING_ENABLED=false)', hoursSinceLast: hours };
  }
  if (opts.newObservations < opts.requiredObservations) {
    const excluded = opts.excludedObservations
      ? ` (${opts.excludedObservations} backfilled/partial observations are not calibration-grade and do not count)`
      : '';
    return {
      decision: 'SKIPPED_INSUFFICIENT_OBSERVATIONS',
      reason: `Insufficient TRUE_ENTRY_SNAPSHOT observations: only ${opts.newObservations} new calibration-grade production observations; ${opts.requiredObservations} required${excluded}`,
      hoursSinceLast: hours,
    };
  }
  if (hours == null || hours < opts.requiredHours - LEARNING_INTERVAL_GRACE_MINUTES / 60) {
    return {
      decision: 'SKIPPED_INTERVAL_NOT_REACHED',
      reason: `Learning interval not reached (${hours == null ? 0 : hours.toFixed(1)}h of ${opts.requiredHours}h)`,
      hoursSinceLast: hours,
    };
  }
  return {
    decision: 'PERFORMED',
    reason: `${opts.newObservations} new calibration-grade production observations and ${hours.toFixed(1)}h since the last calibration`,
    hoursSinceLast: hours,
  };
}

async function lastPerformedRun(): Promise<{ createdAt: Date; cutoffSeq: number } | null> {
  const { rows } = await query<{ created_at: Date; cutoff_seq: string | null }>(
    `SELECT created_at, cutoff_seq FROM calibration_runs
     WHERE data_mode = $1 AND decision = 'PERFORMED' ORDER BY created_at DESC LIMIT 1`,
    [dataMode],
  );
  return rows[0] ? { createdAt: rows[0].created_at, cutoffSeq: Number(rows[0].cutoff_seq ?? 0) } : null;
}

export async function evaluateCalibrationGate(now = new Date()): Promise<CalibrationGate> {
  const last = await lastPerformedRun();
  const cutoff = last?.cutoffSeq ?? 0;
  const { rows } = await query<{
    new_n: string;
    new_excluded: string;
    total: string;
    max_seq: string | null;
    first_exit: Date | null;
  }>(
    `SELECT COUNT(*) FILTER (WHERE seq > $2 AND observation_quality = $3) AS new_n,
            COUNT(*) FILTER (WHERE seq > $2 AND observation_quality <> $3) AS new_excluded,
            COUNT(*) FILTER (WHERE observation_quality = $3) AS total,
            MAX(seq) AS max_seq,
            MIN(exit_at) FILTER (WHERE observation_quality = $3) AS first_exit
     FROM trade_observations WHERE data_mode = $1 AND portfolio_type = 'PRODUCTION'`,
    [dataMode, cutoff, CALIBRATION_GRADE_QUALITY],
  );
  const r = rows[0]!;
  // With no prior calibration, the interval runs from the first calibration-grade production exit
  const intervalStartsAt = last?.createdAt ?? r.first_exit ?? null;
  const gate = decideGate({
    enabled: env.LEARNING_ENABLED,
    newObservations: Number(r.new_n),
    requiredObservations: env.MIN_NEW_OBSERVATIONS_FOR_LEARNING,
    intervalStartsAt,
    requiredHours: env.LEARNING_INTERVAL_HOURS,
    now,
    excludedObservations: Number(r.new_excluded),
  });
  return {
    ...gate,
    newObservations: Number(r.new_n),
    requiredObservations: env.MIN_NEW_OBSERVATIONS_FOR_LEARNING,
    requiredHours: env.LEARNING_INTERVAL_HOURS,
    totalObservations: Number(r.total),
    lastPerformedAt: last?.createdAt ?? null,
    cutoffSeq: Number(r.max_seq ?? cutoff),
    intervalStartsAt,
  };
}

interface ActiveRow {
  strategy_id: string;
  action: 'PROMOTE' | 'ROLLBACK';
  version_id: string | null;
  version: string | null;
  candidate_parameters: EvCalibrationParams | null;
  previous_version_id: string | null;
  created_at: Date;
}

async function activeRows(scope = 'PRODUCTION'): Promise<ActiveRow[]> {
  const { rows } = await query<ActiveRow>(
    `SELECT DISTINCT ON (a.strategy_id) a.strategy_id, a.action, a.version_id, v.version,
            v.candidate_parameters, v.previous_version_id, a.created_at
     FROM calibration_activations a
     LEFT JOIN calibration_versions v ON v.id = a.version_id
     WHERE a.scope = $1 AND a.data_mode = $2
     ORDER BY a.strategy_id, a.created_at DESC`,
    [scope, dataMode],
  );
  return rows;
}

let cache: { at: number; map: Map<string, EvCalibration> } | null = null;

/** Promoted production EV calibrations by strategy (cached for one minute). */
export async function getActiveEvCalibrations(): Promise<Map<string, EvCalibration>> {
  if (cache && Date.now() - cache.at < 60_000) return cache.map;
  const map = new Map<string, EvCalibration>();
  for (const r of await activeRows()) {
    if (r.version_id && r.version && r.candidate_parameters) {
      map.set(r.strategy_id, { version: r.version, ...r.candidate_parameters });
    }
  }
  cache = { at: Date.now(), map };
  return map;
}

export function clearCalibrationCache(): void {
  cache = null;
}

function toCalibrationObs(o: ObservationRecord): CalibrationObservation {
  return {
    seq: o.seq,
    exitAt: o.exitAt,
    predictedEv: o.predictedEv,
    predictedWinProbability: o.predictedWinProbability,
    netReturn: o.netReturn,
    netPnlUsd: o.netPnlUsd,
    win: o.win,
    mfePct: o.mfePct,
    maePct: o.maePct,
    dataConfidence: o.dataConfidence,
    marketRegime: o.marketRegime,
    liquidityBucket: o.liquidityBucket,
    riskTier: o.riskTier,
  };
}

function describe(rows: CalibrationObservation[]) {
  return {
    n: rows.length,
    evBuckets: evBuckets(rows),
    winProbabilityBuckets: winProbabilityBuckets(rows),
    brierScore: brierScore(rows),
    segments: segmentTables(rows, ['marketRegime', 'dataConfidence', 'liquidityBucket', 'riskTier']),
  };
}

export interface CalibrationRunOutcome {
  runId: string;
  gate: CalibrationGate;
  strategies: StrategyCalibrationResult[];
}

/**
 * Level 3 entry point, called from the daily report. Records the run either way, so the
 * dashboard can explain why nothing was learned. Research observations are described but
 * never used for production calibration.
 */
export async function runCalibrationCycle(
  gate: CalibrationGate,
  opts: { reportId?: string | null; portfolioId?: string | null; now?: Date } = {},
): Promise<CalibrationRunOutcome> {
  const now = opts.now ?? new Date();
  const stage = stageFor(gate.totalObservations);
  const { rows: runRows } = await query<{ id: string }>(
    `INSERT INTO calibration_runs (
       decision, reason, new_observations, required_observations, hours_since_last, required_hours,
       total_observations, stage, cutoff_seq, details, data_mode, created_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
    [
      gate.decision,
      gate.reason,
      gate.newObservations,
      gate.requiredObservations,
      gate.hoursSinceLast,
      gate.requiredHours,
      gate.totalObservations,
      stage.stage,
      gate.decision === 'PERFORMED' ? gate.cutoffSeq : null,
      JSON.stringify({ reportId: opts.reportId ?? null }),
      dataMode,
      now,
    ],
  );
  const runId = runRows[0]!.id;
  if (gate.decision !== 'PERFORMED') {
    publish('learning_updated', { kind: 'calibration', runId, decision: gate.decision });
    return { runId, gate, strategies: [] };
  }

  const allProduction = (await loadObservations({ portfolioType: 'PRODUCTION', limit: 20_000 })).filter(
    (o) => o.seq <= gate.cutoffSeq,
  );
  // Only true entry-time snapshots are calibration-grade; the rest stay descriptive
  const production = allProduction.filter((o) => o.quality === CALIBRATION_GRADE_QUALITY);
  const research = await loadObservations({ portfolioType: 'RESEARCH', limit: 20_000 });
  const active = new Map((await activeRows()).map((r) => [r.strategy_id, r]));
  const strategyIds = [...new Set(production.map((o) => o.strategyId))].sort();
  const results: StrategyCalibrationResult[] = [];

  for (const strategyId of strategyIds) {
    const act = active.get(strategyId);
    const currentParams = act?.version_id && act.candidate_parameters ? act.candidate_parameters : null;
    const res = calibrateStrategy({
      strategyId,
      rows: production.filter((o) => o.strategyId === strategyId).map(toCalibrationObs),
      current: currentParams,
      totalProductionObservations: production.length,
      autoPromotion: !env.LEARNING_OBSERVATION_MODE,
    });
    results.push(res);
    if (!res.computed || !res.candidate) continue;

    const version = `evcal-${strategyId}-${now.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`;
    const { rows: v } = await query<{ id: string }>(
      `INSERT INTO calibration_versions (
         version, run_id, scope, strategy_id, kind, status, observation_count, training_count,
         validation_count, training_window_start, training_window_end, validation_window_start,
         validation_window_end, previous_version_id, previous_parameters, candidate_parameters,
         training_metrics, validation_metrics, promotion_decision, data_mode, created_at
       ) VALUES ($1,$2,'PRODUCTION',$3,'EV_LINEAR',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
       RETURNING id`,
      [
        version,
        runId,
        strategyId,
        res.status,
        res.trainingCount + res.validationCount,
        res.trainingCount,
        res.validationCount,
        res.trainingWindow?.start ?? null,
        res.trainingWindow?.end ?? null,
        res.validationWindow?.start ?? null,
        res.validationWindow?.end ?? null,
        act?.version_id ?? null,
        JSON.stringify(res.previous),
        JSON.stringify(res.candidate),
        JSON.stringify(res.trainingMetrics),
        JSON.stringify(res.validationMetrics),
        res.promotionDecision,
        dataMode,
        now,
      ],
    );
    if (res.status === 'PROMOTED') {
      await query(
        `INSERT INTO calibration_activations (scope, strategy_id, version_id, action, reason, actor, data_mode, created_at)
         VALUES ('PRODUCTION', $1, $2, 'PROMOTE', $3, 'calibration', $4, $5)`,
        [strategyId, v[0]!.id, res.promotionDecision, dataMode, now],
      );
      clearCalibrationCache();
    }
  }

  const prodObs = production.map(toCalibrationObs);
  const details = {
    reportId: opts.reportId ?? null,
    observationMode: env.LEARNING_OBSERVATION_MODE,
    dataQuality: {
      production: allProduction.length,
      calibrationEligible: production.length,
      excluded: allProduction.length - production.length,
    },
    production: describe(prodObs),
    productionDescriptiveAll: {
      ...describe(allProduction.map(toCalibrationObs)),
      note: 'All production observations including backfilled/partial — descriptive only',
    },
    productionByStrategy: Object.fromEntries(
      strategyIds.map((s) => [s, describe(prodObs.filter((_, i) => production[i]!.strategyId === s))]),
    ),
    research: { ...describe(research.map(toCalibrationObs)), note: 'Observational only — never used for production calibration' },
    strategies: results.map((r) => ({
      strategyId: r.strategyId,
      computed: r.computed,
      status: r.status ?? null,
      decision: r.promotionDecision ?? r.skippedReason ?? null,
      trainingCount: r.trainingCount,
      validationCount: r.validationCount,
    })),
  };
  await query(`UPDATE calibration_runs SET details = $2 WHERE id = $1`, [runId, JSON.stringify(details)]);

  const promoted = results.filter((r) => r.status === 'PROMOTED').length;
  await logBotEvent({
    portfolioId: opts.portfolioId ?? null,
    level: 'info',
    category: 'learning',
    message: `Calibration performed on ${production.length} calibration-grade production observations (${allProduction.length - production.length} descriptive-only excluded): ${results.filter((r) => r.computed).length} candidate(s), ${promoted} promoted${env.LEARNING_OBSERVATION_MODE ? ' (observation mode: automatic promotion disabled)' : ''}`,
    details: { runId, strategies: details.strategies },
  });
  publish('learning_updated', { kind: 'calibration', runId, decision: gate.decision, promoted });
  return { runId, gate, strategies: results };
}

/**
 * Operator rollback: re-activates the version that was active before the current one
 * (or the uncalibrated model). Appends an activation row; history is never modified.
 */
export async function rollbackCalibration(
  strategyId: string,
  actor: string,
  reason: string,
): Promise<{ strategyId: string; fromVersion: string | null; toVersionId: string | null }> {
  const act = (await activeRows()).find((r) => r.strategy_id === strategyId);
  if (!act?.version_id) {
    throw Object.assign(new Error(`No active calibration for ${strategyId}`), { status: 409 });
  }
  const target = act.previous_version_id;
  await query(
    `INSERT INTO calibration_activations (scope, strategy_id, version_id, action, reason, actor, data_mode)
     VALUES ('PRODUCTION', $1, $2, 'ROLLBACK', $3, $4, $5)`,
    [strategyId, target, reason, actor, dataMode],
  );
  clearCalibrationCache();
  await logBotEvent({
    level: 'warn',
    category: 'learning',
    message: `Calibration for ${strategyId} rolled back from ${act.version ?? 'unknown'} to ${target ?? 'uncalibrated model'}`,
    details: { strategyId, actor, reason },
  });
  publish('learning_updated', { kind: 'rollback', strategyId });
  return { strategyId, fromVersion: act.version, toVersionId: target };
}
