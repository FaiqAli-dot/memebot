/**
 * Database storage guard. Measures the whole Postgres volume (every database + WAL when the
 * role may read pg_ls_waldir) and classifies it into a storage state that drives retention
 * aggressiveness and whether non-essential (research) writes are allowed.
 *
 * Trading writes (tokens, market snapshots, positions, orders, fills, signals, risk) are never
 * gated here — only research/observability writers consult `researchWritesAllowed()`.
 */
import { query } from './client.js';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

export const STORAGE_STATES = [
  'NORMAL',
  'WARNING',
  'AGGRESSIVE_CLEANUP',
  'EMERGENCY_CLEANUP',
  'STOP_NON_ESSENTIAL_WRITES',
] as const;
export type StorageState = (typeof STORAGE_STATES)[number];

export interface StorageThresholdsMb {
  warning: number;
  aggressive: number;
  emergency: number;
  stopWrites: number;
  limit: number;
}

export function storageThresholds(): StorageThresholdsMb {
  return {
    warning: env.STORAGE_WARNING_MB,
    aggressive: env.STORAGE_AGGRESSIVE_MB,
    emergency: env.STORAGE_EMERGENCY_MB,
    stopWrites: env.STORAGE_STOP_WRITES_MB,
    limit: env.STORAGE_LIMIT_MB,
  };
}

const MB = 1024 * 1024;

export function classifyStorage(usedBytes: number, t: StorageThresholdsMb = storageThresholds()): StorageState {
  const mb = usedBytes / MB;
  if (mb > t.stopWrites) return 'STOP_NON_ESSENTIAL_WRITES';
  if (mb > t.emergency) return 'EMERGENCY_CLEANUP';
  if (mb >= t.aggressive) return 'AGGRESSIVE_CLEANUP';
  if (mb >= t.warning) return 'WARNING';
  return 'NORMAL';
}

export function stateRank(s: StorageState): number {
  return STORAGE_STATES.indexOf(s);
}

export interface StorageMeasurement {
  databaseBytes: number;
  allDatabasesBytes: number;
  walBytes: number | null;
  usedBytes: number;
  /** usedBytes plus the configured volume overhead SQL cannot see (an estimate, not a measurement). */
  estimatedVolumeBytes: number;
  state: StorageState;
  measuredAt: Date;
}

/** Estimated share of the hosted volume in use, including unobservable overhead. */
export function estimatedVolumePct(m: Pick<StorageMeasurement, 'estimatedVolumeBytes'>): number {
  return (m.estimatedVolumeBytes / (env.STORAGE_LIMIT_MB * MB)) * 100;
}

export async function measureStorage(): Promise<StorageMeasurement> {
  const { rows } = await query<{ db: string; all: string }>(
    `SELECT pg_database_size(current_database())::text AS db,
            (SELECT SUM(pg_database_size(datname)) FROM pg_database)::text AS all`,
  );
  const databaseBytes = Number(rows[0]?.db ?? 0);
  const allDatabasesBytes = Number(rows[0]?.all ?? databaseBytes);
  let walBytes: number | null = null;
  try {
    const wal = await query<{ b: string | null }>(`SELECT SUM(size)::text AS b FROM pg_ls_waldir()`);
    walBytes = wal.rows[0]?.b != null ? Number(wal.rows[0].b) : 0;
  } catch {
    walBytes = null; // needs superuser / pg_monitor
  }
  const usedBytes = allDatabasesBytes + (walBytes ?? 0);
  return {
    databaseBytes,
    allDatabasesBytes,
    walBytes,
    usedBytes,
    estimatedVolumeBytes: usedBytes + env.STORAGE_UNOBSERVED_OVERHEAD_MB * MB,
    state: classifyStorage(usedBytes),
    measuredAt: new Date(),
  };
}

let current: StorageMeasurement | null = null;
let forcedState: StorageState | null = null;
const HEADROOM_WARN_EVERY_MS = 15 * 60_000;
let lastHeadroomWarnAt = 0;

/** Latest known state in this process (NORMAL until first measurement). */
export function currentStorageState(): StorageState {
  return forcedState ?? current?.state ?? 'NORMAL';
}

export function lastStorageMeasurement(): StorageMeasurement | null {
  return current;
}

/** Research/observability writes are skipped once the volume is near full. */
export function researchWritesAllowed(): boolean {
  return currentStorageState() !== 'STOP_NON_ESSENTIAL_WRITES';
}

export async function refreshStorageState(): Promise<StorageMeasurement> {
  const prev = current?.state ?? 'NORMAL';
  const m = await measureStorage();
  current = m;
  if (m.state !== prev) {
    const log = stateRank(m.state) > stateRank(prev) ? logger.warn.bind(logger) : logger.info.bind(logger);
    log(
      { from: prev, to: m.state, usedMb: Math.round(m.usedBytes / MB), walMb: m.walBytes != null ? Math.round(m.walBytes / MB) : null },
      'Database storage state changed',
    );
  }
  const pct = estimatedVolumePct(m);
  if (pct >= env.STORAGE_HEADROOM_WARN_PCT && Date.now() - lastHeadroomWarnAt >= HEADROOM_WARN_EVERY_MS) {
    lastHeadroomWarnAt = Date.now();
    logger.warn(
      {
        state: m.state,
        usedMb: Math.round(m.usedBytes / MB),
        estimatedVolumeMb: Math.round(m.estimatedVolumeBytes / MB),
        unobservedOverheadMb: env.STORAGE_UNOBSERVED_OVERHEAD_MB,
        limitMb: env.STORAGE_LIMIT_MB,
        estimatedPct: Math.round(pct),
        researchWritesSuppressed: !researchWritesAllowed(),
      },
      'Volume headroom low (estimate includes overhead invisible to SQL)',
    );
  }
  return m;
}

/** Test hook: pin the state without measuring. Pass null to clear. */
export function setStorageStateForTests(state: StorageState | null): void {
  forcedState = state;
}

/** Runs a research write; skipped when storage is critical, never throws into trading code. */
export async function researchWrite<T>(label: string, fn: () => Promise<T>): Promise<T | null> {
  if (!researchWritesAllowed()) return null;
  try {
    return await fn();
  } catch (err) {
    logger.warn({ err: (err as Error).message, label }, 'Research write failed; trading continues');
    return null;
  }
}
