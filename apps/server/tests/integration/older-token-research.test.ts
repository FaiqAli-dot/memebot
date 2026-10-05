import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { config as loadEnv } from 'dotenv';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(__dirname, '../../../../.env') });

process.env.DATA_MODE = 'demo';
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  'postgresql://memebot:memebot@localhost:5432/memebot_test';
process.env.OLDER_TOKEN_RESEARCH_ENABLED = 'true';
process.env.RESEARCH_EXPLORATION_ENABLED = 'true';

type Db = typeof import('../../src/db/client.js');
type Runners = typeof import('../../src/jobs/runners.js');
type Tokens = typeof import('../../src/services/token-service.js');
type Portfolios = typeof import('../../src/services/portfolio-service.js');
type Engine = typeof import('../../src/engines/paper/engine.js');
type Env = typeof import('../../src/config/env.js')['env'];

const PRODUCTION = '00000000-0000-4000-8000-000000000001';
const RESEARCH = '00000000-0000-4000-8000-000000000002';
const OLDER = '00000000-0000-4000-8000-000000000003';
const OLDER_STRATEGIES = ['older-breakout', 'older-revival'];

const GAS = {
  chain: 'solana',
  baseFeeLamports: 5000,
  priorityFeeLamports: 5000,
  solPriceUsd: 150,
  solPriceSource: 'test',
  solPriceObservedAt: new Date(),
  solPriceStale: false,
  usable: true,
  observedAt: new Date(),
};

