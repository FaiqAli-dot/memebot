# SOLANA MEMECOIN PAPER-TRADING BOT — REALITY-FIRST FUNNEL FIX

You are working on an existing Solana memecoin paper-trading system.

Your job is to **inspect the existing implementation first, understand it, then implement the fixes below directly in the repository**.

Do NOT rewrite the entire application unnecessarily.

Do NOT make the bot generate trades simply to make the dashboard look active.

The objective is:

> Make the paper-trading system capable of discovering and evaluating real opportunities without accidentally filtering them out because of architectural bugs, while keeping the trading model conservative and honest.

This remains **PAPER ONLY**.

---

# 0. HARD SAFETY BOUNDARY

This project must remain paper-only.

Do NOT implement or enable:

* real wallet signing
* private-key storage
* real transaction submission
* real SOL transfers
* real token purchases
* real token sales
* wallet connection for execution
* automatic live trading

Any existing live-execution code must remain disabled.

If there is already a `TRADING_MODE`, keep:

```env
TRADING_MODE=PAPER
```

and make sure there is no code path that can accidentally execute a real transaction.

---

# 1. FIRST: AUDIT THE EXISTING CODE

Before changing anything:

1. Inspect the repository structure.
2. Find:

   * token discovery
   * market data ingestion
   * token universe management
   * token age calculation
   * strategy evaluation
   * expected-value calculation
   * confidence calculation
   * risk checks
   * paper execution
   * shadow trades
   * persistence/database models
   * configuration/environment variables
   * dashboards/metrics
   * tests
3. Trace the actual runtime flow from:
   `discovery → tracking → market data → strategy → EV → risk → execution`
4. Identify existing code corresponding to the diagnosis below.
5. Do not assume filenames are identical to this specification.
6. Reuse existing architecture where reasonable.

After auditing, implement the changes.

Do not stop after giving me an analysis.

---

# 2. PRIMARY PROBLEM: TOKEN UNIVERSE

Current problem:

The system evaluates only the newest ~50 discovered tokens.

Discovery is roughly ~19 tokens/minute.

Therefore 50 tokens represent only ~2–3 minutes of discovery.

But Momentum Breakout requires tokens to be at least 5 minutes old.

This means tokens often disappear from the evaluation universe before they can even become eligible.

This is an architectural bug.

## REQUIRED FIX

Separate:

### Discovery

Finding new tokens.

### Tracking

Keeping tokens in the system after discovery.

### Evaluation

Actually deciding whether a tracked token currently presents an opportunity.

Do NOT use:

```text
latest 50 discovered tokens
```

as the permanent evaluation universe.

---

# 3. IMPLEMENT TOKEN LIFECYCLE

Create or improve a lifecycle similar to:

```text
DISCOVERED
    ↓
TRACKING
    ↓
ELIGIBLE
    ↓
ACTIVE
    ↓
STALE
    ↓
ARCHIVED
```

Meaning:

### DISCOVERED

Token has just been discovered.

### TRACKING

Token is retained and receiving market-data updates.

### ELIGIBLE

Token satisfies basic data requirements for at least one strategy.

### ACTIVE

Token is currently being evaluated for an actionable opportunity.

### STALE

Market data is too old or token has stopped meeting basic tracking requirements.

### ARCHIVED

Token is no longer worth polling/evaluating.

---

# 4. TOKEN RETENTION

Maintain an active tracking set rather than a fixed newest-N universe.

Initial configuration:

```env
TOKEN_TRACKING_MAX_AGE_HOURS=24
TOKEN_EVALUATION_CAP_PER_TICK=200
TOKEN_TRACKING_CAP=5000
```

These should be configurable.

The system should:

* keep recently discovered tokens
* keep tokens until they become stale
* allow tokens older than 5 minutes to remain available for Momentum Breakout
* rank which tokens receive evaluation priority
* avoid evaluating thousands of tokens every cycle if unnecessary

Priority should consider things such as:

* liquidity
* recent volume
* volume acceleration
* price movement
* transaction activity
* freshness of market data
* strategy eligibility
* recent activity

Do NOT simply prioritize by discovery time.

---

# 5. EVALUATION BUDGET

Keep an evaluation cap such as:

```env
TOKEN_EVALUATION_CAP_PER_TICK=200
```

But make it a **compute/API budget**, not a universe limit.

Example:

```text
5000 tracked tokens
        ↓
rank by activity/eligibility
        ↓
top 200 evaluated this tick
        ↓
different candidates can rotate into evaluation
```

Do not permanently starve older tokens.

Implement fair rotation where practical.

---

# 6. TOKEN AGE

