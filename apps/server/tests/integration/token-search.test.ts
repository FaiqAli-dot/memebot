import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { config as loadEnv } from 'dotenv';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(__dirname, '../../../../.env') });

process.env.DATA_MODE = 'demo';
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  'postgresql://memebot:memebot@localhost:5432/memebot_test';

type Db = typeof import('../../src/db/client.js');
type Tokens = typeof import('../../src/services/token-service.js');
type Query = typeof import('../../src/intelligence/query.js');

/** Phantom BATON */
const BATON_MINT = 'Hg5Ja55T5wESq4vyFoiVCMeHXtGyVA69X2UHq8hgpump';

describe('integration: token intelligence search', () => {
  let db: Db;
  let tokens: Tokens;
  let intel: Query;

  async function token(address: string, symbol: string, name: string): Promise<string> {
    return (await tokens.upsertDiscoveredToken({ chain: 'solana', address, symbol, name, decimals: 6, createdAt: null }))!;
  }

  beforeAll(async () => {
    db = await import('../../src/db/client.js');
    const { migrate } = await import('../../src/db/migrate.js');
    await migrate(process.env.DATABASE_URL);
    tokens = await import('../../src/services/token-service.js');
    intel = await import('../../src/intelligence/query.js');
  }, 60_000);

  beforeEach(async () => {
    await db.query(`TRUNCATE pools, signals, market_snapshots, tokens CASCADE`);
  });

  afterAll(async () => {
    await db.closePool();
  });

  it('11. exact mint returns exactly that token', async () => {
    const id = await token('Exact1111111111111111111111111111111111pump', 'EXA', 'Exact Token');
    await token('Other1111111111111111111111111111111111pump', 'EXA', 'Exact Token Clone');
    const r = await intel.searchTokens('  Exact1111111111111111111111111111111111pump ');
    expect(r).toMatchObject({ matchType: 'mint', exactQuery: true, found: true });
    expect(r.tokens.map((t) => t.tokenId)).toEqual([id]);
  });

  it('12. BATON by exact mint never returns a different BATON token', async () => {
    await token('BatonFake11111111111111111111111111111pump', 'BATON', 'Baton');
    await token('BatonFake22222222222222222222222222222pump', 'BATON', 'BATON Coin');

    const missing = await intel.searchTokens(BATON_MINT);
    expect(missing).toMatchObject({ matchType: 'none', exactQuery: true, found: false, tokens: [] });
    expect(missing.message).toMatch(/Not discovered/);

    const realId = await token(BATON_MINT, 'BATON', 'Phantom Baton');
    const found = await intel.searchTokens(BATON_MINT);
    expect(found.matchType).toBe('mint');
    expect(found.tokens).toHaveLength(1);
    expect(found.tokens[0]).toMatchObject({ tokenId: realId, address: BATON_MINT });

    // A text search for the symbol lists every BATON, exact symbol matches first
    const text = await intel.searchTokens('baton');
    expect(text.exactQuery).toBe(false);
    expect(text.tokens).toHaveLength(3);
    expect(text.tokens.every((t) => t.matchedOn === 'symbol')).toBe(true);
  });

  it('13. a token that was only discovered (never traded) can be searched and investigated', async () => {
    const id = await token('Quiet1111111111111111111111111111111111pump', 'QUIET', 'Quiet Token');
    const r = await intel.searchTokens('Quiet1111111111111111111111111111111111pump');
    expect(r.tokens[0]!.tokenId).toBe(id);
    const detail = (await intel.getIntelligenceTokenDetail(id))!;
    expect(detail.signals).toEqual([]);
    expect(detail.orders).toEqual([]);
    expect(detail.positions).toEqual([]);
    expect(detail.executionAttempts).toEqual([]);
    expect((detail.timeline as Array<{ kind: string }>)[0]!.kind).toBe('DISCOVERED');
  });

  it('finds tokens by pool address, token id and name; IDs and addresses never fuzzy-match', async () => {
    const id = await token('Pxxed111111111111111111111111111111111pump', 'POOL', 'Pooled Thing');
    await db.query(
      `INSERT INTO pools (token_id, pool_address, dex_venue, data_mode) VALUES ($1, 'PxAddr111111111111111111111111111111111111', 'raydium', 'demo')`,
      [id],
    );
    expect((await intel.searchTokens('PxAddr111111111111111111111111111111111111')).tokens[0]).toMatchObject({
      tokenId: id,
      matchedOn: 'pool_address',
    });
    expect((await intel.searchTokens(id)).matchType).toBe('token_id');
    expect((await intel.searchTokens('pooled thing')).tokens[0]).toMatchObject({ tokenId: id, matchedOn: 'name' });
    // A prefix of a real mint is an address-shaped query only if it is 32+ chars; it must not partial-match
    expect((await intel.searchTokens('Pxxed11111111111111111111111111111111')).found).toBe(false);
    expect((await intel.searchTokens('00000000-0000-4000-8000-000000000000')).found).toBe(false);
    expect(await intel.getIntelligenceTokenDetail('not-a-uuid')).toBeNull();
  });
});
