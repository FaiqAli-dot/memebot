import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config as loadEnv } from 'dotenv';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(__dirname, '../../../../.env') });

process.env.DATA_MODE = 'demo';
process.env.RAW_DATA_RETENTION_HOURS = '3';
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  'postgresql://memebot:memebot@localhost:5432/memebot_test';

describe('integration: raw data retention', () => {
  let db: typeof import('../../src/db/client.js');
  let pruneOldData: typeof import('../../src/db/retention.js').pruneOldData;
  let active: string;
  let dormant: string;

  beforeAll(async () => {
    db = await import('../../src/db/client.js');
    const { migrate } = await import('../../src/db/migrate.js');
    ({ pruneOldData } = await import('../../src/db/retention.js'));
    const { upsertDiscoveredToken } = await import('../../src/services/token-service.js');
    await migrate(process.env.DATABASE_URL);
    await db.query(`TRUNCATE market_snapshots, trade_events, tokens CASCADE`);
    const token = (address: string) =>
      upsertDiscoveredToken({ chain: 'solana', address, symbol: 'R', name: 'R', decimals: 9, createdAt: null });
    active = (await token('Retain111111111111111111111111111111111111'))!;
    dormant = (await token('Retain222222222222222222222222222222222222'))!;

    const snap = (tokenId: string, hoursAgo: number) =>
      db.query(
        `INSERT INTO market_snapshots (token_id, price_usd, data_mode, observed_at)
         VALUES ($1, 1, 'demo', NOW() - ($2::text || ' hours')::interval)`,
        [tokenId, String(hoursAgo)],
      );
    for (const h of [10, 5, 1]) await snap(active, h);
    for (const h of [10, 8]) await snap(dormant, h);
    for (const h of [10, 1]) {
      await db.query(
        `INSERT INTO trade_events (token_id, data_mode, observed_at, source)
         VALUES ($1, 'demo', NOW() - ($2::text || ' hours')::interval, 'test')`,
        [active, String(h)],
      );
    }
  }, 60_000);

  afterAll(async () => {
    await db.closePool();
  });

  it('drops raw rows past retention but keeps every token\'s latest snapshot', async () => {
    const deleted = await pruneOldData();
    expect(deleted.market_snapshots).toBe(3);
    expect(deleted.trade_events).toBe(1);

    const { rows } = await db.query<{ token_id: string; hours: number }>(
      `SELECT token_id, ROUND(EXTRACT(EPOCH FROM NOW() - observed_at) / 3600)::int AS hours
       FROM market_snapshots ORDER BY token_id, observed_at`,
    );
    expect(rows.filter((r) => r.token_id === active).map((r) => r.hours)).toEqual([1]);
    // A dormant token's latest snapshot survives even though it is older than the cutoff
    expect(rows.filter((r) => r.token_id === dormant).map((r) => r.hours)).toEqual([8]);
  });
});
