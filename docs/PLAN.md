# MemeBot Reality-First Paper Trading — Implementation Plan

**Status:** Active implementation plan  
**Base:** `main` @ `0e03e78` (daily learning report + research brief)  
**Constraint:** PAPER TRADING ONLY. No wallets, keys, signing, or real swaps.

## 0. Audit summary (current state)

### What works and should be reused
- Provider interfaces (`TokenDiscoveryProvider`, `MarketDataProvider`, `OnChainDataProvider`, `GasFeeProvider`, `SolPriceProvider`) with demo/live swap
- Cost simulator with DEX/network/priority fees, constant-product impact, partial fills, fail-closed SOL/USD
- Paper buy/sell transactional engine with fee records
- MomentumStrategyV1 rule-based scoring + filters
- Risk engine (drawdown, daily loss, position caps, sizing)
- Exit rules (SL/TP/trailing/max-hold/emergency liquidity) with market-mid exits
- Worker job scheduler, Postgres NOTIFY → WebSocket hub
- Daily learning/report pipeline with guardrails
- UI: Dashboard, Scanner, Live, Positions, Trades, Strategies, Analytics, Reports, Settings, Token detail
- Unit + integration tests for cost, strategy/risk, exits, paper loop, learning, SOL price

### Critical gaps (from RESEARCH_BRIEF + code review)
1. DexScreener boosts only; no organic launches; boosts unlabeled
2. Polling-only; no trade-stream events; buy/sell USD approximated from tx counts
3. Token age uses first-seen when `createdAt` null; pairCreatedAt ignored
4. No token safety gate before strategy
5. No regime / lifecycle / multi-strategy / EV framework
6. Execution lacks latency pipeline, quote replay, Jito, failure modes, realism profiles
7. No shadow trades / missed-opportunity measurement
8. No deterministic replay / walk-forward / OOS
9. Learning optimizes win rate, no interactions, no shadow evidence
10. **Duplicate-position race** (pre-loop open-position check)
11. **Drawdown deadlock** (MAX_DRAWDOWN never recovers)
12. No kill switch / circuit breakers / alerts beyond pause
13. Dashboard is functional but not a research terminal (no shadow/experiment/timeline overlays)

### Architecture decision
Extend the monorepo in place. Add clean modules under `apps/server/src/` without breaking the existing demo loop. Migrate job orchestration to call new engines; keep DB as source of truth. Frontend remains a thin research client — **no trading logic**.

```
Solana market
  → Token Discovery (multi-source, labeled)
  → Data Normalizer (MeasuredValue + freshness)
  → [Market Features | Wallet Flow | Token Safety]
  → Regime Detector + Lifecycle Phases
  → Strategy Engine (pluggable Strategy[])
  → Expected Value Assessment
  → Risk Engine (states + unique position constraint)
  → Execution Simulator (latency/quote/impact/failures)
  → [Paper Trades | Shadow Trades]
  → Outcome Engine
  → Research DB + Replay Data
  → Learning / Experiment Lab
```

### Paper-only enforcement
| Flag | Default | Behavior |
|---|---|---|
| `TRADING_MODE` | `PAPER` | Only accepted mode |
| `REAL_EXECUTION_ENABLED` | `false` | If `true` → **refuse to start** |
| `WALLET_SIGNING_ENABLED` | `false` | If `true` → **refuse to start** |

No real-execution module is shipped. Adding one later requires an architectural change + security review.

---

## Phase 1 — Data foundation
1. `MeasuredValue<T>` = `{ value, timestamp, source, confidence, freshness }`
2. Multi-source discovery: DexScreener boosts (labeled `PAID_BOOST`), DexScreener new pairs, GeckoTerminal new pools, demo organic launches; interface `TokenDiscoveryProvider { name; subscribe(); getRecentTokens() }`
3. Token lifecycle timestamps: first_observed, creation, migration, first_liquidity, first_trade, first_meaningful_volume; prefer real age over first-seen
4. Trade event model + ingestion path (demo stream + polling reconciliation)
5. Normalization layer; confidence LOW when approximating (tx-count buy/sell)
6. Migration `004_research_foundation.sql`

