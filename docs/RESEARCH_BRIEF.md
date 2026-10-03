# MemeBot: Research Brief

> **Purpose of this document.** This is a complete, honest description of MemeBot as it exists today, written so that an AI research assistant (or a human reviewer) can propose improvements **before any real money is put behind it**. It covers what the bot does, exactly how each decision is made, the current numbers it runs on, what has been observed in testing, and every known weakness. Section 12 lists the specific questions we want researched.
>
> **Status as of 3 Oct 2026:** paper trading only. There is **no wallet, no private key handling and no real swap execution anywhere in the code.** Going live would require building an execution layer from scratch (see section 11).

---

## 1. What the bot is

MemeBot is a **Solana memecoin paper-trading and research platform**. It:

1. Discovers new Solana tokens.
2. Polls their market data (price, volume, liquidity, buy/sell activity).
3. Scores each token with a rule-based momentum strategy.
4. "Buys" tokens that pass all filters, using virtual money, with simulated fees, slippage and price impact.
5. Manages open positions with stop-loss, take-profit, trailing-stop, max-holding-time and emergency exits.
6. Tracks a portfolio (cash, equity, drawdown, P&L, all costs).
7. Once a day, reviews its own trades and nudges its filter and exit settings within strict limits (a "learning" loop).

It starts with **$100 of virtual cash**. There is a single portfolio and no user accounts.

---

## 2. Architecture

```
Frontend (React + TypeScript + Vite, Recharts)
        |  REST + WebSocket (/ws)
API server (Express, Node 20+)  <---- LISTEN memebot_events ----+
        |                                                       |
PostgreSQL 16 (all state)                                       |
        ^                                                       |
Background worker (separate Node process)  ---- pg_notify ------+
  jobs on fixed intervals:
    token_discovery       every 15s
    market_data           every 10s
    onchain (holders)     every 30s
    signal                every 12s
    paper_execution       every 8s   (also manages open positions/exits)
    portfolio_valuation   every 10s
    analytics             every 30s
    daily_report          checks every 60s, runs once per day at 23:55 Asia/Dubai
```

- **Monorepo:** `apps/server` (API + worker), `apps/web` (UI), `packages/shared` (types, schemas, constants).
- **Realtime:** the worker publishes events through Postgres `NOTIFY`. The API server `LISTEN`s and forwards them to browsers over WebSocket. Event types: `bot_status`, `token_discovered`, `signal_generated`, `trade_opened`, `trade_closed`, `portfolio_updated`, `bot_event`, `scanner_updated`, `position_updated`, `report_generated`.
- **Provider pattern:** all external data goes through interfaces in `apps/server/src/providers/` (`TokenDiscoveryProvider`, `MarketDataProvider`, `OnChainDataProvider`, `GasFeeProvider`, `SolPriceProvider`). Each has a demo implementation and a live implementation, so new data sources can be added without touching the engines.
- **Scheduler:** simple `setInterval` per job. A job tick is skipped if the previous run of the same job is still running. There is no distributed locking and the system assumes exactly one worker process.

### UI tabs

Dashboard, Scanner, **Live** (per-position real-time price charts with entry, stop-loss, take-profit and trailing-stop lines), Positions, Trades, Strategies, Analytics, **Reports** (daily learning reports), Settings, Token detail.

---

## 3. Data modes

| Mode | Discovery | Prices | Holders | SOL/USD |
|---|---|---|---|---|
| `demo` (default) | Fixed list of 10 fake tokens (PEPE2, WIFX, BONK2, MOON, FROG, CHAD, RUG?, DEGEN, CATS, PUMP) unlocked gradually | Deterministic synthetic sine-wave/pseudo-random series | Synthetic | Fixed $150 |
| `live` | DexScreener `token-boosts/latest/v1` | DexScreener `tokens/v1/solana/{addresses}` | GeckoTerminal token info (best effort) | DexScreener WSOL pairs, CoinGecko fallback, 30s cache |

Demo and live rows are stored with a `data_mode` column and never mixed.

**No API keys are required for either mode.** All live sources are public endpoints. (`BIRDEYE_API_KEY` exists in config but nothing uses it yet.)

**Important caveat:** demo prices are synthetic. Any result, win rate or "lesson" produced in demo mode describes the demo generator, not real markets.

---

## 4. Token discovery (live mode)

Every 15 seconds:

1. Fetch DexScreener's **latest token boosts** list.
2. Keep entries where `chainId === 'solana'` and the address is a valid Solana address.
3. Take the **first 15**, and upsert them into `tokens` with `createdAt: null`.

Market data and signals are then computed only for the **50 most recently discovered tokens**.

