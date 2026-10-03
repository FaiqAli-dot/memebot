import type pg from 'pg';
import {
  STRATEGY_PARAM_REGISTRY,
  type DailyReport,
  type DailyReportListItem,
  type FeatureStat,
  type Lesson,
  type LessonStatus,
  type PortfolioSettings,
  type ReportReview,
  type ReportSummary,
  type StrategyReportSection,
} from '@memebot/shared';
import { query, withTransaction } from '../db/client.js';
import { dataMode, env } from '../config/env.js';
import { normalizeSettings } from '../engines/risk/engine.js';
import {
  analyzeExits,
  analyzeStrategyFeatures,
  strategyInputsFromMarketState,
} from '../engines/learning/analyze.js';
import { selectImportantTrades } from '../engines/learning/select.js';
import {
  FLIP_FLOP_DAYS,
  type PastLesson,
  applyLessons,
  deriveStrategyLessons,
  exitLessons,
  finalizeLessons,
  revertLessons,
} from '../engines/learning/lessons.js';
import { reviewLessons } from '../engines/learning/review.js';
import {
  evaluateCalibrationGate,
  getActiveEvCalibrations,
  runCalibrationCycle,
  type CalibrationGate,
} from '../learning/calibration-service.js';
import { CALIBRATION_GRADE_QUALITY, recordMissingObservations } from '../learning/observations.js';
import { loadObservations, type ObservationRecord } from '../learning/repository.js';
import { getDataQuality } from '../learning/quality.js';
import { learningModeInfo } from '../learning/mode.js';
import { finite, mean, wilson } from '../learning/stats.js';
import { createStrategyCatalog } from '../strategies/catalog.js';
import { type ClosedTrade, bucketStats, holdSec, isWin } from '../engines/learning/types.js';
import { logBotEvent } from './token-service.js';
import { publish } from '../ws/hub.js';
import { logger } from '../utils/logger.js';

export const REPORT_WINDOW_DAYS = 7;

export class ReportError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

type Db = Pick<pg.PoolClient, 'query'>;

export function localDateTime(now: Date, timeZone: string): { date: string; time: string } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

