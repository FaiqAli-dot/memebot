# Older-Token Research Lane — Review Fixes

Branch: `feature/older-token-momentum-research` (local only, not pushed or merged)
Commits: `d29c966` (strategies), `0a4bf93` (lane isolation)
Date: 2026-10-05

The older-token lane is still **disabled by default** (`OLDER_TOKEN_RESEARCH_ENABLED=false`) and paper-only. Production strategies, risk gates, sizing, exits, calibration and the 5-position cap are unchanged.

---

## Summary

| # | Request | Outcome |
|---|---------|---------|
| 1 | Remove `minTokenAgeMinutes` as an eligibility gate | Removed; eligibility is prior-history coverage + volume |
| 2 | Proper dormant/revival baselines | Non-overlapping 24h−1h / 1h−5m / 5m windows |
| 3 | No hardcoded thresholds | 2x / 3x / 30% moved to the strategy parameter registry |
| 4 | Audit placeholder `expectedReturn`/`expectedLoss` | Removed; EV is unknown and can never pass |
| 5 | Unit tests for both strategies | 19 new tests + 20 registry cases |
| 6 | Isolation integration tests | 9 integration tests |
| 7 | Production regression test | Lane on vs off gives identical production decisions |
| 8 | Track rejected research opportunities | Every strategy-qualified candidate recorded with forward-return tracker |
| 9/11 | Real typecheck, lint, build, full tests | All pass (237 unit, 87 integration, 3 consecutive runs) |
| 10 | Review daily limit and evaluation budget | Configurable; budget 200 tokens/tick, daily backstop 48 |
| 12 | Do not merge | Not merged, not pushed |

---

## Bugs found and fixed

### 1. Research signals were not routed to a specific portfolio

Older-lane signals were stored with only `lane = 'RESEARCH'`. Two research portfolios share that lane, so:

- the existing research portfolio's execution query could pick up older-lane signals (and vice versa);
- production's research-signal cooldown counted older-lane signals, which could suppress the existing research lane.

**Fix:** migration `016_signal_target_portfolio.sql` adds `signals.target_portfolio_id`. All new signals record their target portfolio. `executeLane` and the research cooldown select only signals routed to their own portfolio. Legacy rows (`NULL`) keep their original lane routing for production and the existing research portfolio; the older-token portfolio never takes untargeted rows.

### 2. Daily cap used the wrong limit inside the execution loop

The check before selecting signals used the older lane's limit, but the per-signal check inside the loop used `RESEARCH_MAX_TRADES_PER_DAY` (5).

**Fix:** a single `researchDailyCap(portfolioId)` helper drives both checks.

### 3. Final EV check used the existing research lane's shortfall

The older lane's execution used `RESEARCH_MAX_EV_SHORTFALL` from the other lane. Now research-only strategies use the older lane's cost gate (see item 4).

---

## Items 1–3: eligibility, baselines, thresholds

New helper: `apps/server/src/strategies/historical-baseline.ts`.

The database has no long-horizon rollups, and own snapshots cover about 16 minutes. The available history is the provider's rolling windows, split so they do not overlap:

| Window | Calculation | Meaning |
|--------|-------------|---------|
| Prior history | `(volume24h − volume1h) / priorSlots` | Average per 5m before the last hour |
| Recent hour | `(volume1h − volume5m) / 11` | Average per 5m in the hour leading into now |
| Current | `volume5m` | Latest 5m window |

- Coverage = `min(24h, max(token age, time since first observed))`; prior window = coverage − 60 minutes.
- Prior transactions per 5m come from `(buys24h + sells24h) − (buys1h + sells1h)`.
- Inconsistent provider data (1h volume above 24h, missing 24h volume) is rejected rather than turned into a baseline.
- The snapshot-based, non-overlapping volume acceleration is still required.