### Known weaknesses of discovery

- **Boosted tokens are paid promotions.** This list is biased toward marketed tokens and misses organic launches (Pump.fun launches, new Raydium/Orca/Meteora pools) unless someone pays to boost them.
- **Real token age is not captured.** `createdAt` is always null in live mode, so the age filters (`minTokenAgeMinutes`, `maxTokenAgeMinutes`) actually measure "time since the bot first saw the token". DexScreener returns `pairCreatedAt`, but it is ignored.
- **The 50-token tracking window** can drop slow-building tokens before they move.
- **No safety screening at discovery:** no checks for mint authority, freeze authority, LP lock/burn status, honeypot (unsellable) behavior, developer wallet holdings, bundled/sniped launches, or social presence.

---

## 5. Market data

Every 10 seconds, for up to 50 tokens, the bot fetches DexScreener pairs and keeps the **highest-liquidity pair per token**. Each snapshot stores:

`price_usd, market_cap_usd, volume_5m/1h/24h_usd, buy_volume_5m_usd, sell_volume_5m_usd, tx_count_5m, price_change_5m_pct, price_change_1h_pct, liquidity_usd, observed_at, stale`

Details and approximations:

- **Buy/sell volume is estimated, not observed.** DexScreener gives buy and sell **transaction counts**, not USD volume per side. The bot computes `buyShare = buys / (buys + sells)` and splits 5-minute volume by that share. A few large sells among many small buys would look like strong buy pressure.
- **Pool reserves are estimated.** `quoteReserve = liquidityUsd / 2 / priceUsd`, `baseReserve = null`.
- **DEX fee is not fetched per pool.** It falls back to venue defaults (section 8).
- **Staleness:** a quote older than `STALE_PRICE_MAX_AGE_MS` (60s) is marked stale. No new trades are opened on stale data, and non-emergency exits are postponed.
- **Polling, not streaming:** the bot sees each token roughly every 10 seconds. Memecoins can move 20 to 50% in that time.

---

## 6. Strategy: Momentum Scanner v1

File: `apps/server/src/engines/strategy/momentum-v1.ts`. Rule-based, no machine learning.

### 6.1 Scores (0 to 100 each)

| Score | Formula |
|---|---|
| Momentum | `40 + priceChange5m * 3 + min(20, max(0, accel - 1) * 20)`, where `accel = volume5m / priorVolume5m` (or `volume5m * 12 / volume1h` if no prior snapshot) |
| Liquidity | `log10(liquidityUsd) / log10(1,000,000) * 100` |
| Volume | `log10(volume5m) / log10(100,000) * 100` |
| Holder distribution | `100 - topHolderPct * 1.8` (50 if unknown) |
| Risk (higher = riskier) | starts at 20; +25 if liquidity < $5k; +25 more if < $1.5k; +20 if top holder > 25%; +20 more if > 40%; +15 if abs(5m change) > 20%; +10 if age < 10 min |
| **Overall** | `0.30*momentum + 0.20*liquidity + 0.20*volume + 0.15*holder + 0.15*(100 - risk) + buyPressureBonus`, where `buyPressureBonus = clamp((buySellRatio - 1) * 25, -10, 20)` |

Risk labels: `EXTREME` (liquidity < $1k, top holder > 50%, or risk >= 80), `HIGH`, `MODERATE`, `LOWER_RISK`.

### 6.2 Entry filters (all must pass)

| Filter | Default |
|---|---|
| `minLiquidityUsd` | $5,000 |
| `minVolume5mUsd` | $1,500 |
| `minVolumeAcceleration` | 1.3x |
| `minPriceChange5mPct` | +1.5% |
| `minBuySellRatio` | 1.1 |
| `minActivityTx5m` | 15 transactions |
| `minTokenAgeMinutes` / `maxTokenAgeMinutes` | 5 min / 24 h |
| `maxTopHolderPct` | 40% |
| `minOverallScore` | 55 |
| Risk label | not `EXTREME` |

Passing tokens produce a `BUY` signal. The full entry context (all market fields) is stored in `signals.market_state` for later analysis. **There are no strategy-generated SELL signals.** Exits are purely rule-based (section 7).

### 6.3 Execution of signals

Every 8 seconds the worker takes up to 5 BUY signals from the last 10 minutes that have no order yet and whose token has no open position, sorted by overall score. For each one it re-checks data freshness and liquidity, runs the risk engine, and simulates the buy.

---

## 7. Risk management and exits

### 7.1 Risk engine (checked before every buy)

In order:

