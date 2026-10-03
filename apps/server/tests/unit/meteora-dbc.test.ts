import { describe, expect, it } from 'vitest';
import {
  base58Encode,
  extractAccountsFromInitTx,
  migrationProgressFromByte,
  METEORA_DBC_PROGRAM_ID,
  parseVirtualPoolAccountData,
  toEnrichedFromPoolState,
  type MeteoraDbcPoolState,
} from '../../src/providers/discovery/meteora-dbc.js';
import { inferGeckoVenue } from '../../src/providers/discovery/multi-source.js';
import { classifyLiquidity } from '../../src/universe/lifecycle.js';
import {
  mapFunnelRejection,
  mapRiskRejection,
  mapStrategyReason,
  rejectionBucket,
} from '../../src/intelligence/reasons.js';
import { env } from '../../src/config/env.js';

/** SPEC-like fixture for tests only — never hardcoded in production discovery. */
export const SPEC_LIKE_FIXTURE = {
  mint: '2AVjqmGbMqg7rSyHVv2deVdggsBgBtu1Bi69BUvE5WRv',
  pool: '6V4y6MoSGgaF8d5Hew49RxQ8qE1XLVXBtxfee24w8VWq',
  symbol: 'SPEC',
  name: 'Spec',
  decimals: 6,
};

function pubkeyBytes(base58Like: string): Buffer {
  // Deterministic fake 32-byte key material for layout tests (not real curve points)
  const buf = Buffer.alloc(32, 0);
  Buffer.from(base58Like).copy(buf, 0, 0, Math.min(32, base58Like.length));
  return buf;
}

function buildVirtualPoolAccount(opts: {
  baseMint: string;
  isMigrated: number;
  migrationProgress: number;
}): string {
  const buf = Buffer.alloc(400, 0);
  // discriminator
  buf.writeBigUInt64LE(1n, 0);
  // skip vol tracker 64 bytes at offset 8
  pubkeyBytes('config____________________________').copy(buf, 72);
  pubkeyBytes('creator___________________________').copy(buf, 104);
  pubkeyBytes(opts.baseMint).copy(buf, 136);
  pubkeyBytes('basevault_________________________').copy(buf, 168);
  pubkeyBytes('quotevault________________________').copy(buf, 200);
  buf.writeBigUInt64LE(1_000_000n, 232);
  buf.writeBigUInt64LE(2_000_000n, 240);
  buf.writeBigUInt64LE(0n, 248);
  buf.writeBigUInt64LE(0n, 256);
  buf.writeBigUInt64LE(0n, 264);
  buf.writeBigUInt64LE(0n, 272);
  // sqrt_price u128
  buf.writeBigUInt64LE(1n, 280);
  buf.writeBigUInt64LE(0n, 288);
  buf.writeBigUInt64LE(1_700_000_000n, 296); // activation unix
  buf[304] = 0; // pool_type
  buf[305] = opts.isMigrated;
  buf[306] = 0;
  buf[307] = 0;
  buf[308] = opts.migrationProgress;
  return buf.toString('base64');
}

