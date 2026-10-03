# Why MemeBot Is Not Making Any Trades — Diagnosis and Proposed Fix Plan

**Purpose of this document:** give a trading/quant reviewer everything needed to judge *why* the bot has made zero trades since the latest update, *how likely* it is to trade under the current configuration, and *which fixes* we propose — so they can approve, reject, or replace the plan before any code is changed.

**Status:** Diagnosis only. No trading logic has been changed yet.
**Mode:** Paper trading only (`TRADING_MODE=PAPER`, real execution and wallet signing are hard-disabled). Live market data (`DATA_MODE=live`) from DexScreener + GeckoTerminal on Solana.
**Observation window:** 2026-10-03, 21:14 → 21:34 (UTC+4), ~20 minutes of live running after merging PR #3 ("Reality-first paper trading: safety, multi-strategy, shadow, replay").

---

## 1. TL;DR

- **Zero signals, zero trades** in ~20 minutes, even though ~390 new tokens were discovered and ~190 were evaluated per 10-minute window.
- This is **not a warm-up delay**. All operational gates pass (bot running, kill switch off, worker alive, fresh prices, fresh SOL/USD, risk state NORMAL, $5 position size available).
- Under the current configuration the probability of a trade is **effectively zero**, for four structural reasons:
  1. **The bot only evaluates the 50 most recently discovered tokens.** Discovery runs at ~19 new tokens/minute, so that list covers only the last **~2.7 minutes**. Every token is evaluated only when it is 1–4 minutes old, and then it drops out forever.
  2. **The only strategy that can mathematically pass the profit check (Momentum Breakout) requires tokens to be ≥ 5 minutes old.** Combined with (1), it almost never sees an eligible token.
  3. **The other two active strategies cannot pass the expected-value (EV) gate at all**, regardless of how good the setup is. The gate applies a double penalty for "low data confidence" that is hard-coded, not measured.
  4. **~91% of discovered tokens report $0 liquidity** (pump.fun bonding-curve tokens, for which DexScreener returns no liquidity). Every strategy rejects them on the liquidity minimum.
- Secondary issue: the "volume acceleration" signal compares two heavily-overlapping 5-minute windows taken ~30–40 seconds apart, so it is mostly noise (median 1.09×), with occasional absurd spikes (10,000×) when the earlier value was near zero.
- **Proposed plan:** fix the structural bugs first (universe, age, liquidity, acceleration), then recalibrate the EV gate using one of the options in §7, and validate with replay + paper trading before any real-money consideration. The EV recalibration is the decision we most need the expert's input on.

---

## 2. How a trade happens (pipeline)

Every job runs on a timer in the worker process:

| Job | Interval | What it does |
|---|---|---|
| `token_discovery` | 15 s | Pulls new tokens from GeckoTerminal new pools, DexScreener new pairs/profiles/boosts |
| `market_data` | 10 s | Fetches price, liquidity, 5m/1h volume, buy/sell volume, tx count per token |
| `safety` | 30 s | Rug/safety assessment (mint/freeze authority, holder concentration, etc.) |
| `regime` | 30 s | Market regime (DEAD / NORMAL / HOT / EXTREME) |
| `signal` | 12 s | Runs strategies → EV gate → writes a BUY signal |
| `paper_execution` | 8 s | Takes signals from last 10 min → risk check → sizing → simulated fill |

A token must pass, in order:

1. **Be in the evaluation universe** — currently the 50 most recently discovered tokens (`listActiveTokenIds(50)`, ordered by `discovered_at DESC`).
2. **Have a fresh market snapshot** (not stale).
3. **Safety engine** — not blocked.
4. **At least one active strategy returns BUY.** Active strategies: `momentum-breakout`, `early-volume-expansion`, `liquidity-expansion`.
5. **EV gate** — expected net value after costs ≥ threshold.
6. **Risk engine** — drawdown / daily loss / max positions / cash.
7. **Simulated execution.**

