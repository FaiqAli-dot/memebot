import { config as loadEnv } from 'dotenv';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  DEFAULT_PORTFOLIO_ID,
  INITIAL_BALANCE_USD,
  type DataMode,
} from '@memebot/shared';

const __dirname = dirname(fileURLToPath(import.meta.url));
// apps/server/src/config -> repo root
loadEnv({ path: resolve(__dirname, '../../../../.env') });
loadEnv(); // also allow process cwd .env

const envSchema = z.object({
  DATA_MODE: z.enum(['demo', 'live']).default('demo'),
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
  BIRDEYE_API_KEY: z.string().optional().default(''),
  BIRDEYE_BASE_URL: z.string().default('https://public-api.birdeye.so'),
  DEFAULT_PRIORITY_FEE_LAMPORTS: z.coerce.number().default(5000),
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
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:', parsed.error.flatten());
  process.exit(1);
}

export const env = parsed.data;
export const dataMode: DataMode = env.DATA_MODE;