## Phase 2 — Safety engine
- Authorities, liquidity, holders, creator, trading behavior, sellability
- Classes: BLOCKED / EXTREME_RISK / HIGH_RISK / MEDIUM_RISK / LOWER_RISK / UNKNOWN
- Score 0–100; UNKNOWN never becomes safe; reasons array always present
- Runs **before** strategy tradability; blocks hard when BLOCKED

## Phase 3 — Market intelligence
- Real buy/sell flow features over windows: 10s, 30s, 1m, 3m, 5m, 15m, 30m, 1h
- Unique buyers/sellers, concentration, whale %, acceleration
- Regime: DEAD/COLD/NORMAL/HOT/EXTREME (data-driven thresholds)
- Lifecycle phases: LAUNCH → … → DEAD

## Phase 4 — Trading intelligence
- `Strategy.evaluate(context) → Signal { action: BUY|NO_TRADE, … }` — never SELL
- Strategies: MomentumBreakout, EarlyVolumeExpansion, LiquidityExpansion, TrendContinuation, MeanReversion, PostSelloffRecovery, WalletFlow (subset active by default)
- Pre-entry EV with cost/uncertainty threshold
- Dynamic sizing: base × confidence × liquidity × volatility × regime × exposure; hard caps
- Correlation / portfolio exposure metrics
- Fix duplicate positions (partial unique index + FOR UPDATE + idempotency)
- Fix drawdown: NORMAL / CAUTION / HALTED / RECOVERY with resume rules

## Phase 5 — Execution realism
- Latency stages with seeded distributions
- Realism profiles: Optimistic / Realistic / Conservative
- Quote provider (Jupiter read-only) + demo quotes
- Dynamic slippage, pool impact, DEX fees, priority/Jito, partial fills, failures
- Per-order audit fields (signal→confirm timestamps)

## Phase 6 — Research
- Shadow trades for every rejected opportunity meeting discovery criteria
- Missed-opportunity rejection classification + evidence
- Event recorder for full reconstruction
- Deterministic replay engine + seeded RNG
- Walk-forward + untouched OOS; regime-sliced backtests
- Multiple virtual portfolios (A–E) × bankroll sizes

## Phase 7 — Learning rebuild
- Optimize expectancy, PF, DD, risk-adjusted return, costs, tails — **not win rate**
- Feature-vector interactions; ML scaffolding (disabled until sufficient data)
- Parameter changes require evidence; no small-sample churn
- Daily research report: OBSERVATION / CONCLUSION / HYPOTHESIS

## Phase 8 — Operations
- Global paper kill switch (stop entries; keep exits/monitoring/analytics)
- Circuit breakers: abnormal losses, data corruption, provider outage, extreme slippage, liquidity collapse, trade-frequency runaway
- Health endpoint, structured metrics, optional Telegram/Discord/email alerts

## Phase 9 — Dashboard
- Research terminal: portfolio, live opportunities, positions, trade journal, strategy analytics, shadow comparison, token timeline, experiment lab, daily report
- Mobile-usable; dense, not decorative

## Testing & verification
- Unit: safety, features, regime, strategies, EV, execution, risk states, sizing
- Integration: paper loop, duplicate prevention, drawdown recovery, shadow, kill switch
- Replay: determinism, no look-ahead (time-guarded accessor fails on future)
- Startup refusal when real execution enabled
- typecheck, lint, build, demo E2E + screenshots

## Migration policy
- Additive migrations preferred; no destructive drops of existing tables
- `004` adds columns/tables; existing demo data preserved
- Unique open-position constraint is additive (partial unique index)

## Delivery order
Implement phases 1→9 in commits. Prefer finishing complete phases with tests over scaffolding everything thinly. Remaining work listed honestly in the final PR report.

## Edge verdict policy
After implementation, answer YES / NO / UNKNOWN on genuine edge **honestly**. Prior demo (net ≈ costs) → strategy **unvalidated**; improved realism that produces negative P/L is success, not failure.