Rejections at steps 3–6 are logged as "shadow trades" (hypothetical trades tracked for research), but only when the token's liquidity is ≥ $1,000.

---

## 3. What we observed (live data)

### 3.1 Funnel, last 10 minutes (from the new dashboard "Trading readiness" panel)

| Stage | Tokens dropped |
|---|---|
| Tokens evaluated | **190** |
| Too small to trade (liquidity < $1k or no strategy match; not shadow-logged) | 165 |
| Safety checks | 0 |
| Strategy filters (mostly "volume acceleration insufficient") | 10 |
| Profit vs. cost (EV) check | 15 |
| Risk & execution | 0 |
| **Signals → trades** | **0 → 0** |

Closest call: `AI / SOL` via Early Volume Expansion, EV **+2.98%** vs **+3.00%** required.

### 3.2 Rejections by strategy, last 60 minutes (distinct tokens)

| Strategy | Main rejection | Tokens |
|---|---|---|
| early-volume-expansion | volume acceleration < 1.8× | 38 |
| early-volume-expansion | **EV too low** (passed its own filters) | 25 |
| liquidity-expansion | **EV too low** (passed its own filters) | ~90 |
| liquidity-expansion | volume not confirming / no price confirmation | 19 |
| momentum-breakout | volume acceleration < 1.3× | 31 |
| momentum-breakout | **token age out of range (< 5 min)** | 23 |
| momentum-breakout | 5m volume < $1,500 | 8 |
| momentum-breakout | 5m price change < 1.5% | 8 |

EV-rejected candidates in the last 60 minutes:

| Strategy | EV rejections | Best EV | Average EV | Avg. round-trip cost |
|---|---|---|---|---|
| early-volume-expansion | 34 | **+2.98%** | +1.87% | 1.21% |
| liquidity-expansion | 207 | **−0.26%** | −1.25% | 1.74% |

### 3.3 Other measurements

- **Discovery rate:** 386 unique token addresses in 20 minutes (~19/min). 354 of them from GeckoTerminal new pools. Median discovery lag: **1.0 minute after pool creation**.
- **Evaluation window:** the 50 most recently discovered tokens span only **2.7 minutes**.
- **Liquidity coverage:** of 68 tokens priced in the last 2 minutes, **62 (91%) report liquidity = $0**. Verified against DexScreener directly: these are `dexId: pumpfun` (bonding-curve) pairs where DexScreener returns `liquidity: null`.
- **Market regime (last 60 min):** HOT 30, NORMAL 5, DEAD 3, EXTREME 2 snapshots. Regime is *not* the blocker.
- **Big pumps exist:** 24 distinct tokens had a ≥14% 5-minute price rise with ≥$5k liquidity and ≥$1.5k 5m volume in the last 20 minutes. Momentum Breakout rejected all of them — 23 on "age out of range" (they were < 5 minutes old while in the evaluation window) and 23 on "volume acceleration weak" (a token can hit both on different ticks).
- **Volume-acceleration distribution** (5m volume now ÷ 5m volume from 3 snapshots ≈ 30–40 s earlier, tokens with liquidity ≥ $5k): median **1.09×**, p90 2.17×, p99 **4,416×**. Only 33% of ticks reach 1.3×, 13% reach 1.8×.

---

## 4. Root causes (ranked by impact)

### 4.1 Evaluation universe is "the 50 newest tokens" (critical)

`jobSignals` calls `listActiveTokenIds(50)`, which returns the 50 tokens with the most recent `discovered_at`. At ~19 discoveries/minute this list rolls over every ~2.7 minutes. Consequences:

- Every token is evaluated only during roughly minutes 1–4 of its life, then never again.
- Any strategy that needs history (e.g., "has been trending for 15 minutes") or a minimum age cannot work.
- When the market is busy (exactly when opportunities are best), the window gets *shorter*.

