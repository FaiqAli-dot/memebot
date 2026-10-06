# MemeBot Upgrade Tracker

**Project**: Solana Memecoin Paper-Trading Bot
**Mode**: PAPER TRADING ONLY (No real execution, no wallets, no private keys)
**Last Updated**: 2026-10-05

---

## Project Overview

MemeBot is a Solana memecoin paper-trading and research platform with 100% virtual money. It discovers tokens, scores them with rule-based strategies, simulates execution with fees/slippage/price impact, and manages a virtual portfolio.

### Architecture

```
Frontend (React + TS + Vite)
    ↓ REST + WebSocket
API Server (Express, Node 20+)
    ↓
PostgreSQL 16+
    ↑
Background Worker (jobs):
  - token_discovery (15s)
  - market_data (10s)
  - onchain (30s)
  - safety (30s)
  - regime (30s)
  - signal (12s)
  - paper_execution (8s)
  - portfolio_valuation (10s)
  - analytics (30s)
  - daily_report (daily)
```

### Project Structure

```
apps/server/          API, worker, engines, providers, migrations, tests
apps/web/             React + TypeScript UI
packages/shared/      Shared types, zod schemas, constants
docker-compose.yml    Postgres
```

### Data Modes

- **demo**: Deterministic synthetic Solana-like tokens and quotes
- **live**: DexScreener for discovery + quotes; Solana RPC for priority fees; GeckoTerminal for holders

---

## Current State & Issues

### Critical Issues (from NO_TRADES_DIAGNOSIS.md)

1. **Token Universe Bug** (CRITICAL)
   - Evaluates only 50 most recently discovered tokens
   - Discovery rate: ~19 tokens/minute
   - 50 tokens = ~2.7 minutes window
   - Momentum Breakout requires tokens ≥5 minutes old
   - Result: Tokens disappear before becoming eligible

2. **EV Gate Double Penalty** (CRITICAL)
   - Hard-coded `dataConfidence = LOW`
   - -3 percentage point haircut
   - 1.5x threshold multiplier
   - Result: EV gate impossible for some strategies

3. **Pump.fun Liquidity** (HIGH)
   - ~91% of tokens report $0 liquidity (bonding-curve tokens)
   - DexScreener returns `liquidity: null` for pump.fun pairs
   - All strategies reject on liquidity minimum
   - Not a deliberate policy, accidental exclusion

4. **Volume Acceleration** (MEDIUM)
   - Compares overlapping 5-minute windows (~30-40s apart)
   - 90% overlap = ratios around 1.0 (noise)
   - Explosive ratios when earlier value near zero
   - Median: 1.09×, but spikes to 10,000×

5. **Shadow Trade Duplication** (MEDIUM)
   - Creates duplicate opportunities every ~12 seconds
   - 217 open shadows for ~40 tokens
   - Invalid for research data

6. **Cost Representation** (MEDIUM)
   - Field `executionCostUsd` contains fraction (0.0222 = 2.22%)
   - Confusing and dangerous

7. **Position Size in EV** (MEDIUM)
   - Assumes $5 position regardless of actual size
   - Costs should scale with position size

### Existing Features (from PLAN.md audit)

**Working & Reusable:**
- Provider interfaces (TokenDiscoveryProvider, MarketDataProvider, OnChainDataProvider, GasFeeProvider, SolPriceProvider)
- Demo/live swap
- Cost simulator (DEX/network/priority fees, constant-product impact, partial fills, fail-closed SOL/USD)
- Paper buy/sell transactional engine with fee records
- MomentumStrategyV1 rule-based scoring + filters
- Risk engine (drawdown, daily loss, position caps, sizing)
- Exit rules (SL/TP/trailing/max-hold/emergency liquidity)
- Worker job scheduler, Postgres NOTIFY → WebSocket hub
- Daily learning/report pipeline with guardrails
- UI: Dashboard, Scanner, Live, Positions, Trades, Strategies, Analytics, Reports, Settings, Token detail
- Unit + integration tests

