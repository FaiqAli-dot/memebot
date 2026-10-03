# MemeBot

**Meme Coin Paper Trading & Research — Reality-First Simulator**

100% virtual money. No wallets, private keys, deposits, withdrawals, or real swaps. Open the site with no login and watch a paper-trading bot scan Solana meme coins, score signals, and simulate executions with fees, slippage, and price impact.

**Architectural lock:** `TRADING_MODE=PAPER`, `REAL_EXECUTION_ENABLED=false`, `WALLET_SIGNING_ENABLED=false`. The app **refuses to start** if real execution or wallet signing is enabled. See `docs/PLAN.md` and `docs/RESEARCH_BRIEF.md`.

## Architecture

```
Frontend (React + TS)
    ↓ REST + WebSocket
API Server (Express)
    ↓
PostgreSQL
    ↑
Background Worker (jobs)
  • token discovery
  • market data updates
  • on-chain updates
  • signal calculation
  • paper execution
  • portfolio valuation
  • analytics aggregation
```

Provider interfaces live under `apps/server/src/providers/` (`market`, `onchain`, `token-discovery`, `fees`, `demo`). Services consume interfaces only — no scattered HTTP calls.

Engines / modules: multi-source discovery, safety, flow features, regime, lifecycle phases, multi-strategy framework + EV, risk state machine (NORMAL/CAUTION/HALTED/RECOVERY), execution realism profiles, shadow trades, replay/walk-forward, learning metrics, kill switch. Legacy `MomentumStrategyV1` retained for scoring bridge.

## Requirements

- Node.js 20+
- PostgreSQL 16+ (local install or Docker)
- npm 10+

## Quick start

```bash
# 1) Install
npm install

# 2) Configure
cp .env.example .env
# DATA_MODE=demo by default

# 3) Database
docker compose up -d postgres
# or use a local Postgres matching DATABASE_URL

npm run db:migrate
npm run db:seed

# 4) Run API + worker + web
npm run dev
```

- Web UI: http://localhost:5173  
- API: http://localhost:3001  
- WebSocket: `ws://localhost:3001/ws`

The default portfolio starts with **$100.00** virtual USD and the bot is seeded **RUNNING**.

## Environment variables

See `.env.example`. Important:

| Variable | Purpose |
|---|---|
| `DATA_MODE` | `demo` (deterministic synthetic) or `live` (real providers) |
| `DATABASE_URL` | Postgres connection string |
| `TEST_DATABASE_URL` | Postgres DB for integration tests |
| `DEFAULT_PORTFOLIO_ID` | Single demo portfolio UUID (auth-ready schema) |
| `INITIAL_BALANCE_USD` | Starting virtual cash (default 100) |
| `SOLANA_RPC_URL` | RPC for priority fees (live) |
| `DEXSCREENER_BASE_URL` | Public market/discovery API |
| `GECKOTERMINAL_BASE_URL` | Optional holder/info enrichment |
| `BIRDEYE_API_KEY` | Optional; reserved for future Birdeye provider |
| `JOB_*_INTERVAL_MS` | Worker cadences |
| `FAILED_TX_STILL_CHARGES_NETWORK` | Failed sims may still debit network/priority fees |
| `DEFAULT_PRIORITY_FEE_LAMPORTS` | Fallback priority fee |
| `STALE_PRICE_MAX_AGE_MS` | Do not trade on stale quotes |

**Never commit secrets.** All keys come from env.

## Demo vs live data

- **Demo (`DATA_MODE=demo`)**: Deterministic synthetic Solana-like tokens and quotes. UI shows a **DEMO DATA** badge. All rows are stored with `data_mode='demo'` and never mixed with live rows.
- **Live (`DATA_MODE=live`)**: DexScreener for discovery + quotes; Solana RPC `getRecentPrioritizationFees` for priority fees; GeckoTerminal best-effort holders. If a provider fails, MemeBot logs the failure and **does not invent prices**.

## Fee / slippage / price impact assumptions

Documented in code (`apps/server/src/engines/cost/simulator.ts`) and enforced in execution:

1. **DEX fee** — Pool `fee_bps` when known; else venue default (Raydium 25 bps, Orca 30, Pump-like 100, unknown 30). Applied on fill notional.
2. **Network fee** — ~5000 lamports base signature fee × **live SOL/USD** (demo: deterministic labeled price).
3. **Priority fee** — Observed median prioritization fee (or configured default) × same SOL/USD.
   - **Live SOL/USD**: DexScreener WSOL pairs (primary) → CoinGecko `simple/price` (fallback), cached (`SOL_PRICE_CACHE_TTL_MS`, default 30s).
   - If SOL/USD is stale (`SOL_PRICE_MAX_STALE_MS`) or unavailable, **new paper trades are blocked** (BotEvent logged). `DEFAULT_SOL_PRICE_USD` is demo-only / never a silent live trading fallback.
   - Each `paper_orders` / `fee_records` row stores `sol_price_usd` + `sol_price_source` for audit. UI shows the rate beside network/priority fees.
4. **Price impact** — Constant-product style: `amount / (quoteReserve + amount)` when reserves/liquidity known.
5. **Slippage** — Impact + volatility buffer from `|priceChange5m|` + size/liquidity ratio (not a flat 0.1%).
6. **Executable price** — Buys pay mid×(1+adverse); sells receive mid×(1−adverse). Exits never use raw chart mid alone.
7. **Partial fills** — If size > 15% of liquidity, fill up to ~12% of liquidity.
8. **Failed / unfillable** — Zero liquidity, missing price, or forced failure. When `FAILED_TX_STILL_CHARGES_NETWORK=true`, network+priority may still debit cash.
9. **P/L** — UI separates Gross trading P/L vs DEX fees, network, priority, slippage, price impact → **Net P/L**.

## Paper trading limitations

- No real chain execution, wallet, or settlement finality modeling beyond fee/slippage heuristics.
- Holder concentration depends on provider availability (often null in live mode).
- Live SOL/USD is fetched (DexScreener → CoinGecko); if unavailable/stale, new paper trades stop rather than inventing a price. Demo uses deterministic labeled SOL/USD.
- Historical charts only include samples collected while running (no fabricated equity history).
- Scores are **model scores**, not probabilities of profit. The UI states this explicitly.

## Strategy

**Momentum Scanner v1** (`MomentumStrategyV1`): volume acceleration, short-term momentum, buy pressure, min liquidity/activity, configurable age range → score → risk engine → paper trade. Extensible `Strategy` interface for future strategies (not implemented in MVP).

## Risk defaults

- Max position 5% of equity  
- Max 5 open positions  
- Max risk per trade 1% (sized via stop)  
- Max daily loss 5%  
- Max drawdown 15% → stop opening new positions; exits still managed  

## Tests

```bash
# Unit tests (no DB required for most)
npm run test:unit

# Integration tests (requires Postgres at TEST_DATABASE_URL)
npm run test:integration

# All
npm test
```

Integration tests run against a real Postgres database (`memebot_test` by default).

## Production build

```bash
npm run build
npm run typecheck
npm run lint
```

Run the built app (migrates, then starts API + worker; the API also serves the dashboard on the same port):

```bash
npm start
```

## Hosting on Railway (free trial)

`railway.json` configures the build (`npm run build`), start (`npm start`) and health check (`/api/health`). One service runs the API, worker and dashboard; Railway provides Postgres.

1. [railway.com](https://railway.com) → sign in with GitHub → **New Project → Deploy from GitHub repo** → pick this repo.
2. In the project: **+ Create → Database → PostgreSQL**.
3. Open the app service → **Variables → Raw Editor**, paste your `.env`, then set:
   - `DATABASE_URL=${{Postgres.DATABASE_URL}}`
   - `NODE_ENV=production`
   - delete `TEST_DATABASE_URL`, `API_PORT` and `CORS_ORIGIN` (Railway's `PORT` is used; the UI is same-origin)
4. **Settings → Networking → Generate Domain**. Open it — that's the dashboard.

Raw market tables are pruned to `RAW_DATA_RETENTION_HOURS` (default 3) and logs to `EVENT_RETENTION_DAYS` (default 3) so the database stays small. The trial is a one-time $5 credit for up to 30 days; when it runs out, services stop until a plan is added.

## Project layout

```
apps/server   API, worker, engines, providers, migrations, tests
apps/web      React + TypeScript UI
packages/shared  Shared types, zod schemas, constants
docker-compose.yml  Postgres
```

## Safety / compliance language

Never claims guaranteed profit, safety, or unexplained “AI BUY”. Uses factual terms: Net P/L, Historical win rate, Max drawdown, Simulated return, Estimated execution cost, Signal score (model score).