### 4.2 Momentum Breakout's age gate conflicts with 4.1 (critical)

Momentum Breakout rejects tokens younger than 5 minutes (`ageMinutes < 5`) or older than 24 hours. Age uses the on-chain pool creation time when available; otherwise it falls back to *when the bot first saw the token*. Either way, while a token is in the 2.7-minute evaluation window it is almost always < 5 minutes old. This is the only strategy that can mathematically pass the EV gate (see 4.3), so the system as a whole is blocked.

### 4.3 EV gate double-penalises, and two strategies can never pass (critical)

**Formula** (`apps/server/src/risk/expected-value.ts`):

```
pWin  = clamp(0.35 + 0.25 × confidence/100, 0.15, 0.65)
pLose = 1 − pWin − 0.5 × failureProbability          (failureProbability = 0.08 in REALISTIC)
EV    = pWin × (expectedReturn − cost)
      − pLose × (expectedLoss + cost)
      − failureProbability × cost
      − 0.03            ← "low data confidence haircut"
threshold = MIN_EXPECTED_NET_VALUE (0.02) × 1.5      ← ×1.5 because uncertainty = LOW
          = 0.03
pass if EV ≥ 0.03
```

`dataConfidence` is **hard-coded to `'LOW'`** in the signal job (it is not measured). That single flag triggers *both* the −3 percentage-point haircut *and* the ×1.5 threshold multiplier. The bot effectively requires **≥ 6% expected edge per trade before the haircut**.

`expectedReturn` and `expectedLoss` are **fixed constants per strategy**, not learned from data:

| Strategy | expectedReturn | expectedLoss | Confidence formula |
|---|---|---|---|
| momentum-breakout | 1.5 × 5m price change (2%–35%) | 8% | overall score × 0.7 (×0.7 because `buySellConfidence` is also hard-coded `'LOW'`) |
| early-volume-expansion | 18% | 10% | 50 + 10×accel + 2×uniqueBuyers, max 95 |
| liquidity-expansion | 12% | 7% | 40 + 8×log10(liquidity), max 90 |

**Maximum achievable EV with current settings** (round-trip cost: 0.85% on Raydium/Meteora-style venues, 2.25% on pump venues):

| Strategy | Best possible case | Max EV (0.85% cost) | Max EV (2.25% cost) | Needs | Can pass? |
|---|---|---|---|---|---|
| early-volume-expansion | confidence 95 | **+2.97%** | +1.51% | 3.00% | **Never** (misses by 0.03pp) |
| liquidity-expansion | $1M liquidity → conf 88 | +0.23% | −1.23% | 3.00% | **Never** |
| momentum-breakout | best confidence (70) | only if 5m pump ≥ **14%** | only if 5m pump ≥ **16%** | 3.00% | Rarely (plus the age problem above) |

For Momentum Breakout at more typical confidence (overall score 55–85 → confidence 38–60), the required 5-minute pump is **15–19%**. In other words the bot only buys tokens already up 15%+ in five minutes — and then assumes they'll go up another 1.5× that.

### 4.4 ~91% of tokens have unknown liquidity (high)

pump.fun bonding-curve tokens have no AMM pool, and DexScreener returns `liquidity: null` for them. The bot stores that as `liquidity_usd = 0`. All strategies reject on their liquidity minimum ($3k / $5k / $10k), and because liquidity < $1k, the rejection isn't even shadow-logged. This silently removes ~9 of every 10 discovered tokens.

This may well be the *right outcome* (bonding-curve tokens are the riskiest), but it's currently accidental, not a deliberate policy, and it wastes most of the discovery budget.

### 4.5 Volume acceleration is measured over overlapping windows (medium)