1. **Max drawdown:** if `(peakEquity - equity) / peakEquity >= maxDrawdownPct` (15%), block all new buys.
2. **Max daily loss:** if today's realized losses / starting balance `>= maxDailyLossPct` (5%), block for the rest of the day.
3. **Max simultaneous positions** (default 5).
4. **Position sizing:** `size = min(equity * maxPositionPct (5%), equity * maxRiskPerTradePct (1%) / stopLossPct, cash * 0.99)`. With $100 equity and an 8% stop, that is **$5 per trade**.
5. Trades below $1 are rejected.

### 7.2 Exit rules (checked every 8 seconds per open position)

Evaluated in this order, the first match wins:

| Rule | Trigger (default) |
|---|---|
| Emergency liquidity collapse | liquidity <= 0, or < 10% of `minLiquidityUsd` (fires even on stale data) |
| Stop-loss | price <= entry * (1 - 8%) |
| Take-profit | price >= entry * (1 + 20%) |
| Trailing stop | price has fallen 10% from the highest price seen since entry (only once the position has been above entry) |
| Max holding time | 3600 seconds |

The exit is always simulated at the **current market price**, never at the theoretical stop/take-profit level, so price gaps are modelled honestly. All-or-nothing exits only: there are no partial take-profits or scaling out.

---

## 8. Cost, slippage and execution simulation

File: `apps/server/src/engines/cost/simulator.ts`.

| Component | Model |
|---|---|
| DEX fee | Pool `feeBps` if known, else venue default: Raydium 25 bps, Orca 30, Pump-like 100, unknown 30 |
| Network fee | 5,000 lamports x live SOL/USD |
| Priority fee | Median of Solana RPC `getRecentPrioritizationFees` (or 5,000 lamports default) x SOL/USD |
| Price impact | Constant product: `amount / (quoteReserve + amount)` |
| Slippage | `priceImpact + clamp(abs(5m change) * 0.15, 0, 5) + 0.25 * clamp(size/liquidity * 8, 0.05, 15)`, clamped to 0.05 to 50% |
| Partial fills | If size > 15% of liquidity, fill only up to 12% of liquidity |
| Failed transactions | Configurable: failed trades can still be charged network + priority fees |
| SOL/USD safety | If SOL/USD is missing or stale (> 120s), new trades are blocked. Nothing is invented |

Not modelled: Jito tips or bundles, MEV/sandwich attacks, transaction landing failures under congestion, the time between signal and execution, the Jupiter routing path, Pump.fun bonding-curve pricing, token transfer taxes, and minimum rent for token accounts.

---

## 9. Daily learning loop

Files: `apps/server/src/engines/learning/*`, `apps/server/src/services/report-service.ts`.

Once a day (default 23:55 Asia/Dubai; if the worker is down then, it catches up on restart):

1. **Important trades:** the top 3 wins, top 3 losses, 2 fastest stop-outs, and 2 trades where costs turned a gross gain into a net loss. At most 10.
2. **Analysis over a rolling 7-day window:** for each entry filter, compare trades just inside the current limit (within one 10% step) against the rest, by win rate. Also exit stats: stop-loss share, median hold time of stop-outs versus winners, and losers that were up at least half the take-profit target before reversing.
3. **Lessons, with guardrails:**
   - At least 20 closed trades in the window.
   - At least 8 trades on each side of a limit, and a win-rate gap of at least 15 percentage points.
   - At most 10% change per setting per day, and at most 3 settings per day.
   - Hard minimum and maximum per setting (for example, stop-loss stays between 3% and 25%).
   - No reversing a setting within 3 days.
   - Exit rules: widen the stop-loss if more than 50% of trades stop out at less than half the winners' median hold time. Tighten the trailing stop (or lower take-profit) if more than 30% of losers were well in profit first.
4. **Self-review:** compare trades since the last applied changes with the 7 days before. If results are worse (win rate down 5+ points and average P&L lower) two reports in a row, revert those changes and make no new ones that day.
5. Everything is stored in `daily_reports` and can be rolled back from the UI.

**Limitations of the learning loop:**

- It only learns from **trades that were actually taken**. It cannot see tokens it filtered out, so it can tighten a filter with evidence but can only loosen one weakly.
- Win rate is the main metric. It does not optimize expectancy, profit factor or risk-adjusted return directly.
- It treats each feature independently, with no interactions and no multivariate model.
- Small samples and regime changes in memecoin markets make overfitting likely.
- No out-of-sample validation or walk-forward testing.

---

## 10. Observed behavior in testing (demo data, 3 Oct 2026)

These numbers come from synthetic demo prices and **say nothing about real profitability**. They are included only to show how the machinery behaves.