export function isReportDue(now: Date, timeZone: string, reportTime: string): boolean {
  return localDateTime(now, timeZone).time >= reportTime;
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const TRADE_SELECT = `
  SELECT p.id, p.token_id, t.symbol, p.entry_price_usd, p.highest_price_usd, p.cost_basis_usd,
         p.net_pnl_usd, p.gross_pnl_usd, p.entry_costs, p.exit_costs, p.close_reason,
         p.opened_at, p.closed_at, p.strategy_key, s.market_state, s.overall_score
  FROM positions p
  JOIN tokens t ON t.id = p.token_id
  LEFT JOIN signals s ON s.id = p.entry_signal_id
  WHERE p.portfolio_id = $1 AND p.status = 'CLOSED' AND p.data_mode = $2`;

function mapTrade(r: Record<string, unknown>): ClosedTrade {
  const cost = (c: unknown) => Number((c as { totalCostUsd?: number } | null)?.totalCostUsd ?? 0);
  return {
    positionId: String(r.id),
    tokenId: String(r.token_id),
    symbol: String(r.symbol),
    strategyId: (r.strategy_key as string | null) ?? null,
    entryPriceUsd: Number(r.entry_price_usd),
    highestPriceUsd: Number(r.highest_price_usd),
    costBasisUsd: Number(r.cost_basis_usd),
    netPnlUsd: Number(r.net_pnl_usd),
    grossPnlUsd: Number(r.gross_pnl_usd),
    costsUsd: cost(r.entry_costs) + cost(r.exit_costs),
    closeReason: (r.close_reason as string | null) ?? null,
    openedAt: new Date(r.opened_at as Date),
    closedAt: new Date(r.closed_at as Date),
    features: strategyInputsFromMarketState(
      r.market_state as Record<string, unknown> | null,
      r.overall_score == null ? null : Number(r.overall_score),
    ),
  };
}

/** Calibration-grade observation → learner trade. Features are the exact entry-time strategy inputs. */
function tradeFromObservation(o: ObservationRecord): ClosedTrade {
  return {
    positionId: o.positionId,
    tokenId: o.tokenId,
    symbol: o.symbol ?? '',
    strategyId: o.strategyId,
    entryPriceUsd: o.entryPriceUsd,
    highestPriceUsd: o.entryPriceUsd,
    costBasisUsd: o.positionSizeUsd,
    netPnlUsd: o.netPnlUsd,
    grossPnlUsd: o.grossPnlUsd,
    costsUsd: o.actualCostUsd ?? 0,
    closeReason: o.exitReason,
    openedAt: o.entryAt,
    closedAt: o.exitAt,
    features: o.strategyInputs,
  };
}

const strategyName = (() => {
  const names = new Map(createStrategyCatalog().map((s) => [s.id, s.name]));
  return (id: string) => STRATEGY_PARAM_REGISTRY[id]?.name ?? names.get(id) ?? id;
})();

async function latestCandidates(): Promise<Map<string, { version: string; status: string }>> {
  const { rows } = await query<{ strategy_id: string; version: string; status: string }>(
    `SELECT DISTINCT ON (strategy_id) strategy_id, version, status FROM calibration_versions
     WHERE data_mode = $1 ORDER BY strategy_id, created_at DESC`,
    [dataMode],
  );
  return new Map(rows.map((r) => [r.strategy_id, { version: r.version, status: r.status }]));
}

function strategySections(opts: {
  dayObs: ObservationRecord[];
  windowObs: ObservationRecord[];
  lessons: Lesson[];
  settings: PortfolioSettings;
  active: Map<string, { version: string }>;
  candidates: Map<string, { version: string; status: string }>;
}): StrategyReportSection[] {
  const ids = new Set<string>([
    ...Object.keys(STRATEGY_PARAM_REGISTRY),
    ...opts.windowObs.map((o) => o.strategyId),
    ...opts.lessons.map((l) => l.strategyId).filter((s): s is string => Boolean(s)),
  ]);
  return [...ids].sort().map((strategyId) => {
    const day = opts.dayObs.filter((o) => o.strategyId === strategyId);
    const win = opts.windowObs.filter((o) => o.strategyId === strategyId);
    const dayWins = day.filter((o) => o.win).length;
    const winWins = win.filter((o) => o.win).length;
    const ci = win.length ? wilson(winWins, win.length) : null;
    const cand = opts.candidates.get(strategyId);
    return {
      strategyId,
      name: strategyName(strategyId),
      day: {
        trades: day.length,
        wins: dayWins,
        losses: day.length - dayWins,
        winRatePct: day.length ? (dayWins / day.length) * 100 : null,
        netPnlUsd: day.reduce((a, o) => a + o.netPnlUsd, 0),
      },
      window: {
        trades: win.length,
        calibrationEligible: win.filter((o) => o.quality === CALIBRATION_GRADE_QUALITY).length,
        winRatePct: win.length ? (winWins / win.length) * 100 : null,
        winRateCI: ci ? { low: ci.low * 100, high: ci.high * 100 } : null,
        avgPredictedEv: mean(finite(win.map((o) => o.predictedEv))),
        avgRealizedReturn: mean(win.map((o) => o.netReturn)),
        avgPositionSizeUsd: mean(win.map((o) => o.positionSizeUsd)),
        netPnlUsd: win.reduce((a, o) => a + o.netPnlUsd, 0),
      },
      calibration: {
        activeVersion: opts.active.get(strategyId)?.version ?? null,
        latestCandidate: cand?.version ?? null,
        latestStatus: cand?.status ?? null,
      },
      params: (opts.settings.strategyParams[strategyId] ?? {}) as Record<string, number>,
      lessons: opts.lessons.filter((l) => l.strategyId === strategyId),
    };
  });
}

async function tradesByLocalDate(db: Db, portfolioId: string, from: string, to: string) {
  const { rows } = await db.query(
    `${TRADE_SELECT} AND (p.closed_at AT TIME ZONE $3)::date BETWEEN $4::date AND $5::date
     ORDER BY p.closed_at`,
    [portfolioId, dataMode, env.REPORT_TIMEZONE, from, to],
  );
  return rows.map(mapTrade);
}

async function tradesBetween(db: Db, portfolioId: string, after: Date, until: Date) {
  const { rows } = await db.query(
    `${TRADE_SELECT} AND p.closed_at > $3 AND p.closed_at <= $4 ORDER BY p.closed_at`,
    [portfolioId, dataMode, after, until],
  );
  return rows.map(mapTrade);
}

function summarize(day: ClosedTrade[], window: ClosedTrade[]): ReportSummary {
  const byCloseReason: Record<string, number> = {};
  for (const t of day) {
    const r = t.closeReason ?? 'unknown';
    byCloseReason[r] = (byCloseReason[r] ?? 0) + 1;
  }
  const wins = day.filter(isWin).length;
  const sum = (f: (t: ClosedTrade) => number) => day.reduce((s, t) => s + f(t), 0);
  return {
    tradeCount: day.length,
    wins,
    losses: day.length - wins,
    winRatePct: day.length ? (wins / day.length) * 100 : 0,
    netPnlUsd: sum((t) => t.netPnlUsd),
    grossPnlUsd: sum((t) => t.grossPnlUsd),
    costsUsd: sum((t) => t.costsUsd),
    avgHoldSec: day.length ? sum(holdSec) / day.length : 0,
    byCloseReason,
    windowDays: REPORT_WINDOW_DAYS,
    windowTradeCount: window.length,
    windowWinRatePct: bucketStats(window).winRatePct,
  };
}

function countLessons(lessons: Lesson[]): Record<LessonStatus, number> {
  const counts: Record<LessonStatus, number> = {
    applied: 0,
    skipped: 0,
    reverted: 0,
    rejected: 0,
    unused_parameter: 0,
    portfolio_scope: 0,
    validated_not_applied: 0,
  };
  for (const l of lessons) if (l.param !== 'all') counts[l.status] = (counts[l.status] ?? 0) + 1;
  return counts;
}

const REPORT_COLUMNS = `id, report_date::text AS report_date, data_mode, summary, important_trades,
  analysis, lessons, settings_before, settings_after, applied, rolled_back_at, created_at`;

function mapListItem(r: Record<string, unknown>): DailyReportListItem {
  const lessons = (r.lessons as Lesson[]) ?? [];
  return {
    id: String(r.id),
    reportDate: String(r.report_date),
    dataMode: r.data_mode as DailyReport['dataMode'],
    createdAt: new Date(r.created_at as Date).toISOString(),
    summary: r.summary as ReportSummary,
    lessonCounts: countLessons(lessons),
    applied: Boolean(r.applied),
    rolledBackAt: r.rolled_back_at ? new Date(r.rolled_back_at as Date).toISOString() : null,
  };
}

function mapReport(r: Record<string, unknown>): DailyReport {
  return {
    ...mapListItem(r),
    importantTrades: r.important_trades as DailyReport['importantTrades'],
    analysis: r.analysis as DailyReport['analysis'],
    lessons: r.lessons as Lesson[],
    settingsBefore: r.settings_before as PortfolioSettings,
    settingsAfter: r.settings_after as PortfolioSettings,
  };
}

async function lockedSettings(db: Db, portfolioId: string): Promise<PortfolioSettings> {
  const { rows } = await db.query<{ settings: PortfolioSettings }>(
    `SELECT settings FROM user_portfolios WHERE id = $1 FOR UPDATE`,
    [portfolioId],
  );
  if (!rows[0]) throw new ReportError('Portfolio not found', 404);
  return normalizeSettings(rows[0].settings);
}

async function saveSettings(db: Db, portfolioId: string, settings: PortfolioSettings) {
  await db.query(`UPDATE user_portfolios SET settings = $2, updated_at = NOW() WHERE id = $1`, [
    portfolioId,
    JSON.stringify(settings),
  ]);
}

export async function listReports(portfolioId: string, limit = 60): Promise<DailyReportListItem[]> {
  const { rows } = await query(
    `SELECT ${REPORT_COLUMNS} FROM daily_reports
     WHERE portfolio_id = $1 AND data_mode = $2
     ORDER BY report_date DESC LIMIT $3`,
    [portfolioId, dataMode, limit],
  );
  return rows.map(mapListItem);
}

export async function getReport(id: string): Promise<DailyReport | null> {
  const { rows } = await query(`SELECT ${REPORT_COLUMNS} FROM daily_reports WHERE id = $1`, [id]);
  return rows[0] ? mapReport(rows[0]) : null;
}

export async function generateDailyReport(
  portfolioId: string,
  opts: { reportDate?: string; force?: boolean; now?: Date } = {},
): Promise<{ report: DailyReport; created: boolean }> {
  const now = opts.now ?? new Date();
  const reportDate = opts.reportDate ?? localDateTime(now, env.REPORT_TIMEZONE).date;
  const observationMode = env.LEARNING_OBSERVATION_MODE;
  // Every closed trade must be an observation before the report reads them
  await recordMissingObservations(5000);
  // Level 3 gate: settings only change when enough new observations AND the interval passed
  const gate: CalibrationGate = await evaluateCalibrationGate(now);
  const windowObs = await loadObservations({
    portfolioType: 'PRODUCTION',
    exitAfter: new Date(now.getTime() - REPORT_WINDOW_DAYS * 86_400_000),
    limit: 20_000,
  });
  const dayObs = windowObs.filter((o) => localDateTime(o.exitAt, env.REPORT_TIMEZONE).date === reportDate);
  const gradeByStrategy = new Map<string, ClosedTrade[]>();
  for (const o of windowObs) {
    if (o.quality !== CALIBRATION_GRADE_QUALITY || o.exitAt > now) continue;
    gradeByStrategy.set(o.strategyId, [...(gradeByStrategy.get(o.strategyId) ?? []), tradeFromObservation(o)]);
  }
  const [dataQuality, active, candidates] = await Promise.all([
    getDataQuality(),
    getActiveEvCalibrations(),
    latestCandidates(),
  ]);

  const result = await withTransaction(async (db) => {
    await db.query(`SELECT pg_advisory_xact_lock(hashtext('daily_report:' || $1))`, [portfolioId]);

    const existing = await db.query(
      `SELECT ${REPORT_COLUMNS} FROM daily_reports
       WHERE portfolio_id = $1 AND report_date = $2::date AND data_mode = $3`,
      [portfolioId, reportDate, dataMode],
    );
    if (existing.rows[0]) {
      const prior = mapReport(existing.rows[0]);
      if (!opts.force) return { report: prior, created: false };
      if (prior.applied && !prior.rolledBackAt) {
        throw new ReportError(
          `The ${reportDate} report already changed settings; roll it back before regenerating`,
          409,
        );
      }
      await db.query(`DELETE FROM daily_reports WHERE id = $1`, [prior.id]);
    }

    const settingsBefore = await lockedSettings(db, portfolioId);
    const dayTrades = await tradesByLocalDate(db, portfolioId, reportDate, reportDate);
    const windowTrades = await tradesByLocalDate(
      db,
      portfolioId,
      addDays(reportDate, -(REPORT_WINDOW_DAYS - 1)),
      reportDate,
    );

    // Review the most recent report whose lessons are still in effect.
    const target = (
      await db.query<{ id: string; created_at: Date; lessons: Lesson[] }>(
        `SELECT id, created_at, lessons FROM daily_reports
         WHERE portfolio_id = $1 AND data_mode = $2 AND report_date < $3::date
           AND applied AND rolled_back_at IS NULL
         ORDER BY report_date DESC LIMIT 1`,
        [portfolioId, dataMode, reportDate],
      )
    ).rows[0];
    const previous = (
      await db.query<{ verdict: ReportReview['verdict'] | null; reverted: string | null }>(
        `SELECT analysis->'review'->>'verdict' AS verdict,
                analysis->'review'->>'reverted' AS reverted
         FROM daily_reports
         WHERE portfolio_id = $1 AND data_mode = $2 AND report_date < $3::date
         ORDER BY report_date DESC LIMIT 1`,
        [portfolioId, dataMode, reportDate],
      )
    ).rows[0];

    let review: ReportReview;
    if (target) {
      const since = await tradesBetween(db, portfolioId, target.created_at, now);
      const before = await tradesBetween(
        db,
        portfolioId,
        new Date(target.created_at.getTime() - REPORT_WINDOW_DAYS * 86_400_000),
        target.created_at,
      );
      review = reviewLessons({
        targetReportId: target.id,
        since,
        before,
        // A revert resets the streak so reverts can't cascade on consecutive days.
        previousVerdict: previous?.reverted === 'true' ? null : (previous?.verdict ?? null),
        minTrades: env.MIN_NEW_OBSERVATIONS_FOR_LEARNING,
      });
    } else {
      review = reviewLessons({ targetReportId: null, since: [], before: [], previousVerdict: null });
    }

    const strategyIds = [...new Set([...Object.keys(STRATEGY_PARAM_REGISTRY), ...gradeByStrategy.keys()])].sort();
    const features: FeatureStat[] = strategyIds.flatMap((id) =>
      analyzeStrategyFeatures(id, gradeByStrategy.get(id) ?? [], settingsBefore.strategyParams[id] ?? {}),
    );
    const exits = analyzeExits(windowTrades, settingsBefore);

    let lessons: Lesson[];
    let settingsAfter: PortfolioSettings;
    if (review.reverted && target && observationMode) {
      lessons = [
        {
          param: 'all',
          from: null,
          to: null,
          status: 'skipped',
          reason:
            'Performance was worse for two reports in a row after the last changes. LEARNING_OBSERVATION_MODE keeps settings frozen; roll the earlier report back manually if needed',
          evidence: { sinceTrades: review.since.n, beforeTrades: review.before.n },
        },
      ];
      settingsAfter = settingsBefore;
    } else if (review.reverted && target) {
      const undo = revertLessons(settingsBefore, target.lessons);
      settingsAfter = undo.settings;
      lessons = [
        ...undo.reverted,
        {
          param: 'all',
          from: null,
          to: null,
          status: 'skipped',
          reason: 'Performance was worse for two reports in a row after the last changes, so they were reverted; no new changes today',
          evidence: {
            sinceTrades: review.since.n,
            sinceWinRatePct: review.since.winRatePct,
            beforeTrades: review.before.n,
            beforeWinRatePct: review.before.winRatePct,
          },
        },
      ];
      await db.query(`UPDATE daily_reports SET rolled_back_at = NOW() WHERE id = $1`, [target.id]);
    } else if (gate.decision !== 'PERFORMED') {
      lessons = [
        {
          param: 'all',
          from: null,
          to: null,
          status: 'skipped',
          reason: `Calibration skipped: ${gate.reason}. Settings unchanged; still collecting observations`,
          evidence: {
            newObservations: gate.newObservations,
            requiredObservations: gate.requiredObservations,
            hoursSinceLast: gate.hoursSinceLast ?? 0,
            requiredHours: gate.requiredHours,
          },
        },
      ];
      settingsAfter = settingsBefore;
    } else {
      const history = (
        await db.query<{ report_date: string; lessons: Lesson[] }>(
          `SELECT report_date::text AS report_date, lessons FROM daily_reports
           WHERE portfolio_id = $1 AND data_mode = $2 AND rolled_back_at IS NULL
             AND report_date >= $3::date AND report_date < $4::date`,
          [portfolioId, dataMode, addDays(reportDate, -FLIP_FLOP_DAYS), reportDate],
        )
      ).rows.flatMap((r) =>
        r.lessons.map((l): PastLesson => ({ ...l, reportDate: r.report_date })),
      );
      // Each strategy learns only from its own calibration-grade trades; exits are shared → never applied
      const derived = [
        ...strategyIds.flatMap((strategyId) =>
          deriveStrategyLessons({
            strategyId,
            trades: gradeByStrategy.get(strategyId) ?? [],
            params: settingsBefore.strategyParams[strategyId] ?? {},
            minTrades: env.LEARNING_MIN_TRADES,
            history,
            reportDate,
          }),
        ),
        ...exitLessons(exits, settingsBefore),
      ];
      const applied = applyLessons(
        settingsBefore,
        finalizeLessons(derived, { enabled: env.LEARNING_ENABLED, observationMode }),
      );
      lessons = applied.lessons;
      settingsAfter = applied.settings;
    }

    const changed = lessons.some((l) => l.status === 'applied' || l.status === 'reverted');
    if (changed) await saveSettings(db, portfolioId, settingsAfter);

    const { rows } = await db.query(
      `INSERT INTO daily_reports (
         portfolio_id, report_date, data_mode, summary, important_trades, analysis, lessons,
         settings_before, settings_after, applied
       ) VALUES ($1, $2::date, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING ${REPORT_COLUMNS}`,
      [
        portfolioId,
        reportDate,
        dataMode,
        JSON.stringify(summarize(dayTrades, windowTrades)),
        JSON.stringify(selectImportantTrades(dayTrades)),
        JSON.stringify({
          features,
          exits,
          review,
          learningEnabled: env.LEARNING_ENABLED,
          calibrationGate: gate,
          mode: learningModeInfo(),
          dataQuality,
          strategies: strategySections({ dayObs, windowObs, lessons, settings: settingsAfter, active, candidates }),
        }),
        JSON.stringify(lessons),
        JSON.stringify(settingsBefore),
        JSON.stringify(settingsAfter),
        lessons.some((l) => l.status === 'applied'),
      ],
    );
    return { report: mapReport(rows[0]!), created: true };
  });

  if (result.created) {
    const { report } = result;
    try {
      await runCalibrationCycle(gate, { reportId: report.id, portfolioId, now });
    } catch (err) {
      logger.error({ err, reportId: report.id }, 'Calibration cycle failed');
    }
    await logBotEvent({
      portfolioId,
      level: 'info',
      category: 'learning',
      message: `Daily report ${report.reportDate}: ${report.summary.tradeCount} trades, ${report.lessonCounts.applied} settings changed, ${report.lessonCounts.reverted} reverted`,
      details: { reportId: report.id, lessonCounts: report.lessonCounts },
    });
    publish('report_generated', {
      id: report.id,
      reportDate: report.reportDate,
      lessonCounts: report.lessonCounts,
    });
  }
  return result;
}

export async function rollbackReport(id: string): Promise<DailyReport> {
  const report = await withTransaction(async (db) => {
    const { rows } = await db.query(
      `SELECT ${REPORT_COLUMNS}, portfolio_id FROM daily_reports WHERE id = $1 FOR UPDATE`,
      [id],
    );
    const row = rows[0];
    if (!row) throw new ReportError('Report not found', 404);
    const prior = mapReport(row);
    if (prior.rolledBackAt) throw new ReportError('This report was already rolled back', 409);
    if (!prior.applied) throw new ReportError('This report did not change any settings', 409);

    const portfolioId = String(row.portfolio_id);
    const current = await lockedSettings(db, portfolioId);
    const { settings } = revertLessons(current, prior.lessons);
    await saveSettings(db, portfolioId, settings);
    const updated = await db.query(
      `UPDATE daily_reports SET rolled_back_at = NOW() WHERE id = $1 RETURNING ${REPORT_COLUMNS}`,
      [id],
    );
    return { report: mapReport(updated.rows[0]!), portfolioId };
  });

  await logBotEvent({
    portfolioId: report.portfolioId,
    level: 'warn',
    category: 'learning',
    message: `Rolled back settings changes from the ${report.report.reportDate} report`,
    details: { reportId: id },
  });
  publish('report_generated', { id, reportDate: report.report.reportDate, rolledBack: true });
  return report.report;
}

/** Called by the worker every minute; generates today's report once the local report time passes. */
export async function runDailyReportIfDue(portfolioId: string, now = new Date()): Promise<void> {
  if (!isReportDue(now, env.REPORT_TIMEZONE, env.REPORT_TIME)) return;
  const { date } = localDateTime(now, env.REPORT_TIMEZONE);
  const exists = await query(
    `SELECT 1 FROM daily_reports WHERE portfolio_id = $1 AND report_date = $2::date AND data_mode = $3`,
    [portfolioId, date, dataMode],
  );
  if (exists.rows.length) return;
  const { report } = await generateDailyReport(portfolioId, { reportDate: date, now });
  logger.info({ reportId: report.id, reportDate: date }, 'Daily learning report generated');
}