`getPriorVolume5m` compares the current rolling 5-minute volume with the rolling 5-minute volume from the 4th-most-recent snapshot (~30–40 s earlier). Those two windows overlap by ~90%, so the ratio hovers around 1.0 and the gate (`≥1.3` / `≥1.8`) is passed mostly by noise. When the earlier value is near zero (a brand-new pool) the ratio explodes (we saw `volume_accel_x10341`), which also inflates Early Volume Expansion's confidence formula.

### 4.6 Uncalibrated probability model (medium, design)

`pWin = 0.35 + 0.25 × confidence` is a hand-picked mapping, not fitted to outcomes. The per-strategy return/loss constants are also guesses. The EV gate is therefore enforcing precision the model doesn't have. The new daily learning loop tunes strategy parameters but not these EV inputs.

### 4.7 Minor / bookkeeping issues found during diagnosis

- The EV result field named `executionCostUsd` actually holds a **fraction** (e.g. 0.0222 = 2.22%), not dollars.
- The EV cost estimate always assumes a **$5** trade size, regardless of the real position size.
- Shadow trades are re-created **every 12 s for the same token** (217 open shadows for ~40 tokens), and their returns are **gross of costs** with no stop-loss/take-profit ordering. Shadow statistics are therefore heavily duplicated and optimistic.
- Already fixed this session: a SQL type error (`$3 >= 1000` inferred as integer) was crashing the `market_data` job on every run after the merge. Fixed by casting to numeric.

---

## 5. Chances of making a trade under the current configuration

| Strategy | Chance of passing EV gate | Chance of being evaluated when eligible | Net |
|---|---|---|---|
| early-volume-expansion | 0% (mathematically capped at 2.97% < 3.00%) | — | **0** |
| liquidity-expansion | 0% (capped at +0.23% < 3.00%) | — | **0** |
| momentum-breakout | Only on ≥14–19% 5-minute pumps with ≥$5k reported liquidity, ≥1.3× acceleration, ≥1.1 buy/sell, ≥15 tx, overall score ≥55 | Needs age ≥5 min while among the 50 newest — only possible when discovery slows below ~10 tokens/min | **≈ 0 in busy markets; occasional in quiet ones** |

**Expected trades per day with current settings: approximately zero.** In 20 minutes of a HOT market, 24 tokens met the price/liquidity/volume part of the Momentum Breakout criteria and none could be evaluated at an eligible age.

---

## 6. Weak evidence on whether the filters are too strict

From shadow trades (hypothetical trades on EV-rejected candidates), de-duplicated to the **first** rejection per token/strategy and net of the estimated entry cost. **Caveats: tiny sample (14 and 26 tokens), ~12 minutes of follow-up, one session, mid-price returns, no SL/TP ordering.** This is directional only, not proof.

| Strategy (EV-rejected) | Tokens | Median net return | Mean net return | Touched −8% (SL) | Touched +20% (TP) |
|---|---|---|---|---|---|
| early-volume-expansion | 14 | +4.5% | +13.5% | 36% | 29% |
| liquidity-expansion | 26 | +1.3% | +8.1% | 31% | 27% |

Interpretation: there's no sign (yet) that the EV gate is saving money; the rejected candidates were not obviously bad. But the sample is far too small to conclude they were good either. This is exactly why we propose gathering more paper data (see Phase 3).

---

## 7. Proposed solution

### Phase 1 — Fix structural bugs (recommended regardless of EV decision)

**1A. Evaluation universe.** Replace "50 newest" with "all tokens that have a fresh snapshot and are within the strategies' age range", ranked by activity (e.g. 5m volume) with a cap of ~150–200 per tick. Keep tokens eligible for up to 24 h after discovery. Must stay within API rate limits (DexScreener ~300 req/min, 30 addresses per batch).

**1B. Age definition.** Use pool creation time (`created_at_onchain`) consistently. If unknown, use first-observed time but do not let the universe roll the token out before it can become eligible.

