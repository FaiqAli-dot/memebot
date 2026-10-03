import type pg from 'pg';
import type {
  DailyReport,
  DailyReportListItem,
  Lesson,
  LessonStatus,
  PortfolioSettings,
  ReportReview,
  ReportSummary,
} from '@memebot/shared';
import { query, withTransaction } from '../db/client.js';
import { dataMode, env } from '../config/env.js';
import { defaultPortfolioSettings } from '../engines/risk/engine.js';
import { analyzeExits, analyzeFeatures, featuresFromMarketState } from '../engines/learning/analyze.js';
import { selectImportantTrades } from '../engines/learning/select.js';
import {
  FLIP_FLOP_DAYS,
  type PastLesson,
  applyLessons,
  deriveLessons,
  revertLessons,
} from '../engines/learning/lessons.js';
import { reviewLessons } from '../engines/learning/review.js';
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
         p.opened_at, p.closed_at, s.market_state, s.overall_score
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
    entryPriceUsd: Number(r.entry_price_usd),
    highestPriceUsd: Number(r.highest_price_usd),
    costBasisUsd: Number(r.cost_basis_usd),
    netPnlUsd: Number(r.net_pnl_usd),
    grossPnlUsd: Number(r.gross_pnl_usd),
    costsUsd: cost(r.entry_costs) + cost(r.exit_costs),
    closeReason: (r.close_reason as string | null) ?? null,
    openedAt: new Date(r.opened_at as Date),
    closedAt: new Date(r.closed_at as Date),
    features: featuresFromMarketState(
      r.market_state as Record<string, unknown> | null,
      Number(r.overall_score ?? 0),
    ),
  };
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
  const counts: Record<LessonStatus, number> = { applied: 0, skipped: 0, reverted: 0 };
  for (const l of lessons) if (l.param !== 'all') counts[l.status]++;
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
  return { ...defaultPortfolioSettings(), ...rows[0].settings };
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
      });
    } else {
      review = reviewLessons({ targetReportId: null, since: [], before: [], previousVerdict: null });
    }

    const features = analyzeFeatures(windowTrades, settingsBefore);
    const exits = analyzeExits(windowTrades, settingsBefore);

    let lessons: Lesson[];
    let settingsAfter: PortfolioSettings;
    if (review.reverted && target) {
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
      lessons = deriveLessons({
        features,
        exits,
        settings: settingsBefore,
        windowTradeCount: windowTrades.length,
        minTrades: env.LEARNING_MIN_TRADES,
        history,
        reportDate,
        enabled: env.LEARNING_ENABLED,
      });
      settingsAfter = applyLessons(settingsBefore, lessons);
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
        JSON.stringify({ features, exits, review, learningEnabled: env.LEARNING_ENABLED }),
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
