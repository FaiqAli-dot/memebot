/**
 * Dedicated Meteora Dynamic Bonding Curve (DBC) discovery.
 *
 * Discovers tokens WHILE STILL on the bonding curve (pre-migration), without
 * waiting for DAMM graduation and without relying on GeckoTerminal.
 *
 * Approach (keyless HTTP JSON-RPC only — no Solana web3 client dependency):
 *  1. Poll Solana JSON-RPC getSignaturesForAddress on the official DBC program
 *     and parse InitializeVirtualPool* instructions from recent txs.
 *  2. Optional realtime: raw WebSocket logsSubscribe on the DBC program; buffer
 *     initialize events for the next poll drain (polling remains the fallback).
 *  3. Enrich identity via public Meteora DBC datapi (no API key).
 *  4. Read pool account bytes via getAccountInfo to classify migration status.
 *
 * Official program: dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN
 * Docs: https://docs.meteora.ag/developer-guides/dbc
 */
import type { DataMode } from '@memebot/shared';
import { env } from '../../config/env.js';
import { logger } from '../../utils/logger.js';
import type { EnrichedDiscoveredToken, StreamTokenDiscoveryProvider } from './multi-source.js';
import {
  persistMeteoraDbcHealthDetails,
  recordDbcInitSeen,
  recordDbcRpcError,
  recordDbcRpcPollSuccess,
  type DbcDiscoveryPath,
} from '../../intelligence/meteora-dbc-health.js';

export const METEORA_DBC_PROGRAM_ID = 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN';
export const METEORA_DAMM_V2_PROGRAM_ID = 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG';
export const WSOL_MINT = 'So11111111111111111111111111111111111111112';

const INIT_IX_NAMES = new Set([
  'InitializeVirtualPoolWithSplToken',
  'InitializeVirtualPoolWithToken2022',
  'InitializeVirtualPoolWithToken2022TransferHook',
  // Anchor sometimes logs snake-ish variants via custom loggers
  'initialize_virtual_pool_with_spl_token',
  'initialize_virtual_pool_with_token2022',
  'initialize_virtual_pool_with_token2022_transfer_hook',
]);

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export type MeteoraDbcMigrationProgress =
  | 'PRE_BONDING_CURVE'
  | 'POST_BONDING_CURVE'
  | 'LOCKED_VESTING'
  | 'CREATED_POOL'
  | 'UNKNOWN';

export interface MeteoraDbcPoolState {
  poolAddress: string;
  baseMint: string;
  creator: string | null;
  config: string | null;
  quoteReserve: number | null;
  baseReserve: number | null;
  activationPoint: number | null;
  isMigrated: boolean;
  migrationProgress: MeteoraDbcMigrationProgress;
  poolType: number | null;
}

interface RpcSignature {
  signature: string;
  err: unknown;
  blockTime?: number | null;
}

interface BufferedDiscovery {
  token: EnrichedDiscoveredToken;
  seenAt: number;
}

function isSolAddress(addr: string): boolean {
  return BASE58_RE.test(addr);
}

function rpcUrl(): string {
  return env.METEORA_DBC_RPC_URL?.trim() || env.SOLANA_RPC_URL;
}

async function rpcCall<T>(method: string, params: unknown[]): Promise<T | null> {
  try {
    const res = await fetch(rpcUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(env.METEORA_DBC_RPC_TIMEOUT_MS),
    });
    if (!res.ok) {
      const err = new Error(`Solana RPC HTTP ${res.status}`);
      recordDbcRpcError(err);
      throw err;
    }
    const body = (await res.json()) as { result?: T; error?: { message?: string } };
    if (body.error) {
      const err = new Error(body.error.message ?? 'Solana RPC error');
      recordDbcRpcError(err);
      throw err;
    }
    return body.result ?? null;
  } catch (err) {
    if (err instanceof Error && !/Solana RPC/.test(err.message)) {
      recordDbcRpcError(err);
    }
    throw err;
  }
}

