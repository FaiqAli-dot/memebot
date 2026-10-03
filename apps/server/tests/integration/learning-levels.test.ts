import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { config as loadEnv } from 'dotenv';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(__dirname, '../../../../.env') });

process.env.DATA_MODE = 'demo';
process.env.LEARNING_ENABLED = 'true';
process.env.LEARNING_INTERVAL_HOURS = '24';
process.env.MIN_NEW_OBSERVATIONS_FOR_LEARNING = '25';
process.env.ANOMALY_CHECK_INTERVAL_TRADES = '5';
process.env.ANOMALY_ALERT_COOLDOWN_MINUTES = '60';
// Promotion mechanics are exercised here; observation mode is covered in daily-report.test.ts
process.env.LEARNING_OBSERVATION_MODE = 'false';
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  'postgresql://memebot:memebot@localhost:5432/memebot_test';

type Db = typeof import('../../src/db/client.js');

describe('integration: three-level learning', () => {
  let db: Db;
  let observations: typeof import('../../src/learning/observations.js');
  let health: typeof import('../../src/learning/health-service.js');
  let calibration: typeof import('../../src/learning/calibration-service.js');
  let portfolios: typeof import('../../src/services/portfolio-service.js');
  let killSwitch: typeof import('../../src/monitoring/kill-switch.js');
  let productionId: string;
  let researchId: string;
  let tokenId: string;

  /** Bulk closed positions; EV is overstated by construction: realized ≈ 0.4 × EV − 1% */
  async function closedPositions(opts: {
    portfolioId: string;
    strategy: string;
    n: number;
    startHoursAgo: number;
    realized?: 'overstated' | 'accurate' | 'loss' | 'win';
    exitPrice?: number;
    closeReason?: string;
    /** false → no entry snapshot, i.e. a SIGNAL_BACKFILL observation */
    entrySnapshot?: boolean;
  }) {
    const realized =
      opts.realized === 'accurate'
        ? 'ev + noise'
        : opts.realized === 'loss'
          ? '-0.09'
          : opts.realized === 'win'
            ? '0.12'
            : '0.4 * ev - 0.01 + noise';
    const opened = `NOW() - ($4 * INTERVAL '1 hour') + i * INTERVAL '1 minute'`;
    const snapshot =
      opts.entrySnapshot === false
        ? 'NULL'
        : `jsonb_build_object('features', jsonb_build_object(
             'observedAt', to_json(${opened} - INTERVAL '2 seconds') #>> '{}',
             'quoteAgeMs', 800, 'liquidityUsd', 30000, 'priceChange5mPct', 4, 'volume5mUsd', 9000))`;
    await db.query(
      `INSERT INTO positions (
         portfolio_id, token_id, status, quantity, entry_price_usd, current_price_usd, cost_basis_usd,
         current_value_usd, realized_pnl_usd, net_pnl_usd, gross_pnl_usd, stop_loss_pct, take_profit_pct,
         highest_price_usd, entry_costs, exit_costs, close_reason, opened_at, closed_at, data_mode,
         strategy_key, journal, max_planned_loss_usd, requested_size_usd, entry_snapshot
       )
       SELECT $1, $2, 'CLOSED', 0, 1, COALESCE($7, 1 + r), 5, 0, 5 * r, 5 * r, 5 * r, 0.08, 0.2, 1.1,
              '{"totalCostUsd":0.1}', '{"totalCostUsd":0.1}',
              COALESCE($8, CASE WHEN r > 0 THEN 'take_profit' ELSE 'stop_loss' END),
              ${opened},
              ${opened} + INTERVAL '30 seconds',
              'demo', $3,
              jsonb_build_object('ev', jsonb_build_object('expectedNetValue', ev, 'winProbability', 0.55,
                                 'executionCostRate', 0.04)),
              0.5, 5, ${snapshot}
       FROM (
         SELECT i, ev, ${realized} AS r FROM (
           SELECT i, 0.02 + ((i * 37) % 60) / 1000.0 AS ev, (((i * 7919) % 101) - 50) / 5000.0 AS noise
           FROM generate_series(1, $5::int) AS i
         ) a
       ) b
       WHERE $6::boolean`,
      [opts.portfolioId, tokenId, opts.strategy, opts.startHoursAgo, opts.n, true, opts.exitPrice ?? null, opts.closeReason ?? null],
    );
    return observations.recordMissingObservations(10_000);
  }

  async function settingsSnapshot() {
    return JSON.stringify(await portfolios.getPortfolioSettings(productionId));
  }

  beforeAll(async () => {
    db = await import('../../src/db/client.js');
    const { migrate } = await import('../../src/db/migrate.js');
    observations = await import('../../src/learning/observations.js');
    health = await import('../../src/learning/health-service.js');
    calibration = await import('../../src/learning/calibration-service.js');
    portfolios = await import('../../src/services/portfolio-service.js');
    killSwitch = await import('../../src/monitoring/kill-switch.js');
    const tokens = await import('../../src/services/token-service.js');
    await migrate(process.env.DATABASE_URL);
    await db.query(`
      TRUNCATE calibration_activations, calibration_versions, calibration_runs, learning_anomalies,
               learning_health_checks, trade_observations, risk_decisions, paper_fills, fee_records,
               paper_orders, positions, signals, market_snapshots, tokens, user_portfolios CASCADE
    `);
    productionId = await portfolios.ensureDefaultPortfolio();
    researchId = await portfolios.ensureResearchPortfolio();
    tokenId = (await tokens.upsertDiscoveredToken({
      chain: 'solana',
      address: 'Learn1111111111111111111111111111111111111',
      symbol: 'LRN',
      name: 'Learning',
      decimals: 9,
      createdAt: null,
    }))!;
  }, 60_000);

  beforeEach(async () => {
    await db.query(`
      TRUNCATE calibration_activations, calibration_versions, calibration_runs, learning_anomalies,
               learning_health_checks, trade_observations CASCADE
    `);
    await db.query(`DELETE FROM positions`);
    await killSwitch.setKillSwitch(productionId, false);
    calibration.clearCalibrationCache();
  });

  afterAll(async () => {
    await db.closePool();
  });

  it('Level 1: open trades are excluded; a closed trade yields one immutable observation with its entry snapshot', async () => {
    const snapshot = {
      features: { observedAt: new Date(Date.now() - 61_000).toISOString(), liquidityUsd: 30_000, volume5mUsd: 9000 },
      maxHoldSec: 1800,
    };
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO positions (portfolio_id, token_id, status, quantity, entry_price_usd, current_price_usd,
         cost_basis_usd, current_value_usd, stop_loss_pct, take_profit_pct, highest_price_usd, opened_at,
         data_mode, strategy_key, entry_snapshot)
       VALUES ($1, $2, 'OPEN', 5, 1, 1, 5, 5, 0.08, 0.2, 1, NOW() - INTERVAL '60 seconds', 'demo', 'momentum', $3)
       RETURNING id`,
      [productionId, tokenId, JSON.stringify(snapshot)],
    );
    const id = rows[0]!.id;
    expect(await observations.recordTradeObservation(id)).toBe(false);

    // Later market data must not leak into the entry features
    await db.query(`UPDATE positions SET current_price_usd = 1.3 WHERE id = $1`, [id]);
    await db.query(
      `UPDATE positions SET status = 'CLOSED', closed_at = NOW(), net_pnl_usd = 1.4, gross_pnl_usd = 1.5,
         realized_pnl_usd = 1.4, close_reason = 'take_profit' WHERE id = $1`,
      [id],
    );
    expect(await observations.recordTradeObservation(id)).toBe(true);
    expect(await observations.recordTradeObservation(id)).toBe(false);

    const { rows: obs } = await db.query<{ snapshot_source: string; liq: string; exit_price_usd: string; portfolio_type: string }>(
      `SELECT snapshot_source, entry_features->>'liquidityUsd' AS liq, exit_price_usd, portfolio_type
       FROM trade_observations WHERE position_id = $1`,
      [id],
    );
    expect(obs).toHaveLength(1);
    expect(obs[0]!.snapshot_source).toBe('ENTRY_SNAPSHOT');
    expect(Number(obs[0]!.liq)).toBe(30_000);
    expect(Number(obs[0]!.exit_price_usd)).toBeCloseTo(1.3);
    expect(obs[0]!.portfolio_type).toBe('PRODUCTION');
    await expect(db.query(`UPDATE trade_observations SET symbol = 'X' WHERE position_id = $1`, [id])).rejects.toThrow(
      /immutable/,
    );
  });

  it('Level 2: runs only after N observations; 5 losses change nothing; repeated alerts are suppressed', async () => {
    const before = await settingsSnapshot();
    await closedPositions({ portfolioId: productionId, strategy: 'momentum', n: 4, startHoursAgo: 1, realized: 'loss' });
    expect(await health.runHealthCheckIfDue(productionId)).toBeNull();

    await closedPositions({ portfolioId: productionId, strategy: 'momentum', n: 1, startHoursAgo: 0.5, realized: 'loss' });
    const first = await health.runHealthCheckIfDue(productionId);
    expect(first).not.toBeNull();
    expect(first!.newObservations).toBe(5);
    expect(first!.emitted.length).toBeGreaterThan(0);
    expect(first!.result.anomalies.every((a) => a.severity !== 'CRITICAL')).toBe(true);
    expect(first!.protectionAction).toBeNull();

    // REGRESSION: five consecutive losses do not touch settings, risk, EV calibration or the bot
    expect(await settingsSnapshot()).toBe(before);
    expect(await killSwitch.isKillSwitchActive(productionId)).toBe(false);
    expect((await db.query(`SELECT 1 FROM calibration_activations`)).rows).toHaveLength(0);
    expect((await db.query(`SELECT 1 FROM calibration_versions`)).rows).toHaveLength(0);

    // Five new research trades trigger a check; unchanged production anomalies are not re-emitted
    await closedPositions({ portfolioId: researchId, strategy: 'momentum', n: 5, startHoursAgo: 0.2 });
    const second = await health.runHealthCheckIfDue(productionId);
    const firstKeys = new Set(first!.emitted.map((a) => a.key));
    const repeated = second!.result.anomalies.filter((a) => firstKeys.has(a.key));
    expect(repeated.length).toBeGreaterThan(0);
    expect(second!.emitted.filter((a) => firstKeys.has(a.key))).toEqual([]);
  });

  it('REGRESSION: 5 consecutive wins do not change parameters, sizing or calibration', async () => {
    const before = await settingsSnapshot();
    await closedPositions({ portfolioId: productionId, strategy: 'momentum-breakout', n: 5, startHoursAgo: 1, realized: 'win' });
    const check = await health.runHealthCheckIfDue(productionId);
    expect(check!.protectionAction).toBeNull();
    const gate = await calibration.evaluateCalibrationGate();
    expect(gate.decision).toBe('SKIPPED_INSUFFICIENT_OBSERVATIONS');
    await calibration.runCalibrationCycle(gate);
    expect(await settingsSnapshot()).toBe(before);
    expect((await db.query(`SELECT 1 FROM calibration_versions`)).rows).toHaveLength(0);
    expect((await db.query(`SELECT 1 FROM calibration_activations`)).rows).toHaveLength(0);
  });

  it('Level 2: a CRITICAL safety anomaly (invalid exit price) pauses new paper entries', async () => {
    await closedPositions({ portfolioId: productionId, strategy: 'momentum', n: 4, startHoursAgo: 1 });
    await closedPositions({
      portfolioId: productionId,
      strategy: 'momentum',
      n: 1,
      startHoursAgo: 0.5,
      exitPrice: 0,
      closeReason: 'stop_loss',
    });
    const out = await health.runHealthCheckIfDue(productionId);
    expect(out!.protectionAction).toMatch(/paused_new_entries/);
    expect(await killSwitch.isKillSwitchActive(productionId)).toBe(true);
  });

  it('Level 3: skips without data, calibrates per strategy on production only, versions, promotes and rolls back', async () => {
    const empty = await calibration.evaluateCalibrationGate();
    expect(empty.decision).toBe('SKIPPED_INSUFFICIENT_OBSERVATIONS');
    const skipped = await calibration.runCalibrationCycle(empty);
    expect(skipped.strategies).toEqual([]);
    expect((await db.query(`SELECT decision FROM calibration_runs`)).rows[0]).toMatchObject({
      decision: 'SKIPPED_INSUFFICIENT_OBSERVATIONS',
    });

    // Research data alone never satisfies the production gate
    await closedPositions({ portfolioId: researchId, strategy: 'momentum', n: 60, startHoursAgo: 80, realized: 'loss' });
    expect((await calibration.evaluateCalibrationGate()).newObservations).toBe(0);

    // Backfilled production observations are descriptive only: they never satisfy the gate
    await closedPositions({ portfolioId: productionId, strategy: 'momentum', n: 60, startHoursAgo: 90, entrySnapshot: false });
    const backfillOnly = await calibration.evaluateCalibrationGate();
    expect(backfillOnly.newObservations).toBe(0);
    expect(backfillOnly.reason).toMatch(/Insufficient TRUE_ENTRY_SNAPSHOT observations/);
    expect(backfillOnly.reason).toMatch(/60 backfilled/);

    await closedPositions({ portfolioId: productionId, strategy: 'momentum', n: 400, startHoursAgo: 72 });
    await closedPositions({ portfolioId: productionId, strategy: 'accurate', n: 100, startHoursAgo: 72, realized: 'accurate' });
    const gate = await calibration.evaluateCalibrationGate();
    expect(gate.decision).toBe('PERFORMED');
    expect(gate.newObservations).toBe(500);

    const run = await calibration.runCalibrationCycle(gate);
    const byId = Object.fromEntries(run.strategies.map((s) => [s.strategyId, s]));
    expect(byId.momentum!.status).toBe('PROMOTED');
    expect(byId.accurate!.status).toBe('REJECTED');

    // The 60 backfilled observations were not used to fit
    const { rows: qual } = await db.query<{ q: string; n: string }>(
      `SELECT observation_quality AS q, COUNT(*)::text AS n FROM trade_observations
       WHERE portfolio_type = 'PRODUCTION' GROUP BY 1 ORDER BY 1`,
    );
    expect(qual.map((r) => [r.q, Number(r.n)])).toEqual([
      ['SIGNAL_BACKFILL', 60],
      ['TRUE_ENTRY_SNAPSHOT', 500],
    ]);

    const { rows: versions } = await db.query<{ strategy_id: string; observation_count: number; status: string }>(
      `SELECT strategy_id, observation_count, status FROM calibration_versions ORDER BY strategy_id`,
    );
    expect(versions.map((v) => [v.strategy_id, v.observation_count, v.status])).toEqual([
      ['accurate', 100, 'REJECTED'],
      ['momentum', 400, 'PROMOTED'],
    ]);
    const active = await calibration.getActiveEvCalibrations();
    expect(active.get('momentum')!.offset).toBeLessThanOrEqual(0);
    expect(active.get('momentum')!.scale).toBeLessThanOrEqual(1);
    expect(active.has('accurate')).toBe(false);

    // Immediately afterwards nothing new → no second calibration
    expect((await calibration.evaluateCalibrationGate()).decision).toBe('SKIPPED_INSUFFICIENT_OBSERVATIONS');

    // Operator rollback restores the previous (uncalibrated) model; history is kept
    await calibration.rollbackCalibration('momentum', 'operator', 'integration test');
    expect((await calibration.getActiveEvCalibrations()).has('momentum')).toBe(false);
    expect((await db.query(`SELECT 1 FROM calibration_versions`)).rows).toHaveLength(2);
    expect((await db.query(`SELECT action FROM calibration_activations ORDER BY created_at`)).rows.map((r) => r.action)).toEqual([
      'PROMOTE',
      'ROLLBACK',
    ]);
    await expect(db.query(`UPDATE calibration_versions SET status = 'REJECTED'`)).rejects.toThrow(/immutable/);
  });
});