**Older Breakout (`ob-r2`)** requires sufficient history, then: 5m volume ≥ `minVolume5mUsd`; 5m volume vs prior baseline ≥ `minVolumeRelativeBaseline`; 5m tx vs prior tx baseline ≥ `minActivityAcceleration`; plus acceleration, momentum and tx-count thresholds.

**Older Revival (`or-r2`)** requires sufficient history, then: last hour vs prior ≤ `maxDormancyActivityRatio` (quiet); 5m vs last hour ≥ `minRevivalVolumeRatio`; 5m vs prior ≥ `minVolumeRelativeBaseline`; 1h price change ≤ `maxPriceChange1hPct`; plus acceleration, momentum and buy/sell ratio.

**Registry changes** (`packages/shared/src/strategy-params.ts`):

| Strategy | New parameters (default) |
|----------|--------------------------|
| older-breakout | `minHistoryCoverageHours` (6), `minHistoryVolumeUsd` (20,000), `minVolumeRelativeBaseline` (3), `minActivityAcceleration` (2) |
| older-revival | `minHistoryCoverageHours` (6), `minHistoryVolumeUsd` (20,000), `maxDormancyActivityRatio` (0.5), `minRevivalVolumeRatio` (3), `minVolumeRelativeBaseline` (1.5), `maxPriceChange1hPct` (30) |

Removed: `minTokenAgeMinutes` from both older strategies; unused keys `referencePositionSizeUsd`, `maxPriceImpactPct`, `minLiquidityRetentionRatio`. Revival's `minVolume5mUsd` was declared but unused; it is now enforced. New keys are not learnable (`feature: null`).

---

## Item 4: placeholder return/loss audit

The strategies emitted `expectedReturn/expectedLoss` of `0.15/0.10` (breakout) and `0.12/0.09` (revival).

| Path | Effect before | Now |
|------|---------------|-----|
| EV | Placeholders + `pWin(confidence)` produced a model EV; the lane accepted EV within a shortfall of the threshold | Strategies emit `null`; `estimateExpectedValue` returns `expectedNetValue: null`, `passes: false`, reason `missing_return_or_loss_estimate` |
| Confidence | None (computed independently; used only to rank signals) | Unchanged |
| Risk tier / size | None (research lane always gets the `REDUCED` tier) | Unchanged |
| Execution | `signalFromStored` required the values; final EV recheck gated the trade | Null EV allowed only for research-only strategies in the research lane; gate is round-trip cost ≤ `OLDER_TOKEN_RESEARCH_MAX_ROUND_TRIP_COST_PCT` at final size |
| Stored records | Fake EV in `signals.expected_value`, `positions.expected_net_value`, `trade_observations` | Stored as null with warning `no_empirical_return_estimate` |
| Readiness / calibration | Readiness reads only non-null `ev_net`; calibration is production-only | No fabricated value can reach either |

The production lane can never pass a null EV, and research-only strategies are blocked from production execution as a defensive guard.

---

## Production exposure

- `Strategy.researchOnly` flag added; `activeStrategies()` always excludes research-only strategies, even if listed in `activeStrategyIds`. `researchOnlyStrategies()` feeds the older lane.
- `buildStrategyContext` is identical to `main`; the older lane adds its extra history fields to its own copy of the context, so production `market_state` is unchanged.
- The branch's change to the production replay engine was reverted.
- Production-visible changes: signals now record `target_portfolio_id`; `jobSignals` and `jobPaperExecution` are exported for tests.

---

## Item 8: rejected research opportunities

Before, the older lane recorded nothing for rejected candidates. Now every candidate a strategy qualifies goes through the existing `recordOpportunity`, which creates an opportunity tracker for forward returns:

| Decision | Meaning |
|----------|---------|
| `OLDER_RESEARCH_SIGNAL` | Traded candidate (signal created) |
| `OLDER_RESEARCH_REJECTED` | Rejected by the lane; `features.rejectionReason` is one of `network_fee_unpriced`, `round_trip_cost_too_high`, `critical_data_check_failed`, `signal_cooldown` |
| `OLDER_RESEARCH_NOT_SELECTED` | Qualified, but the other strategy had higher confidence |