/** Anchor account: 8-byte discriminator + PoolState (see Meteora virtual_pool.rs). */
export function parseVirtualPoolAccountData(
  dataBase64: string,
  poolAddress: string,
): MeteoraDbcPoolState | null {
  const buf = Buffer.from(dataBase64, 'base64');
  // Minimum: disc(8) + vol(64) + 5 pubkeys(160) + reserves/fees/price/activation
  if (buf.length < 309) return null;

  const readPubkey = (offset: number) => {
    // base58-encode 32 raw account bytes (no external Solana client)
    return base58Encode(buf.subarray(offset, offset + 32));
  };
  const readU64 = (offset: number) => Number(buf.readBigUInt64LE(offset));

  const config = readPubkey(72);
  const creator = readPubkey(104);
  const baseMint = readPubkey(136);
  if (!isSolAddress(baseMint)) return null;

  const baseReserve = readU64(232);
  const quoteReserve = readU64(240);
  const activationPoint = readU64(296);
  const poolType = buf[304] ?? 0;
  const isMigrated = (buf[305] ?? 0) !== 0;
  const progressByte = buf[308] ?? 0;
  const migrationProgress = migrationProgressFromByte(progressByte);

  return {
    poolAddress,
    baseMint,
    creator: isSolAddress(creator) ? creator : null,
    config: isSolAddress(config) ? config : null,
    quoteReserve,
    baseReserve,
    activationPoint,
    isMigrated,
    migrationProgress,
    poolType,
  };
}

export function migrationProgressFromByte(b: number): MeteoraDbcMigrationProgress {
  switch (b) {
    case 0:
      return 'PRE_BONDING_CURVE';
    case 1:
      return 'POST_BONDING_CURVE';
    case 2:
      return 'LOCKED_VESTING';
    case 3:
      return 'CREATED_POOL';
    default:
      return 'UNKNOWN';
  }
}

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function base58Encode(bytes: Uint8Array): string {
  if (bytes.length === 0) return '';
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;

  const input = bytes.subarray(zeros);
  const digits: number[] = [0];
  for (let i = 0; i < input.length; i++) {
    let carry = input[i]!;
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j]! << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }

  let out = '1'.repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i--) {
    out += BASE58_ALPHABET[digits[i]!]!;
  }
  return out;
}

function activationToDate(activationPoint: number | null | undefined): Date | null {
  if (activationPoint == null || !Number.isFinite(activationPoint) || activationPoint <= 0) {
    return null;
  }
  // activationType can be slot or unix; unix seconds for recent launches are ~1.7e9
  if (activationPoint > 1_000_000_000 && activationPoint < 4_000_000_000) {
    return new Date(activationPoint * 1000);
  }
  return null;
}

function createdAtToDate(createdAt: number | null | undefined): Date | null {
  if (createdAt == null || !Number.isFinite(createdAt) || createdAt <= 0) return null;
  if (createdAt > 1e12) return new Date(createdAt);
  if (createdAt > 1e9) return new Date(createdAt * 1000);
  return null;
}

export function toEnrichedFromPoolState(
  state: MeteoraDbcPoolState,
  meta?: {
    symbol?: string;
    name?: string;
    decimals?: number;
    createdAt?: Date | null;
    quoteMint?: string | null;
    discoveryPath?: DbcDiscoveryPath;
  },
): EnrichedDiscoveredToken {
  const preMigration = !state.isMigrated && state.migrationProgress === 'PRE_BONDING_CURVE';
  const migrating =
    !state.isMigrated &&
    (state.migrationProgress === 'POST_BONDING_CURVE' ||
      state.migrationProgress === 'LOCKED_VESTING');
  const migrated = state.isMigrated || state.migrationProgress === 'CREATED_POOL';
  return {
    chain: 'solana',
    address: state.baseMint,
    symbol: meta?.symbol?.slice(0, 32) || state.baseMint.slice(0, 6),
    name: meta?.name?.slice(0, 64) || meta?.symbol || 'Meteora DBC Token',
    decimals: meta?.decimals ?? 9,
    createdAt: meta?.createdAt ?? activationToDate(state.activationPoint),
    discoverySource: 'METEORA_DBC',
    poolAddress: state.poolAddress,
    quoteToken: meta?.quoteMint ?? WSOL_MINT,
    creatorWallet: state.creator,
    dexVenue: migrated ? 'meteora_damm' : 'meteora_dbc',
    firstLiquidityAt: meta?.createdAt ?? activationToDate(state.activationPoint),
    migrationAt: migrated ? new Date() : null,
    metadata: {
      meteoraDbc: true,
      launchMechanism: 'meteora_dbc',
      dbcStatus: state.migrationProgress,
      migrationStatus: migrated ? 'MIGRATED' : migrating ? 'MIGRATING' : 'NOT_MIGRATED',
      dbcPoolAddress: state.poolAddress,
      dbcConfig: state.config,
      preMigration,
      quoteReserve: state.quoteReserve,
      baseReserve: state.baseReserve,
      postMigrationVenue: migrated ? 'meteora_damm' : null,
      discoveryPath: meta?.discoveryPath ?? 'rpc',
    },
  };
}