Current problem:

Momentum Breakout requires:

```text
age >= 5 minutes
```

but tokens are disappearing from the universe before reaching that age.

Fix this.

## AGE SOURCE PRIORITY

Use the actual pool creation timestamp whenever available.

Prefer:

```text
poolCreatedAt
```

or equivalent authoritative timestamp.

If unavailable:

```text
firstObservedAt
```

may be used as a fallback.

However:

**firstObservedAt is only a fallback for age calculation.**

It must NOT cause the token to disappear from tracking.

Persist both if possible:

```text
poolCreatedAt
firstObservedAt
ageSource
```

This will make diagnostics much easier.

---

# 7. PUMP.FUN HANDLING

The diagnosis found that approximately 91% of newly discovered tokens may report zero liquidity because they are Pump.fun bonding-curve tokens whose liquidity is not represented normally by DexScreener.

Do NOT simply throw these tokens away from the entire research system.

Implement two concepts:

```text
TRADING_ELIGIBLE
RESEARCH_ONLY
```

For now:

### Pump.fun bonding-curve / pre-migration tokens

Keep collecting their data.

But exclude them from the production paper-trading strategy universe until we have a proper bonding-curve model.

Example:

```text
Pump.fun pre-migration
        ↓
RESEARCH_ONLY
        ↓
collect:
- price
- volume
- buys
- sells
- transactions
- age
- migration status
- bonding curve information if available
```

Do NOT pretend their reported `$0 liquidity` means the token has literally zero economic liquidity.

Do NOT use fake liquidity values.

Do NOT invent execution assumptions.

Add explicit metadata:

```text
liquidityStatus:
  - KNOWN
  - UNKNOWN
  - BONDING_CURVE
```

Only `KNOWN` liquidity should currently pass the production trading liquidity checks.

This allows us to later build a separate Pump.fun strategy without corrupting the current model.

---

# 8. VOLUME ACCELERATION IS CURRENTLY WRONG

Current implementation compares overlapping rolling 5-minute windows that are only ~30–40 seconds apart.

That means:

```text
current 5m
vs
previous 5m
```

is mostly comparing almost the same trades.

This produces:

* ratios around 1.0
* unstable spikes
* huge ratios when the older window was near zero
* poor signal quality

Fix this.

---

# 9. IMPLEMENT BETTER VOLUME ACCELERATION

Use independent/non-overlapping historical windows where possible.

For example:

```text
current 5m volume
vs
previous completed 5m volume
```

or equivalent independent buckets.

Also collect shorter flow metrics such as:

```text
30s volume
1m volume
5m volume
15m volume
```

and:

```text
buy count
sell count
unique buyers
unique sellers
transaction count
```

where the data provider supports them.

The exact implementation should fit the existing data model.

---

# 10. HANDLE LOW BASELINES SAFELY

Never allow:

```text
previousVolume ≈ 0
```

to create:

```text
acceleration = 4000x
```

and make that appear meaningful.

Use a minimum baseline.

Example:

```env
VOLUME_ACCEL_MIN_BASELINE_USD=500
VOLUME_ACCEL_MAX=10
```

If the baseline is below the minimum:

* mark acceleration as low-confidence/insufficient-data
* do not treat the huge ratio as a valid signal

Cap acceleration at a reasonable configurable maximum.

Example:

```text
min(rawAcceleration, 10)
```

Do not silently hide the raw value. Store both:

```text
rawVolumeAcceleration
cappedVolumeAcceleration
volumeAccelerationConfidence
```

---

# 11. ADD FLOW ACCELERATION

Where data is available, calculate additional signals:

```text
buyAcceleration
sellAcceleration
transactionAcceleration
uniqueBuyerAcceleration
```

Do not blindly combine everything into one magic score.

Keep the individual metrics available to strategies and diagnostics.

---

# 12. FIX SHADOW TRADES

Current shadow trading is creating duplicate opportunities every ~12 seconds.

This is invalid.

Example:

```text
same token
same strategy
same opportunity
217 open shadow positions
```

must not happen.

Implement idempotent shadow trade creation.

Use a logical opportunity identity such as:

```text
tokenAddress
strategy
opportunityStartTime / opportunityId
```

A token/strategy can create a new shadow opportunity only after the previous opportunity has ended or a meaningful cooldown has passed.

Add configuration:

```env
SHADOW_REENTRY_COOLDOWN_SECONDS=300
```

or an appropriate configurable value.

---

# 13. SHADOW TRADES MUST BE REALISTIC

Shadow trades must simulate the same execution assumptions as paper trades.

Include:

* entry price
* entry slippage
* DEX fee
* network fee
* price impact
* execution latency
* failure probability
* position size
* stop loss
* take profit
* trailing stop if enabled
* maximum hold time
* exit price
* exit costs
* net P&L

Do NOT report gross mid-price movement as trade profitability.

---

# 14. FIX COST REPRESENTATION

The current field appears to contain a fraction such as:

```text
0.0222
```

while the name implies USD.

This is dangerous.

Separate the concepts clearly.

For example:

```text
executionCostRate
executionCostUsd
slippageRate
slippageUsd
dexFeeRate
dexFeeUsd
networkFeeUsd
priceImpactRate
priceImpactUsd
totalCostRate
totalCostUsd
```

Do not overload one field.

---

# 15. USE ACTUAL PROPOSED POSITION SIZE

The EV calculation currently assumes a `$5` position in places even when actual position sizing may differ.

Fix this.

Every simulated trade should calculate costs based on the actual proposed position size.

Example:

```text
positionSizeUsd
```

then:

```text
feeUsd = positionSizeUsd * feeRate
slippageUsd = ...
networkFeeUsd = ...
```

Network fees may be mostly fixed while percentage-based costs scale with size.

Model them appropriately.

---

# 16. EV MODEL — DO NOT CHEAT

This is extremely important.

The current EV model has:

```text
hard-coded LOW data confidence
+
confidence haircut
+
1.5x threshold multiplier
```

This effectively makes the EV gate impossible for some strategies.

Remove the artificial double penalty.

But:

**DO NOT simply lower the EV threshold to 1% just to create trades.**

We do not yet have enough empirical data to claim that a 1% EV threshold is valid.

---

# 17. DATA CONFIDENCE MUST BE MEASURED

Replace hard-coded:

```text
dataConfidence = LOW
```

with a real confidence assessment.

Confidence should consider:

* liquidity availability
* liquidity freshness
* volume availability
* price freshness
* transaction count availability
* buy/sell data availability
* token age quality
* market-data completeness
* number of observations
* provider agreement if multiple providers are available

Example conceptual states:

```text
LOW
MEDIUM
HIGH
```

Do not assign MEDIUM simply because the bot wants to trade.

Make it evidence-based.

---

# 18. PROVISIONAL EV CONFIGURATION

Keep the EV gate conservative while we collect data.

Use configurable settings.

Do NOT hard-code a magical "correct" threshold.

Initial configuration can remain around:

```env
MIN_EXPECTED_NET_VALUE=0.02
LOW_CONFIDENCE_EV_MULTIPLIER=1.2
```

meaning:

```text
MEDIUM/HIGH:
2.0%

LOW:
2.4%
```

But this is explicitly a **provisional research configuration**, not a calibrated probability model.

Do not claim that the EV number represents a statistically proven expected return.

---

# 19. REMOVE HARDCODED BUY/SELL CONFIDENCE

If the current implementation contains something like:

```text
buySellConfidence = LOW
```

remove that hard-coded classification.

Calculate it from actual observed data.

Possible inputs:

* buy/sell ratio
* transaction count
* unique buyers
* unique sellers
* consistency across time windows
* freshness

If insufficient data exists:

```text
confidence = LOW
```

is valid.

But it must be because the data is actually insufficient.

---

# 20. DO NOT FORCE PRODUCTION TRADES

Do NOT:

```text
lower thresholds until trades appear
```

Do NOT:

```text
generate fake trades
```

Do NOT:

```text
remove safety checks
```

Do NOT:

```text
ignore liquidity
```

Do NOT:

```text
invent liquidity for Pump.fun tokens
```

The goal is a correct funnel.

---

# 21. ADD A SEPARATE RESEARCH PAPER PORTFOLIO

Instead of arbitrary forced production trades, create a separate research layer.

We need two conceptual portfolios:

## PRODUCTION PAPER

Only takes trades that satisfy the normal production strategy + EV + risk gates.

These statistics determine whether the actual strategy has an edge.

## RESEARCH PAPER

Can record borderline opportunities to collect evidence.

Research trades MUST be clearly marked:

```text
portfolioType = RESEARCH
```

and must never contaminate production performance metrics.

Optional configuration:

```env
RESEARCH_EXPLORATION_ENABLED=true
RESEARCH_MAX_TRADES_PER_DAY=5
RESEARCH_MAX_EV_SHORTFALL=0.015
```

But do not force five trades per day.

The limit is a maximum, not a quota.

A research trade should still require:

* basic safety checks
* known liquidity
* valid market data
* minimum position size
* valid strategy setup
* reasonable execution conditions

The research trade may relax only the final EV gate within the configured margin.