- One day, 224 closed trades: **36.6% win rate**, gross P&L +$2.98, **costs $30.38**, net P&L +$2.64 on a $100 account.
- Exits: 126 stop-loss, 71 take-profit, 27 trailing stop. Median stop-out after about 24 seconds; median winner held about 56 seconds.
- The learning loop widened the stop-loss from 8% to 8.8% and raised minimum volume acceleration from 1.3 to 1.43.
- The portfolio later fell 17.5% from a peak of $115.63 and hit the max drawdown block (section 13).

The takeaway: with $5 positions, **costs are roughly 10 times the net profit**. Fee drag at small size is a central problem.

---

## 11. What is missing before real money

1. **No real execution layer.** Needed: wallet key management (ideally a dedicated hot wallet with limited funds, keys outside the repo), swap routing (Jupiter API or direct Raydium/Pump.fun programs), transaction building, priority fees and Jito tips, confirmation tracking, retries, handling of partial or failed transactions, and reconciling on-chain balances with the internal portfolio.
2. **No backtesting or historical replay.** Strategy changes can only be judged forward in paper mode. There is no historical data pipeline.
3. **No token safety layer** (section 4).
4. **No real-time data.** 10-second polling of DexScreener. No WebSocket or gRPC price feed, no on-chain swap stream.
5. **No sell simulation before buying** (honeypot detection), and no simulated round trip.
6. **No auth, multi-portfolio or audit separation** for a production deployment. The API is open with no login.
7. **Operational gaps:** no alerting (Telegram/Discord), no kill switch beyond pausing, no health monitoring of data providers, no handling of DexScreener rate limits beyond retries, a single worker with no failover.
8. **Legal, tax and record-keeping** considerations for automated trading in the operator's jurisdiction (UAE) are not addressed.

---

## 12. Research questions (please answer these)

### A. Discovery and data
1. What are the best **free or low-cost** sources for discovering brand-new Solana memecoins early? Compare DexScreener (boosts, profiles, pairs), GeckoTerminal `new_pools`, Birdeye, Pump.fun APIs and streams, Helius/QuickNode/Triton webhooks or gRPC (Yellowstone), Bitquery, and Jupiter token lists. Cover latency, rate limits, cost and reliability.
2. How can the bot get **real-time** price and trade data instead of 10-second polling, and what does that cost?
3. How can it get **actual buy and sell USD volume** (not transaction counts) and identify individual large trades or whale wallets?

### B. Safety and rug detection
4. What checks catch the most rug pulls and scams on Solana? Mint and freeze authority, LP burned or locked, top-holder and developer concentration, bundled or sniped launches, honeypot and sell simulation, transfer taxes (Token-2022 extensions), metadata mutability, social presence. Which APIs provide these (RugCheck, GoPlus, Birdeye security, SolSniffer, Solscan)?
5. How should these checks combine into a hard pass/fail gate versus a risk score?

### C. Strategy and signals
6. Which **entry signals** have evidence of an edge for memecoins? For example: smart-money or copy-trading wallets, holder growth rate, unique-buyer growth, volume/liquidity ratio, time since launch, Pump.fun bonding-curve progress and migration events, social or KOL mentions, and order-flow imbalance.
7. Should the bot specialize in a **phase** (fresh Pump.fun launches, Raydium migrations, or established tokens with momentum), and what does each phase need?
8. Is momentum the right core approach at all, versus mean reversion after dumps, or migration and listing events?
9. Better **exit strategies:** partial take-profits / scaling out, time-based exits tuned to the token's phase, volatility-adjusted stops (ATR-like), break-even stops, exits on liquidity drain or developer selling.

### D. Execution and costs
10. Realistic all-in costs for a $5 to $500 memecoin swap on Solana today: DEX fees, priority fees, Jito tips, slippage, failed transactions, and MEV/sandwich losses. What is the **minimum position size** where the strategy can plausibly beat costs?
11. Best practices for execution: Jupiter versus direct pool or bonding-curve swaps, priority fee strategy, Jito bundles, slippage limits, MEV protection, transaction confirmation and retry logic.
12. Safe **wallet and key management** for an automated bot.

### E. Risk and portfolio
13. Position sizing for very high-variance assets (fixed fractional, volatility-scaled, Kelly fraction), and per-token and per-day exposure limits.
14. How should drawdown circuit breakers **recover**? Cool-off periods, a reset peak, or manual review only (see section 13).
15. Correlation risk: many memecoins dump together when SOL or the broader market drops. Should there be a market-regime filter (SOL trend, total memecoin volume)?