interface DatapiPool {
  address?: string;
  created_at?: number;
  creator?: string;
  pool_config_address?: string;
  pool_config?: { pool_type?: number };
  token_x?: { address?: string; name?: string; symbol?: string; decimals?: number };
  token_y?: { address?: string; name?: string; symbol?: string; decimals?: number };
}

export async function fetchDatapiPool(poolAddress: string): Promise<DatapiPool | null> {
  const base = env.METEORA_DBC_DATAPI_BASE_URL.replace(/\/$/, '');
  try {
    const res = await fetch(`${base}/pools/${poolAddress}`, {
      signal: AbortSignal.timeout(10_000),
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return null;
    return (await res.json()) as DatapiPool;
  } catch {
    return null;
  }
}

export async function fetchDatapiRecentPools(pageSize = 50): Promise<DatapiPool[]> {
  const base = env.METEORA_DBC_DATAPI_BASE_URL.replace(/\/$/, '');
  try {
    const res = await fetch(`${base}/pools?page=1&page_size=${pageSize}`, {
      signal: AbortSignal.timeout(10_000),
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { data?: DatapiPool[] };
    return body.data ?? [];
  } catch (err) {
    logger.warn({ err }, 'Meteora DBC datapi list failed');
    return [];
  }
}

function extractInitFromLogs(logs: string[]): string | null {
  for (const line of logs) {
    const idx = line.indexOf('Instruction:');
    if (idx < 0) continue;
    const name = line.slice(idx + 'Instruction:'.length).trim();
    if (INIT_IX_NAMES.has(name)) return name;
  }
  return null;
}

/**
 * Initialize ix account order (IDL):
 * config, pool_authority, creator, base_mint, quote_mint, pool, ...
 */
export function extractAccountsFromInitTx(tx: {
  transaction?: {
    message?: {
      accountKeys?: Array<string | { pubkey: string }>;
      instructions?: Array<{ programIdIndex?: number; accounts?: number[] }>;
    };
  };
  meta?: {
    logMessages?: string[];
    innerInstructions?: Array<{
      instructions?: Array<{ programIdIndex?: number; accounts?: number[] }>;
    }>;
  };
}): { baseMint: string; pool: string; creator: string | null; config: string | null; quoteMint: string | null } | null {
  const logs = tx.meta?.logMessages ?? [];
  if (!extractInitFromLogs(logs)) return null;

  const keys = (tx.transaction?.message?.accountKeys ?? []).map((k) =>
    typeof k === 'string' ? k : k.pubkey,
  );
  const programIdx = keys.findIndex((k) => k === METEORA_DBC_PROGRAM_ID);
  if (programIdx < 0) return null;

  const allIxs = [
    ...(tx.transaction?.message?.instructions ?? []),
    ...((tx.meta?.innerInstructions ?? []).flatMap((ii) => ii.instructions ?? []) ?? []),
  ];

  for (const ix of allIxs) {
    if (ix.programIdIndex !== programIdx) continue;
    const accs = ix.accounts ?? [];
    if (accs.length < 6) continue;
    const config = keys[accs[0]!] ?? null;
    const creator = keys[accs[2]!] ?? null;
    const baseMint = keys[accs[3]!] ?? null;
    const quoteMint = keys[accs[4]!] ?? null;
    const pool = keys[accs[5]!] ?? null;
    if (baseMint && pool && isSolAddress(baseMint) && isSolAddress(pool)) {
      return {
        baseMint,
        pool,
        creator: creator && isSolAddress(creator) ? creator : null,
        config: config && isSolAddress(config) ? config : null,
        quoteMint: quoteMint && isSolAddress(quoteMint) ? quoteMint : null,
      };
    }
  }
  return null;
}

export class MeteoraDbcDiscoveryProvider implements StreamTokenDiscoveryProvider {
  readonly name = 'meteora-dbc';
  readonly dataMode: DataMode = 'live';

  private cursorSignature: string | null = null;
  private readonly realtimeBuffer: BufferedDiscovery[] = [];
  private ws: WebSocket | null = null;
  private wsConnected = false;
  private seenMints = new Set<string>();

  async subscribe(): Promise<void> {
    if (!env.METEORA_DBC_ENABLED) return;
    if (!env.METEORA_DBC_REALTIME_ENABLED) return;
    if (this.wsConnected || this.ws) return;

    const wsUrl = rpcUrl().replace(/^http/, 'ws');
    try {
      const { WebSocket: WsClient } = await import('ws');
      const socket = new WsClient(wsUrl);
      this.ws = socket as unknown as WebSocket;
      socket.on('open', () => {
        this.wsConnected = true;
        socket.send(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'logsSubscribe',
            params: [{ mentions: [METEORA_DBC_PROGRAM_ID] }, { commitment: 'confirmed' }],
          }),
        );
        logger.info('Meteora DBC realtime logsSubscribe active');
      });
      socket.on('message', (data) => {
        try {
          const msg = JSON.parse(String(data)) as {
            method?: string;
            params?: { result?: { value?: { signature?: string; err?: unknown; logs?: string[] } } };
          };
          if (msg.method !== 'logsNotification') return;
          const value = msg.params?.result?.value;
          if (!value || value.err) return;
          if (!extractInitFromLogs(value.logs ?? [])) return;
          void this.ingestSignature(value.signature!, null, 'realtime');
        } catch (err) {
          logger.warn({ err }, 'Meteora DBC realtime message parse failed');
        }
      });
      socket.on('close', () => {
        this.wsConnected = false;
        this.ws = null;
      });
      socket.on('error', () => {
        this.wsConnected = false;
      });
    } catch (err) {
      logger.warn({ err }, 'Meteora DBC realtime subscribe failed; polling fallback remains');
    }
  }

  async unsubscribe(): Promise<void> {
    try {
      (this.ws as unknown as { close?: () => void } | null)?.close?.();
    } catch {
      /* ignore */
    }
    this.ws = null;
    this.wsConnected = false;
  }

  async getRecentTokens(): Promise<EnrichedDiscoveredToken[]> {
    if (!env.METEORA_DBC_ENABLED) return [];

    const out = new Map<string, EnrichedDiscoveredToken>();

    // Drain realtime buffer first
    while (this.realtimeBuffer.length > 0) {
      const item = this.realtimeBuffer.shift()!;
      out.set(item.token.address, item.token);
    }

    try {
      const fromRpc = await this.pollRpcSignatures();
      for (const t of fromRpc) out.set(t.address, t);
    } catch (err) {
      logger.warn({ err }, 'Meteora DBC RPC discovery failed');
      recordDbcRpcError(err);
    }

    try {
      const fromDatapi = await this.pollDatapiFallback();
      for (const t of fromDatapi) {
        if (!out.has(t.address)) out.set(t.address, t);
      }
    } catch (err) {
      logger.warn({ err }, 'Meteora DBC datapi fallback failed');
    }

    const tokens = [...out.values()].slice(0, env.METEORA_DBC_MAX_PER_POLL);
    await persistMeteoraDbcHealthDetails().catch(() => undefined);
    return tokens;
  }

  private async pollRpcSignatures(): Promise<EnrichedDiscoveredToken[]> {
    const sigs = await rpcCall<RpcSignature[]>('getSignaturesForAddress', [
      METEORA_DBC_PROGRAM_ID,
      { limit: env.METEORA_DBC_SIGNATURE_LIMIT },
    ]);
    recordDbcRpcPollSuccess();
    if (!sigs?.length) return [];

    const fresh: RpcSignature[] = [];
    for (const s of sigs) {
      if (this.cursorSignature && s.signature === this.cursorSignature) break;
      if (s.err) continue;
      fresh.push(s);
    }
    this.cursorSignature = sigs[0]!.signature;

    const batch = fresh.slice(0, env.METEORA_DBC_TX_FETCH_LIMIT).reverse();
    const tokens: EnrichedDiscoveredToken[] = [];
    for (const s of batch) {
      const token = await this.ingestSignature(s.signature, s.blockTime ?? null, 'rpc');
      if (token) tokens.push(token);
    }
    return tokens;
  }

  private async ingestSignature(
    signature: string,
    blockTime: number | null,
    path: DbcDiscoveryPath,
  ): Promise<EnrichedDiscoveredToken | null> {
    try {
      const tx = await rpcCall<{
        transaction?: {
          message?: {
            accountKeys?: Array<string | { pubkey: string }>;
            instructions?: Array<{ programIdIndex?: number; accounts?: number[] }>;
          };
        };
        meta?: {
          logMessages?: string[];
          innerInstructions?: Array<{
            instructions?: Array<{ programIdIndex?: number; accounts?: number[] }>;
          }>;
        };
        blockTime?: number | null;
      }>('getTransaction', [
        signature,
        { encoding: 'json', maxSupportedTransactionVersion: 0, commitment: 'confirmed' },
      ]);
      if (!tx) return null;
      const extracted = extractAccountsFromInitTx(tx);
      if (!extracted) return null;
      if (this.seenMints.has(extracted.baseMint)) return null;

      let state: MeteoraDbcPoolState | null = await this.fetchPoolState(extracted.pool);
      if (!state) {
        state = {
          poolAddress: extracted.pool,
          baseMint: extracted.baseMint,
          creator: extracted.creator,
          config: extracted.config,
          quoteReserve: null,
          baseReserve: null,
          activationPoint: blockTime ?? tx.blockTime ?? null,
          isMigrated: false,
          migrationProgress: 'PRE_BONDING_CURVE',
          poolType: null,
        };
      }

      // Only surface pre-migration / still-on-curve by default; migrated pools are
      // still recorded with venue meteora_damm when we do see an init historically.
      const meta = await this.enrichFromDatapi(extracted.pool, extracted.baseMint);
      const created =
        meta.createdAt ??
        (blockTime || tx.blockTime ? new Date((blockTime ?? tx.blockTime)! * 1000) : null);
      const token = toEnrichedFromPoolState(state, {
        ...meta,
        createdAt: created,
        discoveryPath: path,
      });
      recordDbcInitSeen({
        mint: extracted.baseMint,
        path,
        preMigration: Boolean(token.metadata?.preMigration),
      });
      this.seenMints.add(extracted.baseMint);
      if (this.seenMints.size > 5_000) {
        this.seenMints = new Set([...this.seenMints].slice(-2_500));
      }
      if (path === 'realtime') {
        this.realtimeBuffer.push({ token, seenAt: Date.now() });
      }
      return token;
    } catch (err) {
      logger.warn({ err, signature }, 'Meteora DBC tx ingest failed');
      return null;
    }
  }

  private async fetchPoolState(poolAddress: string): Promise<MeteoraDbcPoolState | null> {
    try {
      const info = await rpcCall<{ value?: { data?: [string, string] | string } }>(
        'getAccountInfo',
        [poolAddress, { encoding: 'base64', commitment: 'confirmed' }],
      );
      const data = info?.value?.data;
      const b64 = Array.isArray(data) ? data[0] : typeof data === 'string' ? data : null;
      if (!b64) return null;
      return parseVirtualPoolAccountData(b64, poolAddress);
    } catch {
      return null;
    }
  }

  private async enrichFromDatapi(
    poolAddress: string,
    baseMint: string,
  ): Promise<{
    symbol?: string;
    name?: string;
    decimals?: number;
    createdAt?: Date | null;
    quoteMint?: string | null;
  }> {
    const pool = await fetchDatapiPool(poolAddress);
    if (!pool) return {};
    const base =
      pool.token_x?.address === baseMint
        ? pool.token_x
        : pool.token_y?.address === baseMint
          ? pool.token_y
          : pool.token_x;
    const quote =
      pool.token_x?.address === baseMint
        ? pool.token_y
        : pool.token_y?.address === baseMint
          ? pool.token_x
          : pool.token_y;
    return {
      symbol: base?.symbol,
      name: base?.name,
      decimals: base?.decimals,
      createdAt: createdAtToDate(pool.created_at),
      quoteMint: quote?.address ?? null,
    };
  }

  /**
   * Datapi fallback: scan a page of pools, resolve on-chain state, keep those
   * still on the bonding curve (or newly seen). Failures are isolated.
   */
  private async pollDatapiFallback(): Promise<EnrichedDiscoveredToken[]> {
    if (!env.METEORA_DBC_DATAPI_ENABLED) return [];
    const pools = await fetchDatapiRecentPools(env.METEORA_DBC_DATAPI_PAGE_SIZE);
    const out: EnrichedDiscoveredToken[] = [];
    const now = Date.now();
    const maxAgeMs = env.METEORA_DBC_DATAPI_MAX_AGE_HOURS * 3_600_000;

    for (const pool of pools) {
      const poolAddress = pool.address;
      const baseMint = pool.token_x?.address;
      if (!poolAddress || !baseMint || !isSolAddress(baseMint) || !isSolAddress(poolAddress)) {
        continue;
      }
      if (baseMint === WSOL_MINT) continue;
      if (this.seenMints.has(baseMint)) continue;

      const created = createdAtToDate(pool.created_at);
      // Skip obviously stale catalog rows when timestamp is present
      if (created && now - created.getTime() > maxAgeMs) continue;

      let state = await this.fetchPoolState(poolAddress);
      if (!state) {
        // Without account state, only accept recent catalog rows as pre-migration candidates
        if (!created || now - created.getTime() > 6 * 3_600_000) continue;
        state = {
          poolAddress,
          baseMint,
          creator: pool.creator && isSolAddress(pool.creator) ? pool.creator : null,
          config:
            pool.pool_config_address && isSolAddress(pool.pool_config_address)
              ? pool.pool_config_address
              : null,
          quoteReserve: null,
          baseReserve: null,
          activationPoint: created ? Math.floor(created.getTime() / 1000) : null,
          isMigrated: false,
          migrationProgress: 'PRE_BONDING_CURVE',
          poolType: pool.pool_config?.pool_type ?? null,
        };
      }

      // Prefer still-on-curve; also keep migrated for ledger continuity with correct venue
      if (state.isMigrated && state.migrationProgress === 'CREATED_POOL') {
        // Still emit so discovery ledger can record venue transition, but mark migrated
      }

      const token = toEnrichedFromPoolState(state, {
        symbol: pool.token_x?.symbol,
        name: pool.token_x?.name,
        decimals: pool.token_x?.decimals,
        createdAt: created,
        quoteMint: pool.token_y?.address ?? WSOL_MINT,
        discoveryPath: 'datapi',
      });
      recordDbcInitSeen({
        mint: baseMint,
        path: 'datapi',
        preMigration: Boolean(token.metadata?.preMigration),
      });
      this.seenMints.add(baseMint);
      out.push(token);
      if (out.length >= env.METEORA_DBC_MAX_PER_POLL) break;
    }
    return out;
  }
}
