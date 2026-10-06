# Production paper-trading DB analysis (read-only), 2026-10-04

Source: Railway Postgres, queried over a session forced read-only (`default_transaction_read_only=on`). Only `SELECT` statements were run. Nothing was written back, and no bot parameters, gates, calibration or strategy versions were touched.

**Data window:** 2026-10-04 04:23 → 13:46 UTC (~9.4 h, after the volume wipe).
**Sample:** 161 closed production trades on 63 unique tokens. One token accounts for 22 trades, so trades are not independent samples. Position size averages $1.53 (median $1.14, max $3.30) on a $100 paper balance.

## How the numbers are defined

- **Gross P/L (before all execution costs)**: entry fill × (exit mid ÷ entry mid − 1). The mids are the recorded `requested_price_usd` on the entry and exit orders. For a `PARTIAL` exit, only the filled fraction is realized. A failed emergency sell counts as a total loss.
- **Recorded `positions.gross_pnl_usd` is not "before costs."** The engine sets it to exit notional at mid minus cost basis. Entry DEX fee, entry slippage/impact and entry network fees are already in that figure, so it only excludes exit costs. It sums to −$4.34 and is shown for reference only.
- **Costs** come from the entry and exit `paper_orders` rows. Network includes priority fees. Failed sell attempts are included.
- **Net P/L** = recorded `positions.net_pnl_usd`.
- **Reconciliation:** gross − recorded costs matches recorded net within **$0.10 in total** (mean |residual| $0.005 per trade), so the cost split is consistent with the engine. The residual comes from entry costs compounding with the price move.
- **Confidence intervals** are 95%. Win rates use Wilson intervals; P/L and mean returns use bootstrap intervals (4,000 resamples).
- **Predicted EV** = `expected_net_value` at entry, a fraction of position size net of modelled costs.

---

## 1. Executive summary

- The bot lost **−$12.50 net** on 161 trades (CI −$23.5 to −$2.5).
- **Before execution costs it was flat:** gross **−$0.03** (CI −$11.1 to +$11.5), gross profit factor **1.00**.
- **Execution costs were $12.57**, about equal to the whole net loss. Slippage alone was $8.29 (66%) and DEX fees $3.46 (28%). Round-trip cost averaged **5.1% of position size**, while the EV model assumed 4.2%.
- **Six emergency liquidity-collapse exits** (3.7% of trades, all Early Volume Expansion) lost **−$7.27, which is 58% of the net loss.** Excluding them, gross is **+$6.54** (gross profit factor 1.38; average gross return +4.2%, CI +0.7% to +7.9%) and net is **−$5.23** (CI −$13.7 to +$3.3).
- **Predicted EV carries no information about outcomes:** correlation with gross return r = −0.03 (CI −0.18 to +0.13). Average predicted +4.0% versus realized net −3.7% (gross +1.5%).
- **Momentum Breakout lost money before costs** (gross profit factor 0.83, gross win rate 31%; the gross CI still includes zero) and has the worst net result (profit factor 0.35, net CI −$8.4 to −$1.8).
- **Early Volume Expansion is gross-positive** (profit factor 1.05; 1.63 excluding collapses). Excluding collapses it is net break-even (profit factor 1.02, n = 101).
- **Trades closed within 2 minutes lost −$13.9 (n = 103); trades held 2 minutes or longer made +$1.4 (n = 58).**
- **Rejected signals are hard to judge.** Most forward-price data is thin, and for `priceImpactTooHigh` tokens the price is frozen. The 5 `riskState` rejections were followed by collapses, with a median of −53% at 1 hour.

---

## 2. Gross vs net economics (all closed production trades)

| Metric | All trades |
| --- | ---: |
| Trades | 161 (59 W / 102 L net) |
| Win rate, net | 36.6% (CI 29.6–44.3%) |
| Win rate, gross | 42.9% (CI 35.5–50.6%) |
| Gross P/L (before all costs) | **−$0.03** (CI −$11.15 to +$11.55) |
| DEX fees | $3.46 |
| Network costs (base + priority) | $0.39 |
| Slippage cost | $8.29 |
| Price impact cost | $0.43 |
| **Total costs** | **$12.57** (5.1% of entry notional) |
| **Net P/L** | **−$12.50** (CI −$23.45 to −$2.46) |
| Profit factor, gross | 1.00 |
| Profit factor, net | 0.59 |
| Avg gross win / avg gross loss | +$0.346 / −$0.260 |
| Avg net win / avg net loss | +$0.308 / −$0.301 |
| Avg gross return / avg net return | +1.5% (CI −2.8 to +5.7%) / −3.7% (CI −7.7 to +0.3%) |