---

# 22. OPPORTUNITY RECORDER

This is one of the most important additions.

Whenever a token becomes a meaningful candidate, record an immutable opportunity snapshot.

For every opportunity record:

```text
token
strategy
timestamp
price
liquidity
volume
buys
sells
transactions
uniqueBuyers
uniqueSellers
marketRegime
tokenAge
dataConfidence
expectedValue
executionCost
```

Then observe what happened afterward.

---

# 23. OUTCOME HORIZONS

For each opportunity, record forward outcomes approximately at:

```text
10 seconds
30 seconds
1 minute
3 minutes
5 minutes
10 minutes
20 minutes
30 minutes
```

Record:

```text
price
return
liquidity
volume
MFE
MAE
timeToMFE
timeToMAE
```

Also simulate the actual configured:

```text
SL
TP
trailing stop
maximum hold
```

with correct event ordering.

This allows us to eventually answer:

> When this signal appears, what actually happens afterward?

rather than guessing.

---

# 24. OPPORTUNITY DECAY

Do not assume the optimal entry point is exactly 5 minutes.

Measure how opportunities evolve after discovery.

For each strategy, determine empirically:

```text
discovery
→ 10s
→ 30s
→ 1m
→ 3m
→ 5m
→ 10m
→ 20m
```

We want to learn:

* when momentum is strongest
* when volume acceleration appears
* when liquidity becomes usable
* how quickly expected edge decays
* whether entering later improves execution quality
* whether entering earlier produces too many false positives

Do not hard-code conclusions yet.

Collect the evidence.

---

# 25. EMPIRICAL CALIBRATION

The current EV model uses arbitrary constants such as:

```text
pWin
expectedReturn
expectedLoss
```

These are not sufficiently calibrated yet.

Do NOT pretend they are accurate.

Build the data pipeline required to eventually calibrate them from closed paper/research trades.

Eventually estimate:

```text
P(win | strategy, regime, confidence, liquidity, flow)
```

and empirical:

```text
return distribution
loss distribution
MFE
MAE
```

Use enough data before fitting a serious model.

Do not treat exactly 100 trades as mathematically sufficient.

Use staged milestones such as:

```text
0–100:
observation / debugging

100–300:
descriptive statistics

300–1000:
initial calibration

1000+:
more serious model fitting
```

These are research milestones, not guaranteed statistical thresholds.

---

# 26. BACKTEST / REPLAY SUPPORT

Make the architecture compatible with replay.

We need to eventually be able to feed historical market observations into:

```text
discovery
→ tracking
→ strategy
→ EV
→ risk
→ paper execution
```

without allowing future data to leak into earlier decisions.

No look-ahead bias.

Do not implement a fake backtester that uses future candles to decide entries.

---

# 27. WALK-FORWARD EVALUATION

Eventually support:

```text
TRAIN / CALIBRATION WINDOW
        ↓
FORWARD TEST WINDOW
        ↓
ROLL WINDOW
```

The system must distinguish:

```text
historical calibration
```

from:

```text
unseen evaluation
```

Do not optimize against the same data used to evaluate the strategy.

---

# 28. STRATEGY-SPECIFIC CHANGES

## Momentum Breakout

Current conditions include things like:

```text
age >= 5m
price change >= 1.5%
volume >= 1.5k
acceleration >= 1.3x
buy/sell >= 1.1
transactions >= 15
score >= 55
```

Do NOT remove all of these.

First make sure the token universe actually allows tokens to reach the required age.

Then measure which conditions are genuinely predictive.

Keep each rejection reason visible.

---

## Early Volume Expansion

Do not immediately loosen:

```text
volume acceleration
```

Instead fix the acceleration measurement first.

Then evaluate the actual distribution.

---

## Liquidity Expansion

Do not lower liquidity requirements simply because there are no trades.

The current low EV may actually indicate that this strategy is not viable under current assumptions.

Let the data determine that.

---

# 29. SAFETY PIPELINE

The order should remain approximately:

```text
DISCOVERY
↓
TRACKING
↓
MARKET DATA
↓
BASIC DATA QUALITY
↓
TOKEN SAFETY
↓
STRATEGY
↓
DATA CONFIDENCE
↓
EXPECTED VALUE
↓
RISK
↓
PAPER EXECUTION
```

Do not bypass safety because a token has a strong price move.

---

# 30. DIAGNOSTIC FUNNEL

The dashboard/logging MUST make it obvious why there are no trades.

Track:

```text
discovered
tracked
freshMarketData
knownLiquidity
researchOnly
safetyPassed
strategyEligible
EVPassed
riskPassed
executionAttempted
executed
```