describe('Meteora DBC discovery helpers', () => {
  it('parses pre-migration DBC pool account state', () => {
    const b64 = buildVirtualPoolAccount({
      baseMint: SPEC_LIKE_FIXTURE.mint,
      isMigrated: 0,
      migrationProgress: 0,
    });
    const state = parseVirtualPoolAccountData(b64, SPEC_LIKE_FIXTURE.pool);
    expect(state).not.toBeNull();
    expect(state!.isMigrated).toBe(false);
    expect(state!.migrationProgress).toBe('PRE_BONDING_CURVE');
    expect(state!.baseMint).toBe(base58Encode(pubkeyBytes(SPEC_LIKE_FIXTURE.mint)));
    expect(state!.baseMint.length).toBeGreaterThan(20);
  });

  it('parses post-migration DBC pool account state', () => {
    const b64 = buildVirtualPoolAccount({
      baseMint: SPEC_LIKE_FIXTURE.mint,
      isMigrated: 1,
      migrationProgress: 3,
    });
    const state = parseVirtualPoolAccountData(b64, SPEC_LIKE_FIXTURE.pool)!;
    expect(state.isMigrated).toBe(true);
    expect(state.migrationProgress).toBe('CREATED_POOL');
    const token = toEnrichedFromPoolState(state, {
      symbol: SPEC_LIKE_FIXTURE.symbol,
      name: SPEC_LIKE_FIXTURE.name,
      decimals: SPEC_LIKE_FIXTURE.decimals,
    });
    expect(token.discoverySource).toBe('METEORA_DBC');
    expect(token.dexVenue).toBe('meteora_damm');
    expect(token.metadata?.migrationStatus).toBe('MIGRATED');
  });

  it('marks SPEC-like pre-migration tokens as meteora_dbc venue', () => {
    const state: MeteoraDbcPoolState = {
      poolAddress: SPEC_LIKE_FIXTURE.pool,
      baseMint: SPEC_LIKE_FIXTURE.mint,
      creator: null,
      config: null,
      quoteReserve: 100,
      baseReserve: 1000,
      activationPoint: 1_700_000_000,
      isMigrated: false,
      migrationProgress: 'PRE_BONDING_CURVE',
      poolType: 0,
    };
    const token = toEnrichedFromPoolState(state, {
      symbol: SPEC_LIKE_FIXTURE.symbol,
      name: SPEC_LIKE_FIXTURE.name,
      decimals: 6,
    });
    expect(token.address).toBe(SPEC_LIKE_FIXTURE.mint);
    expect(token.dexVenue).toBe('meteora_dbc');
    expect(token.metadata?.preMigration).toBe(true);
    expect(token.metadata?.launchMechanism).toBe('meteora_dbc');
    expect(classifyLiquidity({ venue: token.dexVenue, liquidityUsd: null })).toBe('BONDING_CURVE');
  });

  it('extracts initialize-pool accounts from a tx shaped like Meteora DBC IDL', () => {
    const keys = [
      'payer111111111111111111111111111111111111',
      'config11111111111111111111111111111111111',
      'authority1111111111111111111111111111111',
      'creator111111111111111111111111111111111',
      SPEC_LIKE_FIXTURE.mint,
      'So11111111111111111111111111111111111111112',
      SPEC_LIKE_FIXTURE.pool,
      'vaultb11111111111111111111111111111111111',
      'vaultq11111111111111111111111111111111111',
      METEORA_DBC_PROGRAM_ID,
    ];
    const programIdIndex = keys.indexOf(METEORA_DBC_PROGRAM_ID);
    const tx = {
      transaction: {
        message: {
          accountKeys: keys,
          instructions: [
            {
              programIdIndex,
              accounts: [1, 2, 3, 4, 5, 6, 7, 8],
            },
          ],
        },
      },
      meta: {
        logMessages: [
          `Program ${METEORA_DBC_PROGRAM_ID} invoke [1]`,
          'Program log: Instruction: InitializeVirtualPoolWithSplToken',
          `Program ${METEORA_DBC_PROGRAM_ID} success`,
        ],
      },
    };
    const extracted = extractAccountsFromInitTx(tx);
    expect(extracted).toEqual({
      baseMint: SPEC_LIKE_FIXTURE.mint,
      pool: SPEC_LIKE_FIXTURE.pool,
      creator: 'creator111111111111111111111111111111111',
      config: 'config11111111111111111111111111111111111',
      quoteMint: 'So11111111111111111111111111111111111111112',
    });
  });

  it('infers meteora venues from gecko metadata', () => {
    expect(inferGeckoVenue({ name: 'FOO-SOL', dexId: 'meteora-dbc' })).toBe('meteora_dbc');
    expect(inferGeckoVenue({ name: 'FOO-SOL', dexId: 'meteora-damm-v2' })).toBe('meteora_damm');
    expect(inferGeckoVenue({ name: 'FOO-SOL', dexId: 'raydium' })).toBe('raydium');
  });

  it('maps existing gates onto machine-readable rejection reasons', () => {
    expect(mapFunnelRejection('lowLiquidity')).toBe('LIQUIDITY_TOO_LOW');
    expect(mapFunnelRejection('tooYoung')).toBe('TOKEN_TOO_YOUNG');
    expect(mapStrategyReason('overall_score_low')).toBe('SCORE_BELOW_THRESHOLD');
    expect(mapRiskRejection('maxOpenPositions')).toBe('MAX_OPEN_POSITIONS');
    expect(rejectionBucket('MAX_OPEN_POSITIONS')).toBe('position_capacity');
    expect(migrationProgressFromByte(0)).toBe('PRE_BONDING_CURVE');
    expect(migrationProgressFromByte(3)).toBe('CREATED_POOL');
  });

  it('keeps max open positions at exactly 5', () => {
    expect(env.MAX_SIMULTANEOUS_POSITIONS).toBe(5);
  });
});