**Answer: before execution costs, the strategy set was break-even, neither profitable nor clearly losing.** All of the net loss is accounted for by execution costs. Excluding liquidity collapses, gross turns positive (see section 4).

---

## 3. Strategy comparison

| Strategy | Trades | Win % (net) | Gross P/L | Costs | Net P/L | Gross PF | Net PF | Avg slippage |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Early Volume Expansion | 107 | 43.0% (34–52) | +$0.92 | $7.91 | −$6.96 | 1.05 | 0.69 | 1.68% |
| Momentum Breakout | 48 | 25.0% (15–39) | −$0.87 | $4.44 | −$5.24 | 0.83 | 0.35 | 2.16% |
| Liquidity Expansion ⚠️ n=6 | 6 | 16.7% | −$0.08 | $0.22 | −$0.30 | 0.80 | 0.45 | 1.28% |

| Detail | Early Volume Exp. | Momentum Breakout | Liquidity Exp. (n=6) |
| --- | ---: | ---: | ---: |
| Wins / losses (net) | 46 / 61 | 12 / 36 | 1 / 5 |
| Gross win rate | 47.7% | 31.3% | 50% |
| Gross P/L 95% CI | −$9.3 to +$11.1 | −$4.2 to +$2.7 | — |
| Net P/L 95% CI | −$17.3 to +$3.2 | **−$8.4 to −$1.8** | — |
| Avg gross win / loss | +$0.379 / −$0.329 | +$0.283 / −$0.155 | +$0.111 / −$0.138 |
| Avg net win / loss | +$0.330 / −$0.363 | +$0.231 / −$0.222 | +$0.247 / −$0.110 |
| DEX / network / slippage / impact | $2.32 / $0.26 / $4.95 / $0.37 | $1.10 / $0.12 / $3.16 / $0.06 | $0.04 / $0.01 / $0.17 / $0.00 |
| Cost as % of size | 4.8% | 6.0% | 3.3% |
| Avg position size | $1.54 | $1.54 | $1.12 |
| Avg / median hold | 250 s / 56 s | 191 s / 120 s | 1293 s / 176 s |
| Avg predicted EV | 3.1% | 6.2% | 2.2% |
| Avg gross return | +2.8% (CI −3.1 to +8.6) | −0.9% (CI −5.3 to +3.7) | −1.1% |
| Avg net return | −2.2% (CI −7.9 to +3.4) | **−6.8% (CI −10.8 to −2.5)** | −4.4% |

What the strategy numbers show:

- **Early Volume Expansion:** its signal is gross-positive but small and not statistically distinguishable from zero. Costs plus its 6 liquidity collapses turn it negative.
- **Momentum Breakout:** it loses before costs (31% gross win rate, profit factor 0.83) and is the only strategy whose net loss is statistically clear. Costs make an already weak signal clearly negative, and it carries the highest cost rate (6.0%).
- **Liquidity Expansion:** 6 trades, so no conclusion.

---

## 4. Liquidity-collapse analysis

### By exit reason

| Exit reason | Trades | Win % | Gross P/L | Net P/L | Avg net | Total / avg slippage | Total / avg impact | Avg / median hold |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| take_profit | 53 | 100% | +$23.08 | +$17.87 | +$0.337 | $3.53 / 1.91% | $0.03 / 0.02% | 356 s / 88 s |
| stop_loss | 67 | 0% | −$16.47 | −$21.32 | −$0.318 | $3.33 / 1.76% | $0.06 / 0.03% | 95 s / 48 s |
| trailing_stop | 32 | 15.6% | −$0.28 | −$1.90 | −$0.059 | $0.97 / 1.09% | $0.02 / 0.02% | 203 s / 124 s |
| **emergency_liquidity_collapse** | **6** | **0%** | **−$6.57** | **−$7.27** | **−$1.212** | $0.43 / 6.07% | $0.31 / 5.10% | 197 s / 84 s |
| max_holding_time | 3 | 33% | +$0.21 | +$0.13 | +$0.044 | $0.03 / 0.46% | $0.00 / 0.00% | 3,603 s |