**Gaps (from PLAN.md):**
- DexScreener boosts only; no organic launches
- Polling-only; no trade-stream events
- Token age uses first-seen when createdAt null
- No token safety gate before strategy
- No regime / lifecycle / multi-strategy / EV framework
- Execution lacks latency pipeline, quote replay, Jito, failure modes, realism profiles
- No shadow trades / missed-opportunity measurement
- No deterministic replay / walk-forward / OOS
- Learning optimizes win rate, no interactions, no shadow evidence
- Duplicate-position race
- Drawdown deadlock (MAX_DRAWDOWN never recovers)
- No kill switch / circuit breakers / alerts beyond pause

---

## Upgrade Plan

Based on `docs/instructions-for-no-trades-diagnosys-fix.md`

### Phase 1: Fix Structural Bugs

#### 1.1 Token Universe & Lifecycle

**Problem**: Evaluation limited to 50 newest tokens (~2.7 min window)

**Solution**:
- Separate discovery, tracking, and evaluation
- Implement token lifecycle states:
  - DISCOVERED → TRACKING → ELIGIBLE → ACTIVE → STALE → ARCHIVED
- Add configuration:
  ```
  TOKEN_TRACKING_MAX_AGE_HOURS=24
  TOKEN_TRACKING_CAP=5000
  TOKEN_EVALUATION_CAP_PER_TICK=200
  ```
- Rank evaluation by activity (liquidity, volume, acceleration, price movement, tx activity, freshness)
- Allow fair rotation, not permanent starvation of older tokens

**Files to modify**:
- `apps/server/src/services/token-service.ts` (listActiveTokenIds)
- `apps/server/src/jobs/runners.ts` (jobSignals)
- `apps/server/src/universe/` (create if needed)
- Database migration for lifecycle fields

#### 1.2 Token Age Calculation

**Problem**: Tokens disappear before reaching required age

**Solution**:
- Prefer pool creation timestamp (`poolCreatedAt` or `created_at_onchain`)
- Fallback to `firstObservedAt` only if pool creation unknown
- Persist both: `poolCreatedAt`, `firstObservedAt`, `ageSource`
- Ensure age does not cause premature removal from tracking

**Files to modify**:
- `apps/server/src/services/token-service.ts` (effectiveAgeMinutes)
- Database migration for age fields

#### 1.3 Pump.fun Handling

**Problem**: 91% of tokens have $0 liquidity (bonding-curve), silently excluded

**Solution**:
- Add liquidity status: KNOWN / UNKNOWN / BONDING_CURVE
- Mark pump.fun pre-migration tokens as RESEARCH_ONLY
- Continue collecting data for research
- Only KNOWN liquidity passes production trading checks
- Do not invent fake liquidity values
- Add explicit metadata for future bonding-curve modeling

**Files to modify**:
- `apps/server/src/providers/` (market data provider)
- `apps/server/src/services/token-service.ts`
- Database migration for liquidity status

#### 1.4 Volume Acceleration

**Problem**: Overlapping windows create noise

**Solution**:
- Use non-overlapping historical windows:
  - Current 5m vs previous completed 5m
  - Or current 5m vs `volume_1h / 12`
- Add minimum baseline:
  ```
  VOLUME_ACCEL_MIN_BASELINE_USD=500
  VOLUME_ACCEL_MAX=10
  ```
- Cap acceleration at reasonable maximum
- Store both raw and capped values with confidence
- Add flow acceleration: buy, sell, transaction, unique buyer

**Files to modify**:
- `apps/server/src/services/token-service.ts` (getPriorVolume5m)
- `apps/server/src/features/` (feature calculation)
- Database migration for acceleration fields

#### 1.5 Shadow Trade Fixes

**Problem**: Duplicate opportunities every 12 seconds

**Solution**:
- Implement idempotent shadow trade creation
- Use logical opportunity identity: tokenAddress + strategy + opportunityStartTime
- Add cooldown:
  ```
  SHADOW_REENTRY_COOLDOWN_SECONDS=300
  ```
- Simulate realistic execution (same as paper trades):
  - Entry/exit price, slippage, DEX fee, network fee, price impact
  - Execution latency, failure probability
  - Position size, SL/TP/trailing stop, max hold
  - Net P&L (not gross mid-price movement)