describe('integration: older-token research lane isolation', () => {
  let db: Db;
  let runners: Runners;
  let tokens: Tokens;
  let portfolios: Portfolios;
  let engine: Engine;
  let env: Env;
  let seq = 0;

  const ago = (ms: number) => new Date(Date.now() - ms);

  async function newToken(ageHours: number, prefix = 'Ot'): Promise<{ id: string; address: string }> {
    seq++;
    const address = `${prefix}${String(seq).padStart(6, '0')}${'3'.repeat(40)}`.slice(0, 44);
    const id = (await tokens.upsertDiscoveredToken({
      chain: 'solana',
      address,
      symbol: `${prefix.toUpperCase()}${seq}`,
      name: `Older ${seq}`,
      decimals: 9,
      createdAt: null,
    }))!;
    await db.query(
      `UPDATE tokens SET lifecycle_state = 'ACTIVE',
              pool_created_at = NOW() - make_interval(mins => $2),
              first_observed_at = NOW() - make_interval(mins => $2),
              discovered_at = NOW() - make_interval(mins => $2)
       WHERE id = $1`,
      [id, Math.round(ageHours * 60)],
    );
    return { id, address };
  }

  async function snapshot(
    token: { id: string; address: string },
    at: Date,
    m: { v5m: number; v1h: number; v24h: number; liq?: number; tx1h?: [number, number]; tx24h?: [number, number] },
  ) {
    await tokens.insertMarketSnapshot(token.id, {
      chain: 'solana',
      address: token.address,
      priceUsd: 0.001,
      marketCapUsd: 500_000,
      volume5mUsd: m.v5m,
      volume1hUsd: m.v1h,
      volume24hUsd: m.v24h,
      buyVolume5mUsd: m.v5m * 0.75,
      sellVolume5mUsd: m.v5m * 0.25,
      txCount5m: 40,
      buys5m: 30,
      sells5m: 10,
      buys1h: m.tx1h?.[0] ?? 50,
      sells1h: m.tx1h?.[1] ?? 30,
      buys24h: m.tx24h?.[0] ?? 800,
      sells24h: m.tx24h?.[1] ?? 600,
      priceChange5mPct: 5,
      priceChange1hPct: 10,
      liquidityUsd: m.liq ?? 60_000,
      liquidityStatus: 'KNOWN',
      observedAt: at,
      venue: 'raydium',
      feeBps: 25,
      quoteReserve: (m.liq ?? 60_000) / 2,
      baseReserve: (m.liq ?? 60_000) / 2 / 0.001,
    });
    await db.query(`UPDATE tokens SET last_market_at = $2 WHERE id = $1`, [token.id, at]);
  }

  /** 12h-old token: active prior 11h (500 USD / 10 tx per 5m), quiet last hour, revival now. */
  async function revivingToken() {
    const t = await newToken(12);
    await snapshot(t, ago(6 * 60_000), { v5m: 3_000, v1h: 5_200, v24h: 71_200 });
    await snapshot(t, ago(3 * 60_000), { v5m: 4_000, v1h: 6_200, v24h: 72_200 });
    // 10s old: fresh, and clear of the 2s adverse-selection boundary so costs are deterministic
    await snapshot(t, ago(10_000), { v5m: 8_000, v1h: 10_200, v24h: 76_200 });
    return t;
  }

  /** 25-minute-old token with a production-style momentum burst. */
  async function youngToken() {
    const t = await newToken(25 / 60, 'Yg');
    await snapshot(t, ago(6 * 60_000), { v5m: 2_000, v1h: 6_000, v24h: 6_000 });
    await snapshot(t, ago(3 * 60_000), { v5m: 4_000, v1h: 10_000, v24h: 10_000 });
    await snapshot(t, ago(10_000), { v5m: 8_000, v1h: 14_000, v24h: 14_000 });
    return t;
  }

  async function signalsFor(tokenId?: string) {
    const { rows } = await db.query<{
      id: string;
      token_id: string;
      strategy_name: string;
      lane: string;
      target_portfolio_id: string | null;
      expected_value: Record<string, unknown>;
    }>(
      `SELECT id, token_id, strategy_name, lane, target_portfolio_id, expected_value FROM signals
       WHERE ($1::uuid IS NULL OR token_id = $1) ORDER BY created_at, id`,
      [tokenId ?? null],
    );
    return rows;
  }

  async function positionsIn(portfolioId: string) {
    const { rows } = await db.query<{ id: string; token_id: string; strategy_key: string | null; entry_signal_id: string | null }>(
      `SELECT id, token_id, strategy_key, entry_signal_id FROM positions WHERE portfolio_id = $1 ORDER BY opened_at`,
      [portfolioId],
    );
    return rows;
  }

  async function portfolioRow(id: string) {
    const { rows } = await db.query(
      `SELECT cash_usd, peak_equity_usd, risk_state, kill_switch_active, bot_status, starting_balance_usd
       FROM user_portfolios WHERE id = $1`,
      [id],
    );
    return rows[0];
  }

  async function resetAll() {
    await db.query(`
      TRUNCATE signal_execution_attempts, token_decision_feature_snapshots, token_decision_audits,
               risk_decisions, paper_fills, fee_records, paper_orders, positions, shadow_trades,
               missed_opportunities, market_snapshots, signals, opportunities, opportunity_trackers,
               opportunity_outcomes, trade_observations, strategy_runs, funnel_snapshots, tokens CASCADE
    `);
    for (const id of [PRODUCTION, RESEARCH, OLDER]) {
      await portfolios.resetPaperAccount(id);
      await db.query(
        `UPDATE user_portfolios SET kill_switch_active = false, risk_state = 'NORMAL', bot_status = 'RUNNING' WHERE id = $1`,
        [id],
      );
    }
  }

  beforeAll(async () => {
    db = await import('../../src/db/client.js');
    const { migrate } = await import('../../src/db/migrate.js');
    await migrate(process.env.DATABASE_URL);
    tokens = await import('../../src/services/token-service.js');
    portfolios = await import('../../src/services/portfolio-service.js');
    engine = await import('../../src/engines/paper/engine.js');
    env = (await import('../../src/config/env.js')).env;
    runners = await import('../../src/jobs/runners.js');
    runners.providers.gasFee.getFeeEstimate = async () => ({ ...GAS, observedAt: new Date(), solPriceObservedAt: new Date() });
    await portfolios.ensureDefaultPortfolio();
    await portfolios.ensureResearchPortfolio();
    await portfolios.ensureOlderTokenResearchPortfolio();
  }, 60_000);

  beforeEach(async () => {
    env.OLDER_TOKEN_RESEARCH_ENABLED = true;
    env.OLDER_TOKEN_RESEARCH_MAX_ROUND_TRIP_COST_PCT = 3;
    await resetAll();
  });

  afterAll(async () => {
    await db.closePool();
  });

  it('research trades use the older-token research portfolio, routed by target portfolio', async () => {
    const t = await revivingToken();
    await runners.jobSignals();

    const older = (await signalsFor(t.id)).filter((s) => OLDER_STRATEGIES.includes(s.strategy_name));
    expect(older).toHaveLength(1);
    expect(older[0]).toMatchObject({ lane: 'RESEARCH', target_portfolio_id: OLDER });
    // No fabricated EV: stored estimate has no return/loss and no EV
    expect(older[0]!.expected_value).toMatchObject({ grossUpside: null, downside: null, expectedNetValue: null, passes: false });

    await runners.jobPaperExecution();
    const opened = await positionsIn(OLDER);
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({ token_id: t.id, entry_signal_id: older[0]!.id });
    // Neither production nor the existing research portfolio picked up the older-lane signal
    for (const id of [PRODUCTION, RESEARCH]) {
      expect((await positionsIn(id)).map((p) => p.entry_signal_id)).not.toContain(older[0]!.id);
    }
    const { rows: attempts } = await db.query(
      `SELECT portfolio_id FROM paper_orders WHERE signal_id = $1`,
      [older[0]!.id],
    );
    expect(attempts.map((r) => r.portfolio_id)).toEqual([OLDER]);
    // The research position records the unknown EV, not a placeholder
    const { rows: pos } = await db.query(`SELECT expected_net_value FROM positions WHERE id = $1`, [opened[0]!.id]);
    expect(pos[0]!.expected_net_value).toBeNull();
  });

  it('the existing research lane never executes older-lane signals, and vice versa', async () => {
    const t = await revivingToken();
    // A legacy-routed research signal (no target) belongs to the existing research portfolio
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO signals (token_id, strategy_name, strategy_version, side, action, lane, risk_label, data_mode,
         momentum_score, liquidity_score, volume_score, holder_score, risk_score, overall_score,
         confidence, data_confidence, expected_value, market_state)
       VALUES ($1,'early-volume-expansion','eve-v1','BUY','BUY','RESEARCH','MODERATE','demo',80,80,80,50,40,85,85,'HIGH',$2,'{}')
       RETURNING id`,
      [t.id, JSON.stringify({ grossUpside: 0.18, downside: 0.1, timeToTargetSec: 600, expectedNetValue: 0.01, threshold: 0.02 })],
    );
    await runners.executeLane(OLDER, 'RESEARCH', 'RUNNING', PRODUCTION);
    expect(await positionsIn(OLDER)).toHaveLength(0);
    const { rows: orders } = await db.query(`SELECT portfolio_id FROM paper_orders WHERE signal_id = $1`, [rows[0]!.id]);
    expect(orders).toHaveLength(0);
  });

  it('a research-only signal can never execute in the production lane', async () => {
    const t = await revivingToken();
    await db.query(
      `INSERT INTO signals (token_id, strategy_name, strategy_version, side, action, lane, risk_label, data_mode,
         momentum_score, liquidity_score, volume_score, holder_score, risk_score, overall_score,
         confidence, data_confidence, expected_value, market_state, target_portfolio_id)
       VALUES ($1,'older-revival','or-r2','BUY','BUY','PRODUCTION','MODERATE','demo',80,80,80,50,40,85,85,'HIGH',$2,'{}',$3)`,
      [t.id, JSON.stringify({ grossUpside: null, downside: null, expectedNetValue: null, threshold: 0.02 }), PRODUCTION],
    );
    await runners.executeLane(PRODUCTION, 'PRODUCTION', 'RUNNING');
    expect(await positionsIn(PRODUCTION)).toHaveLength(0);
  });

  it('research P/L cannot affect production', async () => {
    const t = await revivingToken();
    const before = await portfolioRow(PRODUCTION);
    await runners.jobSignals();
    await runners.jobPaperExecution();
    const [p] = await positionsIn(OLDER);
    expect(p).toBeTruthy();
    // Close the research position at a heavy loss through the paper engine
    const sold = await engine.executePaperSell({
      portfolioId: OLDER,
      positionId: p!.id,
      midPriceUsd: 0.0002,
      quote: {
        priceUsd: 0.0002,
        priceChange5mPct: -40,
        liquidityUsd: 60_000,
        liquidityStatus: 'KNOWN',
        observedAt: new Date(),
        venue: 'raydium',
        feeBps: 25,
        quoteReserve: 30_000,
        baseReserve: 150_000_000,
      } as Parameters<Engine['executePaperSell']>[0]['quote'],
      gas: GAS,
      priorityFeeLamports: 5000,
      failedTxStillChargesNetwork: true,
      closeReason: 'STOP_LOSS',
    });
    expect(sold.success).toBe(true);
    const { rows: pnl } = await db.query(`SELECT realized_pnl_usd FROM positions WHERE id = $1`, [p!.id]);    expect(Number(pnl[0]!.realized_pnl_usd)).toBeLessThan(0);

    expect(await portfolioRow(PRODUCTION)).toEqual(before);
    const prod = (await portfolios.getPortfolio(PRODUCTION))!;
    expect(prod.realizedPnlUsd ?? 0).toBe(0);
    expect(prod.openPositions).toBe(0);
    expect((await positionsIn(PRODUCTION)).map((x) => x.token_id)).not.toContain(t.id);
  });

  it('research observations cannot enter production calibration', async () => {
    await revivingToken();
    await runners.jobSignals();
    await runners.jobPaperExecution();
    const [p] = await positionsIn(OLDER);
    await engine.executePaperSell({
      portfolioId: OLDER,
      positionId: p!.id,
      midPriceUsd: 0.0011,
      quote: {
        priceUsd: 0.0011,
        priceChange5mPct: 2,
        liquidityUsd: 60_000,
        liquidityStatus: 'KNOWN',
        observedAt: new Date(),
        venue: 'raydium',
        feeBps: 25,
        quoteReserve: 30_000,
        baseReserve: 27_000_000,
      } as Parameters<Engine['executePaperSell']>[0]['quote'],
      gas: GAS,
      priorityFeeLamports: 5000,
      failedTxStillChargesNetwork: true,
      closeReason: 'TAKE_PROFIT',
    });
    const { recordTradeObservation } = await import('../../src/learning/observations.js');
    await recordTradeObservation(p!.id);
    const { rows: obs } = await db.query(`SELECT portfolio_type, strategy_id FROM trade_observations WHERE position_id = $1`, [p!.id]);
    expect(obs).toHaveLength(1);
    expect(obs[0]!.portfolio_type).toBe('RESEARCH');

    const { evaluateCalibrationGate } = await import('../../src/learning/calibration-service.js');
    const gate = await evaluateCalibrationGate();
    expect(gate.totalObservations).toBe(0);
    expect(gate.newObservations).toBe(0);
    const { loadObservations } = await import('../../src/learning/repository.js');
    expect(await loadObservations({ portfolioType: 'PRODUCTION', limit: 100 })).toHaveLength(0);
  });

  it('research risk state and kill switch cannot affect production', async () => {
    await db.query(
      `UPDATE user_portfolios SET risk_state = 'KILL_SWITCH', kill_switch_active = true WHERE id = $1`,
      [OLDER],
    );
    // Production executes a valid production signal as usual
    const t = await youngToken();
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO signals (token_id, strategy_name, strategy_version, side, action, lane, risk_label, data_mode,
         momentum_score, liquidity_score, volume_score, holder_score, risk_score, overall_score,
         confidence, data_confidence, expected_value, market_state, target_portfolio_id)
       VALUES ($1,'early-volume-expansion','eve-v1','BUY','BUY','PRODUCTION','MODERATE','demo',80,80,80,50,40,85,85,'HIGH',$2,'{}',$3)
       RETURNING id`,
      [t.id, JSON.stringify({ grossUpside: 0.18, downside: 0.1, timeToTargetSec: 600, expectedNetValue: 0.05, threshold: 0.02 }), PRODUCTION],
    );
    await runners.jobPaperExecution();
    const prod = await positionsIn(PRODUCTION);
    expect(prod.map((p) => p.entry_signal_id)).toEqual([rows[0]!.id]);
    expect((await portfolioRow(PRODUCTION))!.risk_state).not.toBe('KILL_SWITCH');
    expect((await portfolioRow(PRODUCTION))!.kill_switch_active).toBe(false);
  });

  it('production kill switch stops the older research lane (one-way control)', async () => {
    await revivingToken();
    await runners.jobSignals();
    await db.query(`UPDATE user_portfolios SET kill_switch_active = true WHERE id = $1`, [PRODUCTION]);
    await runners.jobPaperExecution();
    expect(await positionsIn(OLDER)).toHaveLength(0);
  });

  it('rejected research candidates are recorded as opportunities with forward-return trackers', async () => {
    env.OLDER_TOKEN_RESEARCH_MAX_ROUND_TRIP_COST_PCT = 0.01;
    const t = await revivingToken();
    await runners.jobSignals();

    expect((await signalsFor(t.id)).filter((s) => OLDER_STRATEGIES.includes(s.strategy_name))).toHaveLength(0);
    const { rows: opps } = await db.query<{ id: string; strategy_id: string; decision: string; ev_net: string | null; features: Record<string, unknown> }>(
      `SELECT id, strategy_id, decision, ev_net, features FROM opportunities
       WHERE token_id = $1 AND strategy_id = ANY($2) ORDER BY strategy_id`,
      [t.id, OLDER_STRATEGIES],
    );
    const best = opps.find((o) => o.decision === 'OLDER_RESEARCH_REJECTED');
    expect(best).toBeTruthy();
    expect(best!.features).toMatchObject({ rejectionReason: 'round_trip_cost_too_high', portfolioId: OLDER });
    expect(best!.ev_net).toBeNull();
    const { rows: trackers } = await db.query(
      `SELECT status FROM opportunity_trackers WHERE opportunity_id = ANY($1)`,
      [opps.map((o) => o.id)],
    );
    expect(trackers).toHaveLength(opps.length);
    expect(trackers.every((r) => r.status === 'PENDING')).toBe(true);

    // Forward returns are measured from later snapshots by the existing outcome job
    await db.query(`UPDATE opportunities SET observed_at = observed_at - INTERVAL '6 minutes' WHERE id = ANY($1)`, [
      opps.map((o) => o.id),
    ]);
    await snapshot(t, new Date(), { v5m: 9_000, v1h: 19_000, v24h: 85_000 });
    const { processOpportunityOutcomes } = await import('../../src/research/opportunities.js');
    await processOpportunityOutcomes(new Date());
    const { rows: outcomes } = await db.query(
      `SELECT horizon_sec FROM opportunity_outcomes WHERE opportunity_id = $1`,
      [best!.id],
    );
    expect(outcomes.length).toBeGreaterThan(0);
  });

  it('production regression: identical production inputs give identical production decisions with the older lane on or off', async () => {
    async function scenario(olderEnabled: boolean) {
      await resetAll();
      env.OLDER_TOKEN_RESEARCH_ENABLED = olderEnabled;
      const older = await revivingToken();
      const young = await youngToken();
      const label = new Map([
        [older.id, 'older'],
        [young.id, 'young'],
      ]);
      await runners.jobSignals();
      await runners.jobSignals();
      await runners.jobPaperExecution();
      const { rows: sig } = await db.query<Record<string, unknown>>(
        `SELECT token_id, strategy_name, lane, target_portfolio_id, action, confidence,
                expected_value->>'passes' AS passes, expected_value->>'expectedNetValue' AS ev,
                position_size_usd, data_confidence
         FROM signals WHERE strategy_name <> ALL($1) ORDER BY strategy_name, lane, token_id`,
        [OLDER_STRATEGIES],
      );
      const { rows: opp } = await db.query<Record<string, unknown>>(
        `SELECT token_id, strategy_id, decision, ev_net, execution_cost_rate FROM opportunities
         WHERE strategy_id <> ALL($1) ORDER BY strategy_id, token_id`,
        [OLDER_STRATEGIES],
      );
      const { rows: pos } = await db.query<Record<string, unknown>>(
        `SELECT p.portfolio_id, p.token_id, p.strategy_key, p.cost_basis_usd, p.expected_net_value
         FROM positions p WHERE p.portfolio_id <> $1 ORDER BY p.portfolio_id, p.token_id`,
        [OLDER],
      );
      const { rows: shadows } = await db.query<Record<string, unknown>>(
        `SELECT portfolio_id, token_id, strategy_id, rejection_reason FROM shadow_trades ORDER BY portfolio_id, token_id, strategy_id`,
      );
      const { rows: olderSignals } = await db.query(`SELECT 1 FROM signals WHERE strategy_name = ANY($1)`, [OLDER_STRATEGIES]);
      const relabel = (rows: Record<string, unknown>[]) =>
        rows
          .map((r) => ({ ...r, token_id: label.get(r.token_id as string) ?? r.token_id }))
          .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
      return {
        decisions: {
          signals: relabel(sig),
          opportunities: relabel(opp),
          positions: relabel(pos),
          shadows: relabel(shadows),
          production: await portfolioRow(PRODUCTION),
          research: await portfolioRow(RESEARCH),
        },
        olderSignals: olderSignals.length,
      };
    }

    const off = await scenario(false);
    const on = await scenario(true);
    expect(off.olderSignals).toBe(0);
    expect(on.olderSignals).toBeGreaterThan(0);
    expect(off.decisions.signals.length + off.decisions.opportunities.length).toBeGreaterThan(0);
    expect(on.decisions).toEqual(off.decisions);
  });
});