### All trades vs excluding liquidity collapse

| Metric | All trades | Excluding liquidity collapse |
| --- | ---: | ---: |
| Trades | 161 | 155 |
| Win rate (net) | 36.6% | 38.1% (CI 30.8–45.9%) |
| Gross P/L | −$0.03 | **+$6.54** (CI −$2.45 to +$15.94) |
| Net P/L | −$12.50 | −$5.23 (CI −$13.74 to +$3.27) |
| Profit factor (gross / net) | 1.00 / 0.59 | 1.38 / 0.78 |
| Avg trade (net) | −$0.078 | −$0.034 |
| Avg gross return | +1.5% | **+4.2% (CI +0.7% to +7.9%)** |

- **Share of the net result from liquidity collapses: 58.2%** (−$7.27 of −$12.50), from 3.7% of trades. As a share of all losing-trade losses, collapses account for 23.7%.
- **By strategy:** Early Volume Expansion holds all 6 collapses, which are 32.9% of its losses. Excluding them, it is **net +$0.31** (profit factor 1.02, n = 101) and gross +$7.49 (profit factor 1.63). Momentum Breakout and Liquidity Expansion have 0 collapses.
- **The six collapse trades:**
  - 2 were **failed sells** with no liquidity, written off as total losses (−$1.79 and −$1.11).
  - 3 were **partial fills**: the exit filled only up to 12% of the pool's liquidity and the rest was written off. In two of these the mid price was *above* entry (+13% and +10%), yet the trades lost −$1.62 and −$0.81.
  - 1 was a normal fill that lost −$0.16.
- **The losses come from exit liquidity disappearing, not from adverse price moves.**

**Answer: yes.** Collapse exits cause a disproportionate share of losses: 58% of the net loss from under 4% of trades. The sample is only 6 events, so the exact share is uncertain, but it is large in every reading.

---

## 5. Execution-cost analysis

### Distribution

- **Per-trade slippage** (average of entry and exit legs): mean 1.81%, median 1.64%, P75 2.42%, P90 2.87%, P95 3.16%, max 10.9%.
- **Entry vs exit slippage:** entry median 0.70% (P90 2.42%, P95 3.19%, max 4.07%); exit median **2.03%** (P75 3.66%, P90 4.93%, P95 5.04%, max 20.6%). Exits cost about 3 times as much as entries.
- **Price impact:** median 0.02% (P90 0.045%, P95 0.064%, max 9.7%). It only matters in the collapse exits.
- **Total cost as % of position size:** mean 5.2%, median 4.7%, P75 6.7%, P90 8.4%, P95 10.2%, max 20.9%.
- **Total cost per trade:** mean $0.078, median $0.067, P90 $0.143.

### Breakdown

| Group | n | Mean slippage | Median slippage | P90 slippage | Mean impact | Cost % of size |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Early Volume Exp. | 107 | 1.68% | 1.24% | 2.77% | 0.30% | 4.95% |
| Momentum Breakout | 48 | 2.16% | 2.24% | 3.07% | 0.04% | 5.99% |
| Liquidity Exp. | 6 | 1.28% | 1.29% | 2.23% | 0.00% | 3.36% |
| Winners | 59 | 1.82% | 1.89% | 2.90% | 0.02% | 6.27% |
| Losers | 102 | 1.81% | 1.52% | 2.82% | 0.32% | 4.59% |
| take_profit | 53 | 1.91% | 1.98% | 2.95% | 0.02% | 6.59% |
| stop_loss | 67 | 1.76% | 1.67% | 2.81% | 0.03% | 4.71% |
| trailing_stop | 32 | 1.09% | 0.82% | 1.83% | 0.02% | 3.46% |
| emergency collapse | 6 | 6.07% | 6.73% | 10.90% | 5.10% | 9.13% |

### Position-size buckets