**Files to modify**:
- `apps/server/src/research/shadow.ts`
- Database migration for shadow lifecycle

#### 1.6 Cost Representation

**Problem**: Field contains fraction but name implies USD

**Solution**:
- Separate concepts clearly:
  - executionCostRate, executionCostUsd
  - slippageRate, slippageUsd
  - dexFeeRate, dexFeeUsd
  - networkFeeUsd
  - priceImpactRate, priceImpactUsd
  - totalCostRate, totalCostUsd
- Calculate based on actual proposed position size

**Files to modify**:
- `apps/server/src/execution/realism.ts` (estimateRoundTripCostPct)
- `apps/server/src/risk/expected-value.ts`
- Database migration for cost breakdown

### Phase 2: EV Model Improvements

#### 2.1 Remove Hard-coded Confidence

**Problem**: `dataConfidence = LOW` is hard-coded

**Solution**:
- Measure confidence from actual data:
  - Liquidity availability & freshness
  - Volume availability
  - Price freshness
  - Transaction count availability
  - Buy/sell data availability
  - Token age quality
  - Market-data completeness
  - Number of observations
- States: LOW / MEDIUM / HIGH
- Evidence-based, not because bot wants to trade

**Files to modify**:
- `apps/server/src/jobs/runners.ts` (jobSignals)
- `apps/server/src/risk/expected-value.ts`
- `apps/server/src/intelligence/` (confidence calculation)

#### 2.2 Provisional EV Configuration

**Problem**: Double penalty makes EV gate impossible

**Solution**:
- Remove artificial double penalty
- Keep conservative but achievable thresholds:
  ```
  MIN_EXPECTED_NET_VALUE=0.02
  LOW_CONFIDENCE_EV_MULTIPLIER=1.2
  ```
- Result: MEDIUM/HIGH need 2.0%, LOW needs 2.4%
- Explicitly provisional research configuration
- Do not claim statistical provenance

**Files to modify**:
- `apps/server/src/risk/expected-value.ts`
- `.env.example`

#### 2.3 Remove Hard-coded Buy/Sell Confidence

**Problem**: `buySellConfidence = LOW` hard-coded

**Solution**:
- Calculate from observed data:
  - Buy/sell ratio
  - Transaction count
  - Unique buyers/sellers
  - Consistency across time windows
  - Freshness
- Only LOW if data is actually insufficient

**Files to modify**:
- `apps/server/src/strategies/momentum-breakout.ts`
- `apps/server/src/intelligence/` (confidence calculation)

### Phase 3: Research Infrastructure

#### 3.1 Research Portfolio

**Problem**: No way to collect borderline opportunity data

**Solution**:
- Create separate portfolio types:
  - PRODUCTION: Normal strategy + EV + risk gates
  - RESEARCH: Borderline opportunities for evidence collection
- Research trades clearly marked: `portfolioType = RESEARCH`
- Never contaminate production metrics
- Configuration:
  ```
  RESEARCH_EXPLORATION_ENABLED=true
  RESEARCH_MAX_TRADES_PER_DAY=5
  RESEARCH_MAX_EV_SHORTFALL=0.015
  ```
- Limit is maximum, not quota
- Still requires: safety, known liquidity, valid market data, min position size, valid strategy, reasonable execution

**Files to modify**:
- `apps/server/src/jobs/runners.ts` (jobPaperExecution)
- Database migration for portfolio type
- Configuration

#### 3.2 Opportunity Recorder

**Problem**: No immutable snapshot of opportunities

**Solution**:
- Record opportunity snapshot when token becomes meaningful candidate:
  - token, strategy, timestamp
  - price, liquidity, volume, buys, sells, transactions
  - uniqueBuyers, uniqueSellers
  - marketRegime, tokenAge, dataConfidence
  - expectedValue, executionCost
- Track forward outcomes at: 10s, 30s, 1m, 3m, 5m, 10m, 20m, 30m
- Record: price, return, liquidity, volume, MFE, MAE, timeToMFE, timeToMAE
- Simulate configured SL/TP/trailing/max hold with correct event ordering

**Files to modify**:
- `apps/server/src/research/` (opportunity tracking)
- Database migration for opportunities and outcomes

