import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

export type JobName =
  | 'token_discovery'
  | 'market_data'
  | 'trade_stream'
  | 'onchain'
  | 'safety'
  | 'regime'
  | 'signal'
  | 'paper_execution'
  | 'shadow'
  | 'portfolio_valuation'
  | 'analytics'
  | 'daily_report';

interface Job {
  name: JobName;
  intervalMs: number;
  running: boolean;
  timer?: NodeJS.Timeout;
  fn: () => Promise<void>;
}

const jobs = new Map<JobName, Job>();

export function registerJob(
  name: JobName,
  intervalMs: number,
  fn: () => Promise<void>,
): void {
  jobs.set(name, { name, intervalMs, running: false, fn });
}

async function tick(job: Job): Promise<void> {
  if (job.running) {
    logger.warn({ job: job.name }, 'Skipping job tick — previous still running');
    return;
  }
  job.running = true;
  try {
    await job.fn();
  } catch (err) {
    logger.error({ err, job: job.name }, 'Job failed');
  } finally {
    job.running = false;
  }
}

export function startJobs(): void {
  for (const job of jobs.values()) {
    logger.info({ job: job.name, intervalMs: job.intervalMs }, 'Starting job');
    void tick(job);
    job.timer = setInterval(() => void tick(job), job.intervalMs);
  }
}

export function stopJobs(): void {
  for (const job of jobs.values()) {
    if (job.timer) clearInterval(job.timer);
    job.timer = undefined;
  }
}

export function defaultIntervals(): Record<JobName, number> {
  return {
    token_discovery: env.JOB_TOKEN_DISCOVERY_INTERVAL_MS,
    market_data: env.JOB_MARKET_DATA_INTERVAL_MS,
    trade_stream: env.JOB_TRADE_STREAM_INTERVAL_MS,
    onchain: env.JOB_ONCHAIN_INTERVAL_MS,
    safety: env.JOB_ONCHAIN_INTERVAL_MS,
    regime: env.JOB_REGIME_INTERVAL_MS,
    signal: env.JOB_SIGNAL_INTERVAL_MS,
    paper_execution: env.JOB_PAPER_EXECUTION_INTERVAL_MS,
    shadow: env.JOB_SHADOW_INTERVAL_MS,
    portfolio_valuation: env.JOB_PORTFOLIO_VALUATION_INTERVAL_MS,
    analytics: env.JOB_ANALYTICS_INTERVAL_MS,
    daily_report: 60_000,
  };
}