| Bucket | Trades | Gross P/L | Total costs | Net P/L | Avg slippage | Avg impact | Cost % of size | Win % |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| < $2 | 120 | +$0.58 | $8.22 | −$7.58 | 1.89% | 0.27% | 5.4% | 40.0% |
| $2–5 | 41 | −$0.61 | $4.36 | −$4.92 | 1.57% | 0.03% | 4.7% | 26.8% |
| $5–10 / $10–25 / ≥ $25 | 0 | — | — | — | — | — | — | — |

- **Are small positions being destroyed by friction? Partly.** Fixed network fees are negligible (about $0.0024 per trade). Friction is proportional, mostly percentage slippage plus a DEX fee of 0.6–2%, so a ~5% round trip applies at every size the bot traded.
- **The size question can't be fully answered:** every trade was under $3.30, so there is no comparison with larger positions.
- **Within the data:** the < $2 bucket was gross-positive (+$0.58) and costs made it −$7.58. The $2–5 bucket was gross-negative.

---

## 6. Rejected-signal analysis

**Sample:**
- 95 production risk-gate rejections:
  - `minimumPositionSize` 39;
  - `priceImpactTooHigh` 30;
  - `riskState` 17;
  - `volatilityExtreme` 4;
  - `executionCostTooHigh` 3;
  - `maxOpenPositions` 2.
- The same token is re-rejected every tick, so the analysis uses the **first rejection per token and reason: 38 independent samples**.
- The reference price is the price recorded on the signal at rejection time.
- Forward prices come from recorded checkpoints, opportunity outcomes, market snapshots, signals and orders, taking the closest observation within ±25% of each horizon (at least ±20 s).
- **There is no +12h or +24h data:** the database only covers about 9.4 h.

| Rejection (unique) | Count | +5m Avg | +5m Median | +15m Avg | +1h Avg | +24h Avg |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| minimumPositionSize | 16 (39 events) | +33.2% (n=13) | +3.3% | +25.2% (n=14) | +34.5% (n=12) | no data |
| priceImpactTooHigh ⚠️ | 13 (30) | +118% (n=13) | +32% | +112% | +112% | no data — **prices frozen, unreliable** |
| riskState | 5 (17) | +0.2% | −6.9% | −36.8% | **−45.2%** (median −52.9%) | no data |
| volatilityExtreme | 2 (4) | +2.3% | +2.3% | +182% | +153% | no data (n=2) |
| executionCostTooHigh | 1 (3) | +447% | — | +307% | +307% | no data (n=1) |
| maxOpenPositions | 1 (2) | +39% | — | +61% | no data | no data (n=1) |
| **All rejections** | 38 | +70% (n=35) | **+9.9%** | +65% | +68% (median +8.2%) | no data |
| *Traded entries (baseline)* | 161 | +19.9% | +3.4% | +28.2% | +41.5% (median +6.0%) | *+6h median −33.7%* |

Other horizons for all rejections (medians): +1m +6.5% (n=28), +30m +13.8% (n=36), +3h +6.8% (n=26), +6h +2.3% (n=14).

**Excursions** (within the window, from rejection price):

| Group | MFE median | MAE median | Fell ≥ 50% |
| --- | ---: | ---: | ---: |
| All rejections | +61% | −6.9% | 10 of 37 |
| `minimumPositionSize` | +68% | −9.6% | 5 of 15 |
| `riskState` | +58% | −85% | 4 of 5 |
| Traded entries | +47% | −27% | 56 of 161 |

**Interpreting this carefully:**

- **Averages are dominated by a few tokens that went up several-fold.** Medians are the meaningful figures.
- **`priceImpactTooHigh` cannot be evaluated.** These 13 tokens show only 1–14 distinct prices over 1–6 hours, so the recorded price was essentially not updating. The median estimated cost at rejection was **43% of position size**, and the gate's own estimate says the move could not have been captured. No missed-opportunity conclusion is possible.
- **`minimumPositionSize`** (n = 16): the median forward move was positive (+8.6% at 15 minutes, +25% at 1 hour, n = 12–14). But the **estimated round-trip cost at rejection was a median 10.7%** (traded entries: 3.7%), and 5 of 15 tokens fell 50% or more within the window. Whether these were profitable after realistic costs can't be determined from the data. Small sample.
- **`riskState`** (n = 5): every token was down at 15 minutes and 1 hour, and 4 of 5 collapsed 50% or more. In this tiny sample the gate filtered tokens that went on to collapse.
- **`volatilityExtreme`, `executionCostTooHigh`, `maxOpenPositions`** (n = 1–2 each): no conclusions.
- **Overall:** rejected tokens' median forward moves (+8–14% over 15–30 minutes) are similar to the price path after actual entries (+6–7%), and the bot nets negative on those entries. So **a positive forward price move does not imply a missed profitable trade.**

