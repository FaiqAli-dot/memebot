import pg from 'pg';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

const { Pool } = pg;

let pool: pg.Pool | null = null;
let dbAvailable = true;

export function getPool(connectionString = env.DATABASE_URL): pg.Pool {
  if (!pool) {
    pool = new Pool({
      connectionString,
      max: 20,
      idleTimeoutMillis: 30_000,
    });
    pool.on('error', (err) => {
      dbAvailable = false;
      logger.error({ err }, 'Unexpected PostgreSQL pool error');
    });
  }
  return pool;
}

export function isDbAvailable(): boolean {
  return dbAvailable;
}

export function setDbAvailable(v: boolean): void {
  dbAvailable = v;
}

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<pg.QueryResult<T>> {
  try {
    const result = await getPool().query<T>(text, params);
    dbAvailable = true;
    return result;
  } catch (err) {
    dbAvailable = false;
    throw err;
  }
}

export async function withTransaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    dbAvailable = true;
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    dbAvailable = false;
    throw err;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