And rejection counts:

```text
tooOld
tooYoung
staleData
unknownLiquidity
lowLiquidity
safetyFailed
strategyFailed
volumeFailed
priceFailed
transactionCountFailed
EVFailed
riskFailed
executionFailed
```

Also show:

```text
best candidate
best EV
best strategy
closest EV miss
number of candidates within 0.5%
number within 1%
number within 2%
```

This is critical.

If there are zero trades, the dashboard should answer:

> WHY?

without requiring source-code inspection.

---

# 31. CONFIGURATION CLEANUP

Make the important thresholds configurable.

At minimum:

```env
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

Use the project's existing configuration system if one exists.

Do not duplicate configuration systems.

---

# 32. DATABASE / SCHEMA

Inspect the existing schema first.

Add migrations/models for whatever is needed to support:

```text
token lifecycle
pool creation timestamp
first observed timestamp
liquidity status
opportunity records
opportunity outcomes
shadow trade lifecycle
portfolio type
execution cost breakdown
data confidence
raw vs capped acceleration
```

Do not destroy existing data.

Use migrations.

---

# 33. TESTS

Add or update automated tests for at least:

### Universe

* token remains tracked beyond newest-50 window
* token reaches 5m age
* stale token is eventually archived
* evaluation cap works
* fair rotation works

### Age

* pool creation timestamp preferred
* first-observed fallback works
* age does not cause premature removal

### Pump.fun

* bonding curve identified correctly
* research-only classification works
* no fake liquidity

### Volume

* non-overlapping windows
* low baseline handled safely
* acceleration capped
* raw acceleration preserved

### Shadow trades

* same opportunity cannot create duplicates
* cooldown works
* exit lifecycle works
* SL/TP ordering is deterministic
* costs are included

### EV

* confidence affects EV correctly
* LOW confidence has only the intended multiplier
* no double penalty
* actual position size affects costs
* EV calculation is deterministic

### Research portfolio

* research trades cannot contaminate production statistics
* daily research cap works
* research trade does not bypass safety

### Paper execution

* no real transaction code can execute
* failure simulation works
* latency/slippage/costs are applied

---

# 34. DO NOT OPTIMIZE FOR "NUMBER OF TRADES"

The success criteria for this task are NOT:

```text
make 10 trades
```

or:

```text
make the dashboard active
```

The success criteria are:

1. Opportunities are not accidentally discarded.
2. Tokens can survive long enough to become eligible.
3. Market metrics are calculated correctly.
4. Shadow trades are not duplicated.
5. Costs are realistic.
6. EV is not artificially impossible.
7. Research and production statistics are separated.
8. The system explains why candidates are rejected.
9. No real money can be traded.
10. The resulting data can later be used to determine whether the strategy actually has an edge.

---

# 35. AFTER IMPLEMENTATION

Run:

```text
typecheck
lint
unit tests
integration tests
build
```

and any project-specific validation commands.

Fix all errors introduced by your changes.

Then run the paper system long enough to inspect actual behavior.

Do not claim that the strategy is profitable merely because trades start appearing.

---

# 36. FINAL REPORT

When finished, provide me with:

## A. Files changed

List the important files and what changed.

## B. Architecture changes

Explain the new:

```text
discovery → tracking → evaluation → strategy → EV → execution
```

flow.

## C. Configuration changes

List all new environment variables.

## D. Tests

Tell me what passed.

## E. Trade funnel

Show:

```text
discovered
→ tracked
→ eligible
→ strategy
→ EV
→ risk
→ executed
```

using actual observed numbers if the system was run.

## F. Remaining limitations

Be explicit about anything that is still approximate.

## G. Next recommended development stage

Do NOT recommend live trading yet.

The next stage should be additional paper/research data collection, replay/backtesting, and empirical calibration.

---

# MOST IMPORTANT PRINCIPLE

Do not fix zero trades by making the bot more permissive.

Fix zero trades by making the **information pipeline correct**.

We want:

```text
REAL MARKET DATA
      ↓
CORRECT TOKEN LIFECYCLE
      ↓
CORRECT MARKET METRICS
      ↓
REAL STRATEGY CONDITIONS
      ↓
MEASURED CONFIDENCE
      ↓
CONSERVATIVE EV
      ↓
REALISTIC PAPER EXECUTION
      ↓
EMPIRICAL OUTCOMES
      ↓
CALIBRATION
      ↓
BACKTEST / WALK-FORWARD
      ↓
ONLY MUCH LATER: LIVE
```

The bot should earn the right to trade by producing evidence.

Do not manufacture evidence by loosening gates.