---

## 7. Rejected-signal quality vs traded entries (medians, with P25–P75 in brackets)

| Feature | Traded (n=161) | minimumPositionSize (16) | priceImpactTooHigh (13) | riskState (5) |
| --- | ---: | ---: | ---: | ---: |
| Signal score | 89 [77–95] | 86 [77–95] | 88 [85–95] | 95 [88–95] |
| Predicted EV | 3.2% [2.5–4.6] | 2.7% [2.2–3.5] | 2.8% [2.5–4.6] | 3.1% |
| Est. execution cost rate | 3.7% [2.9–4.5] | **10.7%** [8.4–12.5] | **43%** [31–125] | n/a |
| Liquidity | $18.5k [9.5–30k] | $21.0k | $30.5k | $24.7k |
| 5m volume | $32k [6k–147k] | $39k | **$222k** | $110k |
| Volume acceleration | 3.6× | 3.3× | 3.2× | 3.9× |
| 5m price change | +3.8% | +3.7% | +1.6% | −1.4% |
| Buy/sell volume ratio | 1.34 | 1.34 | 1.45 | 1.31 |
| Token age | 26 min | 16 min | **7.8 min** | 21 min |

Strategy mix of the unique rejections: Early Volume Expansion 31, Momentum Breakout 5, Liquidity Expansion 2.

- **Score, EV, acceleration and order flow of rejected signals are statistically indistinguishable from traded ones.** The gates separate on estimated cost (`minimumPositionSize`, `priceImpactTooHigh`) or on portfolio state (`riskState`).
- **The `priceImpactTooHigh` group is internally inconsistent:** high reported liquidity and volume, yet huge impact estimates, very young tokens (about 8 minutes) and frozen prices. This looks like a pool-data quality issue (stale or inconsistent quote reserves) rather than a real opportunity.

**Are the gates rejecting signals that later perform well, or filtering signals that collapse?** The data can't answer either reliably:
- 38 samples;
- frozen prices for a third of them;
- no after-cost forward data;
- no 12–24 h horizon.

The `riskState` rejections (n = 5) were followed by collapses.

---

## 8. Predicted EV calibration

| Scope | n | Avg predicted EV | Avg gross return | Avg net return | Avg error (net − EV) | Median error | Pearson EV↔gross | Pearson EV↔net | Spearman EV↔net |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| All | 161 | 4.0% | +1.5% | −3.7% | **−7.7%** (CI −11.7 to −3.8) | −12.7% | −0.03 (−0.18 to +0.13) | −0.01 (−0.17 to +0.14) | 0.00 (−0.15 to +0.16) |
| Early Volume Exp. | 107 | 3.1% | +2.8% | −2.2% | −5.3% (CI −11.0 to +0.3) | −6.2% | −0.01 | +0.02 | +0.08 (−0.11 to +0.27) |
| Momentum Breakout | 48 | **6.2%** | −0.9% | −6.8% | **−12.9%** (CI −16.9 to −8.6) | −17.7% | +0.05 | +0.14 | +0.25 (−0.04 to +0.50) |
| Liquidity Exp. ⚠️ | 6 | 2.2% | −1.1% | −4.4% | −6.6% | −8.3% | — | — | — |

| Predicted EV bucket | Trades | Win % | Gross P/L | Net P/L | Avg gross return | Avg net return |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| < 0% | 0 | — | — | — | — | — |
| 0–2% | 0 | — | — | — | — | — |
| 2–5% | 128 | 39.1% (31–48) | −$0.25 | −$10.19 | +1.8% | −3.5% (CI −8.4 to +1.3) |
| 5–10% | 29 | 31.0% (17–49) | +$0.60 | −$1.71 | +1.3% | −3.5% (CI −8.8 to +2.2) |
| > 10% | 4 ⚠️ | 0% | −$0.38 | −$0.60 | −6.6% | −10.2% |

