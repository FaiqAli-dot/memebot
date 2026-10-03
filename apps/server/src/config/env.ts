import { config as loadEnv } from 'dotenv';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  DEFAULT_PORTFOLIO_ID,
  INITIAL_BALANCE_USD,
  type DataMode,
  type RealismProfile,
} from '@memebot/shared';
import { assertPaperOnly } from '../domain/paper-safety.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// apps/server/src/config -> repo root
loadEnv({ path: resolve(__dirname, '../../../../.env') });
loadEnv(); // also allow process cwd .env

/** Missing / empty / anything other than true|1 → false (fail-safe for paper lock). */
const boolFromEnv = z
  .string()
  .optional()
  .transform((v) => v === 'true' || v === '1');

const envSchema = z.object({
  DATA_MODE: z.enum(['demo', 'live']).default('demo'),
  /** Architectural lock — only PAPER is accepted. */
  TRADING_MODE: z.enum(['PAPER']).default('PAPER'),
  REAL_EXECUTION_ENABLED: boolFromEnv,
  WALLET_SIGNING_ENABLED: boolFromEnv,
  REALISM_PROFILE: z
    .enum(['OPTIMISTIC', 'REALISTIC', 'CONSERVATIVE'])
    .default('REALISTIC'),
  REPLAY_SEED: z.coerce.number().int().default(42),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().default(3001),
  API_HOST: z.string().default('0.0.0.0'),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  LOG_LEVEL: z.string().default('info'),
  DATABASE_URL: z.string().min(1),
  TEST_DATABASE_URL: z.string().optional(),
  DEFAULT_PORTFOLIO_ID: z.string().uuid().default(DEFAULT_PORTFOLIO_ID),
  INITIAL_BALANCE_USD: z.coerce.number().default(INITIAL_BALANCE_USD),
  JOB_TOKEN_DISCOVERY_INTERVAL_MS: z.coerce.number().default(15_000),
  JOB_MARKET_DATA_INTERVAL_MS: z.coerce.number().default(10_000),
  JOB_ONCHAIN_INTERVAL_MS: z.coerce.number().default(30_000),
  JOB_SIGNAL_INTERVAL_MS: z.coerce.number().default(12_000),
  JOB_PAPER_EXECUTION_INTERVAL_MS: z.coerce.number().default(8_000),
  JOB_PORTFOLIO_VALUATION_INTERVAL_MS: z.coerce.number().default(10_000),
  JOB_ANALYTICS_INTERVAL_MS: z.coerce.number().default(30_000),
  JOB_TRADE_STREAM_INTERVAL_MS: z.coerce.number().default(5_000),
  JOB_SHADOW_INTERVAL_MS: z.coerce.number().default(15_000),
  JOB_REGIME_INTERVAL_MS: z.coerce.number().default(30_000),
  PROVIDER_MAX_RETRIES: z.coerce.number().default(3),
  PROVIDER_RETRY_BASE_MS: z.coerce.number().default(500),
  API_RATE_LIMIT_WINDOW_MS: z.coerce.number().default(60_000),
  API_RATE_LIMIT_MAX: z.coerce.number().default(300),
  SOLANA_RPC_URL: z.string().default('https://api.mainnet-beta.solana.com'),
  DEXSCREENER_BASE_URL: z.string().default('https://api.dexscreener.com'),
  GECKOTERMINAL_BASE_URL: z
    .string()
    .default('https://api.geckoterminal.com/api/v2'),
  JUPITER_BASE_URL: z.string().default('https://quote-api.jup.ag/v6'),
  COINGECKO_BASE_URL: z.string().default('https://api.coingecko.com/api/v3'),
  PUMPFUN_API_BASE_URL: z.string().default('https://frontend-api.pump.fun'),
  BIRDEYE_API_KEY: z.string().optional().default(''),
  BIRDEYE_BASE_URL: z.string().default('https://public-api.birdeye.so'),
  /** Meteora DBC discovery (keyless public RPC + optional datapi). */
  METEORA_DBC_ENABLED: z
    .string()
    .transform((v) => v !== 'false')
    .default('true'),
  METEORA_DBC_DATAPI_ENABLED: z
    .string()
    .transform((v) => v !== 'false')
    .default('true'),
  METEORA_DBC_DATAPI_BASE_URL: z.string().default('https://dbc.datapi.meteora.ag'),
  METEORA_DBC_REALTIME_ENABLED: z
    .string()
    .transform((v) => v === 'true' || v === '1')
    .default('false'),
  METEORA_DBC_SIGNATURE_LIMIT: z.coerce.number().int().positive().default(25),
  METEORA_DBC_TX_FETCH_LIMIT: z.coerce.number().int().positive().default(8),
  METEORA_DBC_MAX_PER_POLL: z.coerce.number().int().positive().default(20),
  METEORA_DBC_DATAPI_PAGE_SIZE: z.coerce.number().int().positive().default(40),
  METEORA_DBC_DATAPI_MAX_AGE_HOURS: z.coerce.number().positive().default(48),
  METEORA_DBC_RPC_TIMEOUT_MS: z.coerce.number().int().positive().default(12_000),
  /** Optional override; empty = use SOLANA_RPC_URL (keyless public OK). */
  METEORA_DBC_RPC_URL: z.string().optional().default(''),
  /**
   * If no real DBC init is seen for this many minutes, meteora_dbc health is STALE/DEGRADED.
   * DBC launches are frequent on mainnet — long silence usually means the feed is broken.
   */
  METEORA_DBC_STALE_SILENCE_MINUTES: z.coerce.number().positive().default(30),
  JOB_OUTCOME_CHECKPOINTS_INTERVAL_MS: z.coerce.number().default(60_000),
  JOB_STORAGE_MONITOR_INTERVAL_MS: z.coerce.number().default(30 * 60_000),
  /** Soft storage budget (bytes) for Railway Free — emergency prune backstop only. */
  STORAGE_SOFT_LIMIT_BYTES: z.coerce.number().int().positive().default(450_000_000),
  /**
   * Optional Postgres WAL cap applied at startup via ALTER SYSTEM (needs superuser, e.g. Railway).
   * Postgres defaults to 1GB of WAL, which alone can fill a 0.5GB volume.
   */
  DB_MAX_WAL_SIZE: z
    .string()
    .regex(/^\d+(MB|GB)$/, 'e.g. 64MB')
    .optional(),

  DEFAULT_PRIORITY_FEE_LAMPORTS: z.coerce.number().default(5000),
  DEFAULT_JITO_TIP_LAMPORTS: z.coerce.number().default(10_000),
  /** Demo-mode deterministic SOL/USD only — never used as a silent live fallback for trading */
  DEFAULT_SOL_PRICE_USD: z.coerce.number().default(150),
  SOL_PRICE_CACHE_TTL_MS: z.coerce.number().default(30_000),
  SOL_PRICE_MAX_STALE_MS: z.coerce.number().default(120_000),
  FAILED_TX_STILL_CHARGES_NETWORK: z
    .string()
    .transform((v) => v !== 'false')
    .default('true'),
  STALE_PRICE_MAX_AGE_MS: z.coerce.number().default(60_000),
  MAX_POSITION_PCT: z.coerce.number().default(0.05),
  MAX_SIMULTANEOUS_POSITIONS: z.coerce.number().default(5),
  MAX_RISK_PER_TRADE_PCT: z.coerce.number().default(0.01),
  MAX_DAILY_LOSS_PCT: z.coerce.number().default(0.05),
  MAX_DRAWDOWN_PCT: z.coerce.number().default(0.15),
  CAUTION_DRAWDOWN_PCT: z.coerce.number().default(0.1),
  RECOVERY_DRAWDOWN_PCT: z.coerce.number().default(0.08),
  MIN_EXPECTED_NET_VALUE: z.coerce.number().default(0.02),
  /** Threshold multiplier applied only when measured data confidence is LOW/UNKNOWN */
  LOW_CONFIDENCE_EV_MULTIPLIER: z.coerce.number().min(1).default(1.2),
  // Token universe: tracking set vs per-tick budgets
  TOKEN_TRACKING_MAX_AGE_HOURS: z.coerce.number().positive().default(24),
  TOKEN_TRACKING_CAP: z.coerce.number().int().positive().default(5000),
  TOKEN_EVALUATION_CAP_PER_TICK: z.coerce.number().int().positive().default(200),
  TOKEN_EVALUATION_ROTATION_SHARE: z.coerce.number().min(0).max(1).default(0.25),
  MARKET_DATA_CAP_PER_TICK: z.coerce.number().int().positive().default(300),
  TOKEN_STALE_AFTER_SEC: z.coerce.number().int().positive().default(300),
  TOKEN_ARCHIVE_STALE_AFTER_MIN: z.coerce.number().positive().default(30),
  // Volume acceleration (non-overlapping windows)
  VOLUME_ACCEL_MIN_BASELINE_USD: z.coerce.number().nonnegative().default(500),
  VOLUME_ACCEL_MAX: z.coerce.number().positive().default(10),
  // Research paper portfolio (never mixed with production stats)
  RESEARCH_EXPLORATION_ENABLED: z
    .string()
    .transform((v) => v !== 'false')
    .default('true'),
  RESEARCH_MAX_TRADES_PER_DAY: z.coerce.number().int().nonnegative().default(5),
  RESEARCH_MAX_EV_SHORTFALL: z.coerce.number().nonnegative().default(0.015),
  // Risk sizing (provisional paper/research values). Base size, per-trade max loss and
  // max open positions come from the existing portfolio settings (maxPositionPct,
  // maxRiskPerTradePct, maxSimultaneousPositions) — not duplicated here.
  PAPER_MIN_POSITION_USD: z.coerce.number().positive().default(1),
  MAX_PORTFOLIO_EXPOSURE_PCT: z.coerce.number().positive().max(1).default(0.5),
  MAX_STRATEGY_EXPOSURE_PCT: z.coerce.number().positive().max(1).default(0.25),
  MAX_TOKEN_EXPOSURE_PCT: z.coerce.number().positive().max(1).default(0.1),
  RISK_SIZE_HIGH_MULTIPLIER: z.coerce.number().positive().max(1).default(1),
  RISK_SIZE_MEDIUM_MULTIPLIER: z.coerce.number().positive().max(1).default(0.6),
  RISK_SIZE_LOW_MULTIPLIER: z.coerce.number().positive().max(1).default(0.3),
  /** EV at least this far above threshold → strong tier */
  RISK_STRONG_EV_MARGIN: z.coerce.number().nonnegative().default(0.03),
  RISK_SIZE_STRONG_EV_MULTIPLIER: z.coerce.number().min(1).max(1.5).default(1.25),
  /** Research-lane (near-threshold EV) positions are smaller, not exempt */
  RISK_SIZE_RESEARCH_MULTIPLIER: z.coerce.number().positive().max(1).default(0.5),
  /** |5m price change| bands: high → reduce, very high → reduce more, extreme → reject */
  RISK_VOL_HIGH_PCT: z.coerce.number().positive().default(15),
  RISK_VOL_VERY_HIGH_PCT: z.coerce.number().positive().default(25),
  RISK_VOL_EXTREME_PCT: z.coerce.number().positive().default(80),
  RISK_SIZE_HIGH_VOL_MULTIPLIER: z.coerce.number().positive().max(1).default(0.75),
  RISK_SIZE_VERY_HIGH_VOL_MULTIPLIER: z.coerce.number().positive().max(1).default(0.5),
  /** Hard execution limits — size is reduced to satisfy them, rejected if the minimum can't */
  MAX_ENTRY_PRICE_IMPACT_PCT: z.coerce.number().positive().default(3),
  MAX_ROUND_TRIP_COST_RATE: z.coerce.number().positive().default(0.2),
  SHADOW_REENTRY_COOLDOWN_SECONDS: z.coerce.number().int().nonnegative().default(300),
  OPPORTUNITY_COOLDOWN_SECONDS: z.coerce.number().int().nonnegative().default(300),
  JOB_LIFECYCLE_INTERVAL_MS: z.coerce.number().default(15_000),
  JOB_OPPORTUNITY_INTERVAL_MS: z.coerce.number().default(5_000),
  REPORT_TIME: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'REPORT_TIME must be HH:MM (24h)')
    .default('23:55'),
  REPORT_TIMEZONE: z
    .string()
    .refine((tz) => {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: tz });
        return true;
      } catch {
        return false;
      }
    }, 'REPORT_TIMEZONE must be an IANA zone like Asia/Dubai')
    .default('Asia/Dubai'),
  LEARNING_ENABLED: z
    .string()
    .transform((v) => v !== 'false')
    .default('true'),
  LEARNING_MIN_TRADES: z.coerce.number().int().positive().default(20),
  /**
   * Three-level learning. Level 1 records every closed trade; Level 2 health-checks every
   * N observations (alerts only); Level 3 calibrates in the daily report run, and only when
   * BOTH enough new production observations exist AND the interval has passed.
   */
  LEARNING_INTERVAL_HOURS: z.coerce.number().positive().default(24),
  MIN_NEW_OBSERVATIONS_FOR_LEARNING: z.coerce.number().int().positive().default(25),
  ANOMALY_CHECK_INTERVAL_TRADES: z.coerce.number().int().positive().default(5),
  ANOMALY_RECENT_WINDOW_TRADES: z.coerce.number().int().positive().default(25),
  ANOMALY_BASELINE_WINDOW_TRADES: z.coerce.number().int().positive().default(100),
  ANOMALY_ALERT_COOLDOWN_MINUTES: z.coerce.number().nonnegative().default(60),
  /**
   * Week-1 observation mode (default ON): observations, health checks, reports and calibration
   * candidates continue, but no strategy parameter or EV calibration is changed automatically.
   */
  LEARNING_OBSERVATION_MODE: z
    .string()
    .transform((v) => v !== 'false')
    .default('true'),
  /**
   * High-frequency raw tables (market/liquidity/holder snapshots, safety_assessments,
   * feature_snapshots, trade_events). Latest row per token kept where applicable.
   * Primary Free-tier protection — default 3 hours (do not extend to 72h).
   */
  RAW_DATA_RETENTION_HOURS: z.coerce.number().positive().default(3),
  /**
   * Compact research raw data only: token_raw_feature_observations and
   * outcome checkpoints (after 24h compaction). Permanent decision audits /
   * decision feature snapshots / summaries are never pruned by this.
   */
  RESEARCH_DATA_RETENTION_HOURS: z.coerce.number().positive().default(72),
  /** Bot log and missed-opportunity rows are pruned past this age */
  EVENT_RETENTION_DAYS: z.coerce.number().positive().default(3),
  // Alerts — disabled when unset
  TELEGRAM_BOT_TOKEN: z.string().optional().default(''),
  TELEGRAM_CHAT_ID: z.string().optional().default(''),
  DISCORD_WEBHOOK_URL: z.string().optional().default(''),
  ALERT_EMAIL_TO: z.string().optional().default(''),
  ALERT_COOLDOWN_MS: z.coerce.number().default(300_000),
});

// Hosting platforms (Railway, Render, …) assign the listen port via PORT; it must win over API_PORT
if (process.env.PORT) process.env.API_PORT = process.env.PORT;

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:', parsed.error.flatten());
  process.exit(1);
}

// Refuse to start if real execution / wallet signing is enabled
assertPaperOnly({
  TRADING_MODE: parsed.data.TRADING_MODE,
  REAL_EXECUTION_ENABLED: parsed.data.REAL_EXECUTION_ENABLED,
  WALLET_SIGNING_ENABLED: parsed.data.WALLET_SIGNING_ENABLED,
});

export const env = parsed.data;
export const dataMode: DataMode = env.DATA_MODE;
export const realismProfile: RealismProfile = env.REALISM_PROFILE;