**1C. Liquidity policy for pump.fun bonding-curve tokens.** Choose explicitly:
- (a) **Exclude** pre-migration bonding-curve tokens, label them "bonding curve — excluded", and stop spending market-data calls on them; *or*
- (b) **Model** them: derive effective liquidity from bonding-curve reserves (pump.fun API / on-chain), apply the pump.fun fee (~1% per side) and bonding-curve price impact, and let strategies evaluate them.
- Our default recommendation is **(a)** until the core loop is proven.

**1D. Volume acceleration.** Compare against a non-overlapping baseline: current 5m volume vs. the 5m volume from a snapshot ≥ 5 minutes earlier, or vs. `volume_1h / 12`. Require a minimum baseline (e.g. ≥ $500) to avoid divide-by-near-zero artefacts, and cap acceleration at ~10× in confidence formulas.

**1E. Bookkeeping.** One shadow per token/strategy per N minutes; net-of-cost shadow returns with simulated SL/TP order; rename `executionCostUsd` → `executionCostPct`; use real proposed size in the cost estimate.

### Phase 2 — Recalibrate the EV gate (decision needed)

Effect of each option on the *minimum* setup quality needed to pass. Values below are for Momentum Breakout at a mid confidence of 59.5; Early Volume Expansion's confidence is always ≥ ~74 when its own filters pass.

| Option | What changes | EVE (0.85% cost) | LIQ (0.85% cost) | MB min 5m pump (0.85% / 2.25% cost) |
|---|---|---|---|---|
| **A. Current** | haircut 3pp, need 3.0% | never | never | 15% / 17% |
| **B. Drop haircut** | keep ×1.5 threshold (need 3.0%) | conf ≥ 53 → passes when its filters pass | only at ~$1M liquidity | 11% / 13% |
| **C. Keep haircut, drop ×1.5** | need 2.0% | conf ≥ 82 | never | 13% / 15% |
| **D. Measure data confidence** | `MEDIUM` when liquidity, volume, tx count and price are present and fresh; `LOW` only when fields are missing → no haircut, ×1.2 (need 2.4%) | conf ≥ 45 | ≥ $10k liquidity | 10% / 12% |
| **E. D + `MIN_EXPECTED_NET_VALUE` 0.01** (paper only) | need 1.2% | conf ≥ 27 | ≥ $5k liquidity | 8% / 10% |

Additional options (can combine with the above):

- **F. Paper-only exploration budget.** Allow up to N (e.g. 5) trades/day that fail EV by a small margin (e.g. within 1.5pp), tagged `exploratory`, at minimum size. Purpose: collect real outcome data to calibrate the EV inputs. Never enabled outside paper mode.
- **G. Calibrate pWin and expectedReturn/Loss from data.** Fit `pWin(confidence)` and per-strategy average win/loss from closed paper trades + de-duplicated shadow trades, refreshed by the daily learning job, with guardrails. Long-term fix for 4.6.
- **H. Remove the hard-coded `buySellConfidence: 'LOW'`** (Momentum Breakout ×0.7 confidence multiplier) and measure it from data availability.

**Our recommendation:** Phase 1 (all) + **D** + **F**, then move to **G** once there are ≥ 100 closed paper trades. This keeps a meaningful EV bar (2.4%) for well-measured tokens, stops penalising every token for a flag that was never measured, and generates the data needed to replace the guessed parameters.

### Phase 3 — Validate before trusting it

1. **Replay:** run the replay engine (`apps/server/src/replay`) over recorded snapshots with the new settings to estimate trades/day, win rate, and net expectancy *after* costs.
2. **Paper run:** at least 1–2 weeks, target ≥ 100 closed trades.
3. **Success criteria (proposed):** positive net expectancy after all simulated costs; profit factor > 1.2; max drawdown < 15%; no single day losing > 5%; results stable across at least two market regimes.
4. **Real money stays off** until the above holds and the separate go-live checklist in `docs/RESEARCH_BRIEF.md` is satisfied.

---

## 8. Questions for the trading expert