### F. Learning and validation
16. How should a backtesting or replay system be built for Solana memecoins? Data sources for historical tick or minute-level data, and how to avoid survivorship and look-ahead bias.
17. How should the daily learning loop be improved? Optimizing expectancy instead of win rate, multivariate models, Bayesian updating, shadow-tracking filtered-out tokens to learn from missed trades, walk-forward validation, and A/B testing strategies in parallel paper portfolios.
18. What metrics and **go-live criteria** should be met in paper trading before risking real money (minimum number of trades, minimum days, expectancy after costs, maximum drawdown, consistency across market regimes)?

### G. Operations and compliance
19. Monitoring, alerting and kill-switch design for a live trading bot.
20. Legal, tax and record-keeping considerations for automated crypto trading as an individual in the UAE.

---

## 13. Known bugs and design issues

- **Drawdown block never recovers on its own.** Once drawdown passes 15% with no open positions, equity equals cash and cannot rise, so the bot stops buying permanently until someone resets the account or raises the limit.
- **Duplicate positions on the same token.** The execution loop checks for an existing open position only once, before looping over up to 5 signals. Two recent signals for the same token can open two positions.
- **Token age is wrong in live mode** (section 4).
- **Buy/sell pressure is approximated** from transaction counts (section 5).
- **Very high trade churn in demo mode.** Positions are often closed within seconds, so costs dominate.
- **A top-level `minLiquidityUsd` and a strategy-level `minLiquidityUsd` both exist.** The strategy filter uses the strategy-level one; the emergency exit uses the top-level one.

---

## 14. Configuration reference (`.env`)

| Variable | Default | Meaning |
|---|---|---|
| `DATA_MODE` | `demo` | `demo` or `live` |
| `DATABASE_URL` | local Postgres | Main database |
| `INITIAL_BALANCE_USD` | 100 | Starting virtual cash |
| `JOB_*_INTERVAL_MS` | see section 2 | Job cadences |
| `STALE_PRICE_MAX_AGE_MS` | 60000 | Quote age that counts as stale |
| `SOL_PRICE_CACHE_TTL_MS` / `SOL_PRICE_MAX_STALE_MS` | 30000 / 120000 | SOL/USD caching and staleness |
| `DEFAULT_PRIORITY_FEE_LAMPORTS` | 5000 | Fallback priority fee |
| `FAILED_TX_STILL_CHARGES_NETWORK` | true | Charge fees on failed simulated transactions |
| `MAX_POSITION_PCT` | 0.05 | Max position size as a share of equity |
| `MAX_SIMULTANEOUS_POSITIONS` | 5 | Open position cap |
| `MAX_RISK_PER_TRADE_PCT` | 0.01 | Risk per trade used in sizing |
| `MAX_DAILY_LOSS_PCT` | 0.05 | Daily loss circuit breaker |
| `MAX_DRAWDOWN_PCT` | 0.15 | Drawdown circuit breaker |
| `REPORT_TIME` / `REPORT_TIMEZONE` | 23:55 / Asia/Dubai | Daily report schedule |
| `LEARNING_ENABLED` | true | Allow the daily report to change settings |
| `LEARNING_MIN_TRADES` | 20 | Trades needed before any setting changes |

Strategy and exit settings (stop-loss 8%, take-profit 20%, trailing stop 10%, max hold 3600s, and all entry filters in section 6.2) are stored per portfolio in the database and editable on the Settings page.

---

## 15. Code map

| Area | Path |
|---|---|
| Worker jobs | `apps/server/src/jobs/runners.ts`, `scheduler.ts` |
| Strategy | `apps/server/src/engines/strategy/momentum-v1.ts` |
| Risk engine and defaults | `apps/server/src/engines/risk/engine.ts` |
| Paper execution | `apps/server/src/engines/paper/engine.ts` |
| Exit rules | `apps/server/src/engines/paper/exits.ts` |
| Cost simulator | `apps/server/src/engines/cost/simulator.ts` |
| Learning loop | `apps/server/src/engines/learning/`, `apps/server/src/services/report-service.ts` |
| Data providers | `apps/server/src/providers/` |
| Realtime hub | `apps/server/src/ws/hub.ts` |
| Database schema | `apps/server/src/db/migrations/` |
| API routes | `apps/server/src/api/routes/index.ts` |
| UI pages | `apps/web/src/pages/` |
| Shared types | `packages/shared/src/types.ts` |

---

## 16. What we want back from the research

A prioritized list of improvements, each with:

- **What** to change and **why**, with evidence or sources where possible.
- **Expected impact** on profitability or safety.
- **Cost** (API fees, infrastructure) and **effort** (small, medium, large).
- **Order of work**, for example: safety layer, then data quality, then execution realism, then strategy, then going live with a small amount.
- A concrete **go-live checklist** with measurable criteria.
