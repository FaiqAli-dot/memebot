# Week-1 readiness audit — strategy parameters and learning data

This audit was done before the Week-1 changes, against the repository as it stood on 2026-10-03. It describes what the code actually did, not what the names suggested.

## 1–2. Strategies and their runtime configuration

The runtime path is `jobs/runners.ts` → `strategies/catalog.ts::evaluateAllStrategies(activeStrategies(catalog, settings.activeStrategyIds), ctx)`. The best BUY by confidence becomes the signal.

| Strategy id | Active by default | Thresholds at runtime |
|---|---|---|
| `momentum-breakout` (`momentum-v4`) | yes | **Hardcoded**: liquidity ≥ 5000, vol5m ≥ 1500, accel ≥ 1.3, Δ5m ≥ 1.5%, buy/sell ≥ 1.1, tx5m ≥ 15, age 5–1440 min, top holder ≤ 40%, overall ≥ 55 |
| `early-volume-expansion` (`eve-v1`) | yes | **Hardcoded**: accel ≥ 1.8, vol5m ≥ 2000, age ≤ 60 min, unique buyers ≥ 5 |
| `liquidity-expansion` (`liq-v1`) | yes | **Hardcoded**: liquidity ≥ 10 000, vol5m ≥ 5% of liquidity, Δ5m ≥ 0.5% |
| `trend-continuation`, `mean-reversion`, `post-selloff-recovery`, `wallet-flow` | no | Hardcoded |

All strategies also share the exit settings `stopLossPct`, `takeProfitPct`, `trailingStopPct` and `maxHoldingTimeSec` through `exitParamsFrom(settings)`. These are portfolio-wide.

## 3. `strategyParams` fields

`PortfolioSettings.strategyParams` was a single flat `MomentumStrategyParams` object with these fields:

- `minVolume5mUsd`
- `minVolumeAcceleration`
- `minPriceChange5mPct`
- `minBuySellRatio`
- `minLiquidityUsd`
- `minActivityTx5m`
- `minTokenAgeMinutes`
- `maxTokenAgeMinutes`
- `minOverallScore`
- `maxTopHolderPct`

It had no strategy owner.

## 4–6. Learner-adjustable parameters, where they are read, and dead parameters

`engines/learning/bounds.ts` listed 12 learnable parameters.

| Parameter | Read at runtime? | Where |
|---|---|---|
| the 9 `strategyParams.*` feature parameters | **NO — dead** | Only the legacy `engines/strategy/momentum-v1.ts::MomentumStrategyV1.evaluate`, which no runtime path calls. The scanner only uses `score()`, which ignores the parameters. |
| `stopLossPct`, `takeProfitPct`, `trailingStopPct` | yes | `exitParamsFrom`, `executePaperBuy`, and risk sizing (`assessPositionRisk` uses `stopLossPct` for planned loss) |

So every strategy-parameter lesson changed a value that nothing read. The integration test asserted that `minPriceChange5mPct` changed from 1.5 to 1.65 without any strategy behaving differently.

## 7–8. Lesson scope

- **All lessons were portfolio-wide.** `deriveLessons` analysed every closed production trade in the 7-day window, regardless of `strategy_key`.
- The feature parameters belonged to Momentum Breakout's filter set. Early Volume Expansion and Liquidity Expansion have their own, different, hardcoded thresholds.
- Exit lessons change values shared by all strategies. Widening the stop also raises planned loss per trade, which is a risk expansion.

## 9. How `deriveLessons()` decided

- **Strategy:** none.
- **Parameter:** `FEATURE_DEFS` mapped a feature to a parameter, plus exit heuristics.
- **Old value:** `getParam(settings, param)`.
- **New value:** one guarded step of ±10%, clamped to `LEARNING_BOUNDS`.
- **Evidence:** band and rest trade counts with win rates.
- **Training and validation metrics:** not stored.
- **70/30 split:** `forwardValidatedLessons` re-derived lessons on the newer 30% and kept a lesson only if the same parameter moved in the same direction. The validation numbers were not kept.
- **Feature source:** `featuresFromMarketState` rebuilt features from `signals.market_state`. Its volume acceleration was the legacy `vol5m / priorVolume5m` (or `vol5m·12 / vol1h`), **not** the capped non-overlapping acceleration the strategies actually compare against.

## 10. How the daily report applied lessons