**Model inputs vs realized outcomes:**

| Input | Predicted | Realized |
| --- | ---: | ---: |
| Win probability | 55.5% | 42.9% gross / 36.6% net |
| Upside | 22.2% | +24.5% average gross winner |
| Downside | 9.3% | −15.7% average gross loser (−12.0% excluding collapses); stop-loss exits averaged −14.5% gross (median −11.5%) |
| Cost rate | 4.2% | 5.1% |

**Higher predicted EV does not go with better outcomes.** There is no measurable correlation, and the bucket results are flat or inverted. The model is right about the size of winners but overestimates how often trades win, underestimates the size of losers (stops fill well past the modelled downside), and underestimates costs. Momentum Breakout has the highest predicted EV and the worst realized result. All predicted EVs passed the 2% gate, so the EV range is narrow (2–14%), which limits how much correlation the data can show.

---

## 9. Hold-time analysis

| Hold time | Trades | Win % | Gross P/L | Net P/L | Avg slippage | Avg gross return | Avg net return | Exits |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| < 15 s | 6 | 33% | −$1.26 | −$1.69 | 2.20% | −9.0% | −14.3% | 4 SL, 2 TP |
| 15–30 s | 18 | 22% | −$2.20 | −$3.21 | 1.77% | −6.1% | −10.4% | 10 SL, 4 TP, 3 trail, 1 collapse |
| 30–60 s | 41 | 34% | −$2.18 | −$5.47 | 1.99% | +0.0% | −5.2% | 23 SL, 13 TP, 4 trail, 1 collapse |
| 1–2 min | 38 | 32% | −$0.33 | −$3.53 | 2.04% | +0.6% | −5.2% | 16 SL, 11 TP, 8 trail, 3 collapse |
| 2–5 min | 37 | 30% | +$3.62 | +$0.34 | 1.80% | +4.9% | −0.4% | 13 SL, 10 TP, 14 trail |
| 5–10 min | 7 | 100% | +$2.44 | +$1.80 | 1.41% | +22.7% | +16.9% | 7 TP |
| 10–30 min | 7 | 57% | −$1.46 | −$1.77 | 0.93% | −9.3% | −12.5% | 2 TP, 1 SL, 3 trail, 1 collapse |
| > 30 min | 7 | 71% | +$1.35 | +$1.05 | 0.59% | +15.0% | +11.5% | 4 TP, 3 max-hold |

- **Under 2 minutes:** 103 trades, net −$13.91, mostly stop-losses. **2 minutes or longer:** 58 trades, net +$1.41.
- **Most losers fail fast.** The median stop-loss exit came 48 seconds after entry, while winners needed longer.
- **This is descriptive only.** Hold time is an outcome of the exit logic, not something chosen in advance, so it is not evidence that holding longer would help.

---

## 10. Statistical limitations

- **One session:** about 9.4 hours of production data (after the volume wipe), one market regime, one day. No 12h/24h outcomes exist yet.
- **Not independent samples:** 161 trades on 63 tokens; one token has 22 trades and the top 5 tokens have 56. Real uncertainty is wider than the CIs shown.
- **Total P/L CIs include zero** for gross (all trades and excluding collapses), for Early Volume Expansion net, and for Momentum Breakout gross. Only total net (all trades) and Momentum Breakout net are clearly negative.
- **Liquidity Expansion (n = 6)** and the `volatilityExtreme`, `executionCostTooHigh` and `maxOpenPositions` rejections (n = 1–2): **no conclusions drawn.**
- **The collapse share (58%) rests on 6 events.** A single extra collapse would shift it materially.
- **Rejection forward returns:** price data is frozen for `priceImpactTooHigh`, coverage is partial for the others, and returns are mid-price moves, not achievable after-cost returns.
- **EV correlation:** EVs are clustered between 2% and 14% because of the 2% gate, which limits the power to detect a relationship.
- **Paper fills:** costs and partial fills are the simulator's model (constant-product impact, slippage formula, a fill cap at 12% of liquidity), not real on-chain fills.
- **Minor ledger mismatch:** the portfolio's `realized_pnl_usd` is −$11.67, against −$12.50 summed from positions. This analysis uses position-level records.
- **This report is diagnostic only** and must not be used to tune parameters.