#### 3.3 Empirical Calibration Pipeline

**Problem**: EV model uses arbitrary constants (pWin, expectedReturn, expectedLoss)

**Solution**:
- Build data pipeline to calibrate from closed paper/research trades
- Eventually estimate: P(win | strategy, regime, confidence, liquidity, flow)
- Estimate empirical: return distribution, loss distribution, MFE, MAE
- Staged milestones:
  - 0-100: observation / debugging
  - 100-300: descriptive statistics
  - 300-1000: initial calibration
  - 1000+: serious model fitting
- Do not treat 100 trades as mathematically sufficient

**Files to modify**:
- `apps/server/src/learning/` (calibration)
- `apps/server/src/research/` (outcome analysis)

### Phase 4: Backtest/Replay Support

#### 4.1 Replay Architecture

**Solution**:
- Make architecture compatible with replay
- Feed historical market observations into pipeline
- No look-ahead bias (time-guarded accessor)
- Do not use future candles to decide entries

**Files to modify**:
- `apps/server/src/replay/` (replay engine)
- Time-guarded data accessors

#### 4.2 Walk-Forward Evaluation

**Solution**:
- Support TRAIN/CALIBRATION → FORWARD TEST → ROLL WINDOW
- Distinguish historical calibration from unseen evaluation
- Do not optimize against same data used for evaluation

**Files to modify**:
- `apps/server/src/backtest/` (walk-forward)

### Phase 5: Diagnostic Improvements

#### 5.1 Diagnostic Funnel

**Problem**: Dashboard doesn't explain WHY there are no trades

**Solution**:
- Track funnel stages:
  - discovered, tracked, freshMarketData, knownLiquidity, researchOnly
  - safetyPassed, strategyEligible, EVPassed, riskPassed
  - executionAttempted, executed
- Track rejection counts:
  - tooOld, tooYoung, staleData, unknownLiquidity, lowLiquidity
  - safetyFailed, strategyFailed, volumeFailed, priceFailed
  - transactionCountFailed, EVFailed, riskFailed, executionFailed
- Show best candidate metrics:
  - best candidate, best EV, best strategy
  - closest EV miss
  - candidates within 0.5%, 1%, 2%

**Files to modify**:
- `apps/server/src/services/readiness-service.ts`
- `apps/web/src/pages/` (dashboard updates)

#### 5.2 Configuration Cleanup

**Solution**:
- Make important thresholds configurable:
  ```
  TOKEN_TRACKING_MAX_AGE_HOURS=24
  TOKEN_TRACKING_CAP=5000
  TOKEN_EVALUATION_CAP_PER_TICK=200

  VOLUME_ACCEL_MIN_BASELINE_USD=500
  VOLUME_ACCEL_MAX=10

  MIN_EXPECTED_NET_VALUE=0.02
  LOW_CONFIDENCE_EV_MULTIPLIER=1.2

  RESEARCH_EXPLORATION_ENABLED=true
  RESEARCH_MAX_TRADES_PER_DAY=5
  RESEARCH_MAX_EV_SHORTFALL=0.015

  SHADOW_REENTRY_COOLDOWN_SECONDS=300
  ```
- Use existing configuration system

**Files to modify**:
- `.env.example`
- `apps/server/src/config/` (if exists)

### Phase 6: Database Schema

**Required Migrations**:
- Token lifecycle fields (state, poolCreatedAt, firstObservedAt, ageSource)
- Liquidity status (KNOWN/UNKNOWN/BONDING_CURVE)
- Volume acceleration (raw, capped, confidence)
- Shadow trade lifecycle (opportunityId, cooldown)
- Cost breakdown (rate and USD fields)
- Data confidence
- Portfolio type (PRODUCTION/RESEARCH)
- Opportunity records and outcomes
- Funnel diagnostic fields

**Files to modify**:
- `apps/server/src/db/migrations/` (add new migration)

### Phase 7: Tests