`report-service.generateDailyReport` works like this:

1. Check the Level-3 gate.
2. Run `forwardValidatedLessons`.
3. `applyLessons` writes `settings` (top level or flat `strategyParams`).

There is a limit of 3 changes per day, plus a 3-day flip-flop guard. Two "worse" reviews in a row auto-revert.

## 11. How calibration versions apply at runtime

`getActiveEvCalibrations()` returns the latest PROMOTE activation per strategy, which is applied in the production lane's final EV only. `applyEvCalibration` can only lower EV. Promotion needed at least 300 production observations, counting every snapshot source.

## 12. Production vs research

`trade_observations.portfolio_type` is derived from `user_portfolios.portfolio_type`. Health checks are scoped per portfolio type. Calibration loads production only. Research appears only in descriptive tables.

## 13. How `SIGNAL_BACKFILL` was used

`SIGNAL_BACKFILL` was treated exactly like `ENTRY_SNAPSHOT` in all of these:

- health checks;
- the calibration gate count;
- the calibration fit;
- the promotion threshold;
- daily lessons, which didn't use observations at all and rebuilt features from signals;
- reports.

Live state at audit time: 33 production observations, of which **31 are `SIGNAL_BACKFILL`** and 2 are `ENTRY_SNAPSHOT`. The 2 entry snapshots lack the exact strategy inputs, `topHolderPct` and `overallScore`.

## Paper safety (verified)

- `env.TRADING_MODE` is `z.enum(['PAPER'])`.
- `domain/paper-safety.ts` refuses to start if `REAL_EXECUTION_ENABLED` or `WALLET_SIGNING_ENABLED` is set.
- There is no live executor, wallet signer or transaction submission code anywhere in `apps/server/src`. Execution is `engines/paper/engine.ts` only.

## After the Week-1 changes

- **Ownership.** `packages/shared/src/strategy-params.ts::STRATEGY_PARAM_REGISTRY` declares every runtime-configurable threshold under exactly one strategy. Settings are stored as `strategyParams[strategyId][param]`. `resolveStrategyParams` is the single resolution point: registry defaults, then stored values for declared params, clamped to range. Unknown keys are dropped, and a legacy flat map is read as Momentum Breakout's values. Defaults equal the previous hardcoded values, so behaviour did not change.
- **Wiring.** Momentum Breakout, Early Volume Expansion and Liquidity Expansion read their thresholds from `paramsFor(id, params)`. `jobSignals` and replay pass `resolveStrategyParams(settings.strategyParams)` into `evaluateAllStrategies`, which hands each strategy only its own values. Each signal records the thresholds in force in `market_state.strategyParams`.
- **Not learnable.** Inactive strategies (trend-continuation, mean-reversion, post-selloff-recovery, wallet-flow) remain hardcoded, and lessons for them are `unused_parameter`. Exit settings are portfolio-wide, and exit lessons are always `portfolio_scope`; they are reported and never applied. The top-level `minTokenAgeMinutes`, `maxTokenAgeMinutes` and `scanIntervalMs` settings are read by nothing; they were removed from the settings page and are never applied. `minLiquidityUsd` (top level) is the emergency-exit liquidity floor.
- **Lessons.** `deriveStrategyLessons` runs per strategy, using only that strategy's TRUE_ENTRY_SNAPSHOT observations and the exact `strategyInputs` captured at entry. A lesson is proposed on the older 70% and must be confirmed on the newer 30%, with both metric sets stored. Safety thresholds may only tighten. `applyLessons` refuses anything without `(strategyId, param)` ownership.
- **Observation quality.** Migration 009 adds the generated column `trade_observations.observation_quality`:
  - TRUE_ENTRY_SNAPSHOT: an entry snapshot with all core features;
  - PARTIAL_ENTRY_SNAPSHOT;
  - SIGNAL_BACKFILL.
  The calibration gate, the calibration fit, promotion counts and lessons use TRUE only. Health checks and descriptive report tables use everything.
- **Observation mode.** `LEARNING_OBSERVATION_MODE=true` (default) does the following:
  - validated lessons become `validated_not_applied`;
  - validated calibrations stay `VALIDATED`, never promoted;
  - a "worse twice" review does not auto-revert.
- **MFE/MAE** are outcome labels only. They are tracked on worker position ticks (about every 10 s), so short spikes between ticks are missed.