1. Is evaluating tokens only within their first ~3 minutes ever desirable, or should the universe cover tokens up to 24 h old (ranked by activity)?
2. Should pump.fun **bonding-curve** (pre-migration) tokens be excluded entirely, or modelled with bonding-curve liquidity and fees?
3. Is a minimum age of 5 minutes for Momentum Breakout reasonable, given most pumps happen in the first minutes? What age bands would you use per strategy?
4. Which EV option (A–E) do you prefer? Is ~2.4% net expected edge per trade a sensible bar for memecoin scalps with ~10–20 minute holds?
5. Is the `pWin = 0.35 + 0.25 × confidence` mapping acceptable as a placeholder, or should we use flat priors per strategy until calibrated?
6. Are the fixed per-strategy return/loss assumptions (18%/10%, 12%/7%, 1.5× 5m move / 8%) reasonable starting points? Momentum Breakout projects 1.5× the last 5-minute move — is that too aggressive?
7. Do you approve a paper-only exploration budget (option F)? If so, how many trades/day and what EV margin?
8. What's the right way to measure volume acceleration with 10-second snapshots of DexScreener's rolling 5m volume (non-overlapping 5m windows vs. 1h/12 baseline vs. something else)?
9. Are the round-trip cost estimates reasonable: ~0.85% on standard AMMs, ~2.25% on pump venues, for a $5 order? What should change at larger sizes?
10. What validation thresholds (§7 Phase 3) would you require before considering real money?

---

## Appendix A — Current configuration (relevant values)

| Setting | Value |
|---|---|
| `MIN_EXPECTED_NET_VALUE` | 0.02 (effective 0.03 due to ×1.5) |
| `REALISM_PROFILE` | REALISTIC (failure probability 0.08) |
| Active strategies | momentum-breakout, early-volume-expansion, liquidity-expansion |
| Stop-loss / take-profit / trailing | 8% / 20% / 10% |
| Max position | 5% of equity (≈ $5 on ~$95 equity) |
| Max simultaneous positions | from `MAX_SIMULTANEOUS_POSITIONS` |
| Max hold | 3600 s |
| Strategy liquidity minimums | $3k (base), $5k (MB), $10k (LIQ) |
| Signal universe | 50 most recently discovered tokens |
| Shadow logging threshold | liquidity ≥ $1k |

## Appendix B — Code references

| Topic | File |
|---|---|
| Signal job (universe, hard-coded LOW confidence, EV call) | `apps/server/src/jobs/runners.ts` (`jobSignals`) |
| Execution job | `apps/server/src/jobs/runners.ts` (`jobPaperExecution`) |
| EV formula | `apps/server/src/risk/expected-value.ts` |
| Strategies | `apps/server/src/strategies/catalog.ts`, `momentum-breakout.ts` |
| Universe query | `apps/server/src/services/token-service.ts` (`listActiveTokenIds`) |
| Prior volume (acceleration baseline) | `apps/server/src/services/token-service.ts` (`getPriorVolume5m`) |
| Age | `apps/server/src/services/token-service.ts` (`effectiveAgeMinutes`) |
| Cost estimate | `apps/server/src/execution/realism.ts` (`estimateRoundTripCostPct`) |
| Shadow tracking | `apps/server/src/research/shadow.ts` |
| Risk engine | `apps/server/src/engines/risk/engine.ts` |
| Readiness diagnostics (new) | `apps/server/src/services/readiness-service.ts`, `GET /api/bot/readiness` |

## Appendix C — How the numbers were produced

All figures come from the local Postgres database during the observation window (tables `shadow_trades`, `market_snapshots`, `tokens`, `regime_snapshots`, `signals`, `positions`), plus one direct DexScreener API call to confirm `liquidity: null` for pump.fun pairs. EV ceilings were computed by plugging each strategy's constants into the formula in §4.3 at its maximum possible confidence.