**Required Tests**:
- Universe: token remains tracked beyond newest-50, token reaches 5m age, stale token archived, evaluation cap works, fair rotation works
- Age: pool creation timestamp preferred, first-observed fallback works, age does not cause premature removal
- Volume acceleration: non-overlapping windows, minimum baseline, capping
- Shadow trades: idempotent creation, cooldown enforcement
- Cost: correct rate/USD separation, scales with position size
- EV: confidence calculation, provisional thresholds
- Research: portfolio type separation, opportunity recording
- Replay: no look-ahead bias, deterministic

**Files to modify**:
- `apps/server/src/test/` (add new tests)

---

## Safety Constraints

**HARD BOUNDARY - MUST REMAIN PAPER ONLY**

Do NOT implement or enable:
- Real wallet signing
- Private-key storage
- Real transaction submission
- Real SOL transfers
- Real token purchases/sales
- Wallet connection for execution
- Automatic live trading

Keep:
```
TRADING_MODE=PAPER
REAL_EXECUTION_ENABLED=false
WALLET_SIGNING_ENABLED=false
```

Domain guard: `apps/server/src/domain/paper-safety.ts` refuses to start if real execution enabled.

---

## Implementation Order

1. **Phase 1.1-1.6**: Fix structural bugs (universe, age, pump.fun, acceleration, shadows, costs)
2. **Phase 2.1-2.3**: EV model improvements (confidence, thresholds, buy/sell confidence)
3. **Phase 3.1-3.3**: Research infrastructure (portfolio, opportunity recorder, calibration)
4. **Phase 5.1-5.2**: Diagnostic improvements (funnel, configuration)
5. **Phase 6**: Database schema (migrations for all above)
6. **Phase 7**: Tests (coverage for all changes)
7. **Phase 4**: Backtest/replay support (after core funnel works)

**Priority**: Fix structural bugs first, then EV model, then research infrastructure. The bot must be able to discover and evaluate opportunities before building advanced research features.

---

## Verification

After each phase:
1. Run typecheck: `npm run typecheck`
2. Run lint: `npm run lint`
3. Run unit tests: `npm run test:unit`
4. Run integration tests: `npm run test:integration`
5. Build: `npm run build`
6. Test in demo mode: `npm run dev` (DATA_MODE=demo)
7. Test in live mode: `npm run dev` (DATA_MODE=live) - observe trades

Before considering complete:
- At least 1-2 weeks of paper trading
- Target ≥100 closed trades
- Success criteria: positive net expectancy after costs, profit factor >1.2, max drawdown <15%, no single day losing >5%, stable across regimes

---

## Key Files Reference

| Area | Path |
|------|------|
| Worker jobs | `apps/server/src/jobs/runners.ts`, `scheduler.ts` |
| Strategies | `apps/server/src/strategies/catalog.ts`, `momentum-breakout.ts` |
| Risk engine | `apps/server/src/engines/risk/engine.ts` |
| Paper execution | `apps/server/src/engines/paper/engine.ts` |
| Exit rules | `apps/server/src/engines/paper/exits.ts` |
| Cost simulator | `apps/server/src/engines/cost/simulator.ts` |
| EV calculation | `apps/server/src/risk/expected-value.ts` |
| Token service | `apps/server/src/services/token-service.ts` |
| Shadow trades | `apps/server/src/research/shadow.ts` |
| Realism | `apps/server/src/execution/realism.ts` |
| Readiness | `apps/server/src/services/readiness-service.ts` |
| Data providers | `apps/server/src/providers/` |
| Database schema | `apps/server/src/db/migrations/` |
| API routes | `apps/server/src/api/routes/index.ts` |
| UI pages | `apps/web/src/pages/` |
| Shared types | `packages/shared/src/types.ts` |
| Paper safety | `apps/server/src/domain/paper-safety.ts` |

---

## Notes

- This is a **research-first** project. The goal is honest data collection, not forcing trades.
- Do NOT lower thresholds just to create activity.
- Do NOT remove safety checks.
- Do NOT invent liquidity for pump.fun tokens.
- All changes must preserve the paper-only boundary.
- Configuration should be explicit and measurable.
- Diagnostic visibility is critical - the dashboard must explain WHY no trades are happening.
- Eventually build proper bonding-curve model for pump.fun, but not in this upgrade.