`features` also records `lane` and `portfolioId`. Candidates rejected at the strategy stage (`NO_TRADE`) are not recorded, to avoid hundreds of rows per tick in the storage-constrained database.

---

## Item 10: volume settings

| Setting | Before | Now |
|---------|--------|-----|
| Evaluation budget | `min(TOKEN_EVALUATION_CAP_PER_TICK, 100)`, hardcoded 0.5 rotation | `OLDER_TOKEN_RESEARCH_EVALUATION_CAP` (200), `OLDER_TOKEN_RESEARCH_ROTATION_SHARE` (0.5), applied only to tokens with enough history coverage |
| Daily trades | 10 (5 in-loop, bug) | `OLDER_TOKEN_RESEARCH_MAX_TRADES_PER_DAY` (48) as a backstop; open-position and exposure limits remain the real controls |
| EV shortfall | `OLDER_TOKEN_RESEARCH_MAX_EV_SHORTFALL` (0.02) | Removed (no EV); replaced by `OLDER_TOKEN_RESEARCH_MAX_ROUND_TRIP_COST_PCT` (3) |

The existing research lane's `RESEARCH_MAX_TRADES_PER_DAY=5` is unchanged.

Other cleanup: the env override `RESEARCH_PORTFOLIO_ID` was removed (it could disagree with the constant used by `ensureResearchPortfolio`); `portfolio-service.ts` imports the shared `OLDER_TOKEN_RESEARCH_PORTFOLIO_ID` instead of a duplicate; simulation reset now also resets the older research portfolio.

---

## Tests

**Unit** — `apps/server/tests/unit/older-token-strategies.test.ts` (19 tests):
baseline math, coverage via observed span, inconsistent windows, history sufficiency without an age gate, breakout vs prior regime, missing tx history, registry overrides, revival dormancy and regime checks, null EV never passing, production selection excluding research-only strategies, lane gates.

`week1-readiness.test.ts` now has a case for every older-strategy registry parameter (this test was failing on the branch before the fixes).

**Integration** — `apps/server/tests/integration/older-token-research.test.ts` (9 tests):

1. Research trades use the older-token portfolio, routed by target portfolio, with null EV stored.
2. The existing research lane never executes older-lane signals, and vice versa.
3. A research-only signal can never execute in the production lane.
4. Research P/L (a losing close) does not change the production portfolio.
5. Research trade observations are typed `RESEARCH` and excluded from production calibration.
6. Research risk state and kill switch do not affect production.
7. The production kill switch stops the older lane (one-way control).
8. Rejected candidates are recorded with trackers, and forward outcomes are written.
9. Production regression: identical inputs with the lane on vs off give identical production signals, opportunities, positions, shadow trades and portfolio rows.

Mutation check: removing the routing filter in `executeLane` made tests 1, 2 and 9 fail.

---

## Verification (actually run)

| Check | Result |
|-------|--------|
| `npm run typecheck` | Pass |
| `npm run lint` | Pass |
| `npm run build` (shared, server, web) | Pass; migration 016 copied to `dist` |
| `npm run test:unit` | 21 files, 237 tests pass |
| `npm run test:integration` | 13 files, 87 tests pass, 3 consecutive runs |

The regression test was initially flaky in the full suite because of fixture timing (a snapshot exactly at the 2-second adverse-selection boundary) and row ordering by random UUIDs. Both were fixed in the test fixture; production code was not involved.

---

## Caveats before enabling

- At the $3 paper position size, estimated round-trip cost was about 2.7% in tests, mostly network fees. That is close to the 3% limit, so the lane may trade rarely until sizes grow or the limit is tuned.
- Provider 24h windows are the only long-horizon source; snapshot retention keeps own history short.
- Strategy-stage `NO_TRADE` candidates are not tracked as opportunities.
- Production signal rows now carry `target_portfolio_id`; migration 016 must run on deploy (it is additive and nullable).
