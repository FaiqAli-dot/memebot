import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { getPool, closePool } from './client.js';
import { logger } from '../utils/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Serializes concurrent migrators (API and worker both migrate on boot in dev). */
const MIGRATION_LOCK_KEY = 727_001;

export async function migrate(connectionString?: string): Promise<void> {
  const pool = getPool(connectionString);
  const client = await pool.connect();
  try {
    await migrateClient(client);
  } finally {
    client.release();
  }
}

/** Applies pending migrations through an explicit connection (no shared pool). */
export async function migrateClient(client: pg.ClientBase): Promise<void> {
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    const dir = join(__dirname, 'migrations');
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    for (const file of files) {
      const { rows } = await client.query('SELECT 1 FROM schema_migrations WHERE id = $1', [file]);
      if (rows.length > 0) {
        logger.info({ file }, 'Migration already applied');
        continue;
      }
      const sql = readFileSync(join(dir, file), 'utf8');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (id) VALUES ($1)', [file]);
        await client.query('COMMIT');
        logger.info({ file }, 'Applied migration');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => undefined);
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('migrate.ts') || process.argv[1]?.endsWith('migrate.js')) {
  migrate()
    .then(async () => {
      await closePool();
      process.exit(0);
    })
    .catch(async (err) => {
      logger.error(err);
      await closePool();
      process.exit(1);
    });
}