---

## 11. Final diagnostic

### QUESTION A — SIGNAL QUALITY

Are the strategies profitable BEFORE execution costs?

**Answer: UNCLEAR.**

- **All trades:** gross −$0.03, profit factor 1.00, CI −$11.1 to +$11.5. That is break-even, not profitable.
- **Excluding the 6 collapse exits:** gross +$6.54, profit factor 1.38, average gross return +4.2% (CI +0.7% to +7.9%). Mildly positive.
- **By strategy:** Early Volume Expansion is gross +$0.92 (+$7.49 excluding collapses, profit factor 1.63). Momentum Breakout is gross −$0.87 (profit factor 0.83, 31% gross win rate), a weak signal even before costs, though its CI includes zero. Liquidity Expansion is too small to judge.

### QUESTION B — EXECUTION

How much of the current net loss is attributable to each cost?

| Component | Amount | Share of net loss (−$12.50) | Share of total costs |
| --- | ---: | ---: | ---: |
| Slippage | $8.29 | 66% | 66% |
| DEX fees | $3.46 | 28% | 28% |
| Price impact | $0.43 | 3% | 3% |
| Network (base + priority) | $0.39 | 3% | 3% |
| **Total execution cost** | **$12.57** | ≈ 100% | 100% |

**Is execution cost large enough to explain most of the negative performance? YES.** Gross P/L was flat (−$0.03), and costs of $12.57 (5.1% round trip, versus 4.2% modelled) account for the entire net loss. Slippage, mainly on exits (median 2.0% vs 0.7% on entries), is the largest component.

### QUESTION C — LIQUIDITY COLLAPSE

Are emergency liquidity-collapse exits responsible for a disproportionate share of losses?

**Answer: YES** (small-sample caveat).

- 6 of 161 trades (3.7%) produced −$7.27, which is **58% of the total net loss**, at an average of −$1.21 per trade (the average losing trade overall is −$0.30).
- All 6 were Early Volume Expansion trades, and they are 33% of that strategy's losses. Without them, the strategy is net +$0.31 (profit factor 1.02).
- The losses came from exits that could not fill: 2 failed sells written off entirely, and 3 partial fills with the remainder written off, two of them when the price was above entry. Adverse price moves were not the cause.

---

## What the bot appears to be struggling with

| Problem | Evidence | Severity | Confidence |
| --- | --- | --- | --- |
| Execution friction erases the edge | Gross −$0.03 vs net −$12.50; costs $12.57 = 5.1% round trip; slippage $8.29 (66%) | High | High (consistent across strategies; reconciles to $0.10) |
| Exit-side slippage | Exit slippage median 2.0% (P90 4.9%) vs entry 0.7%; winners pay 6.3% of size | High | High |
| Liquidity-collapse / unfillable exits | 6 trades = 58% of net loss; failed or partial sells written off, even with price above entry | High | Medium (n = 6) |
| EV model has no predictive power | r = −0.03 EV vs gross return; win probability 55% predicted vs 43% realized; downside 9% predicted vs 12–16% realized; cost 4.2% vs 5.1% | High | Medium–high (n = 161, narrow EV range) |
| Momentum Breakout signal is weak before costs | Gross PF 0.83, gross win 31%, net −$5.24 (CI −$8.4 to −$1.8), highest cost rate 6.0% | Medium–high | Medium (n = 48) |
| Fast stop-outs | 103 trades under 2 min net −$13.9; median stop-loss exit at 48 s; stop exits average −14.5% gross vs 9.3% modelled downside | Medium | Medium (hold time is an outcome) |
| Pool price data looks stale or inconsistent for some young tokens | `priceImpactTooHigh` tokens: 1–14 distinct prices over hours, about 8 min old, 43% estimated cost despite $30k "liquidity" | Medium (data quality) | Medium |
| Rejected-signal value unknown | 38 unique samples, no 12–24 h data, no after-cost forward data; only `riskState` (n = 5) shows clear collapse filtering | Low (unknown) | Low |
| Liquidity Expansion | 6 trades | — | Insufficient data |

*Unrelated observation (no action taken):* the Railway database was 296 MB at query time, just under the 300 MB storage WARNING threshold.
