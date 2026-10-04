import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.METEORA_DBC_STALE_SILENCE_MINUTES = '30';
process.env.RAW_DATA_RETENTION_HOURS = '3';
process.env.RESEARCH_DATA_RETENTION_HOURS = '72';
process.env.EVENT_RETENTION_DAYS = '3';

describe('Meteora DBC discovery health metric', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('computeDbcHealthStatus: DISABLED / UNKNOWN / DEGRADED / STALE / OK', async () => {
    const { computeDbcHealthStatus } = await import(
      '../../src/intelligence/meteora-dbc-health.js'
    );
    const now = Date.UTC(2026, 0, 1, 12, 0, 0);

    expect(
      computeDbcHealthStatus({
        enabled: false,
        consecutiveFailures: 0,
        lastInitAt: now,
        now,
      }),
    ).toBe('DISABLED');

    expect(
      computeDbcHealthStatus({
        enabled: true,
        consecutiveFailures: 0,
        lastInitAt: null,
        now,
      }),
    ).toBe('UNKNOWN');

    expect(
      computeDbcHealthStatus({
        enabled: true,
        consecutiveFailures: 2,
        lastInitAt: null,
        now,
      }),
    ).toBe('DEGRADED');

    expect(
      computeDbcHealthStatus({
        enabled: true,
        consecutiveFailures: 5,
        lastInitAt: now - 60_000,
        now,
      }),
    ).toBe('DEGRADED');

    expect(
      computeDbcHealthStatus({
        enabled: true,
        consecutiveFailures: 0,
        lastInitAt: now - 31 * 60_000,
        now,
      }),
    ).toBe('STALE');

    expect(
      computeDbcHealthStatus({
        enabled: true,
        consecutiveFailures: 0,
        lastInitAt: now - 5 * 60_000,
        now,
      }),
    ).toBe('OK');

    expect(
      computeDbcHealthStatus({
        enabled: true,
        consecutiveFailures: 1,
        lastInitAt: now - 5 * 60_000,
        now,
      }),
    ).toBe('DEGRADED');
  });

  it('ignores Demo* fixtures and tracks rpc/datapi/realtime paths', async () => {
    vi.doMock('../../src/db/client.js', () => ({
      query: async () => ({ rows: [] }),
    }));

    const {
      recordDbcInitSeen,
      recordDbcRpcPollSuccess,
      recordDbcRpcError,
      resetMeteoraDbcHealthForTests,
      getMeteoraDbcHealth,
    } = await import('../../src/intelligence/meteora-dbc-health.js');
    resetMeteoraDbcHealthForTests();

    recordDbcRpcPollSuccess();
    recordDbcInitSeen({
      mint: 'DemoMeteoraDbc1111111111111111111111111',
      path: 'rpc',
      preMigration: true,
    });
    recordDbcInitSeen({
      mint: 'RealMint1111111111111111111111111111111',
      path: 'rpc',
      preMigration: true,
    });
    recordDbcInitSeen({
      mint: 'RealMint2222222222222222222222222222222',
      path: 'datapi',
      preMigration: false,
    });
    recordDbcInitSeen({
      mint: 'RealMint3333333333333333333333333333333',
      path: 'realtime',
      preMigration: true,
    });
    recordDbcRpcError(new Error('HTTP 429 Too Many Requests'));
    recordDbcRpcError(new Error('timeout'));

    const snap = await getMeteoraDbcHealth();
    expect(snap.lastSuccessfulRpcPollAt).not.toBeNull();
    expect(snap.lastRealDbcInitMint).toBe('RealMint3333333333333333333333333333333');
    expect(snap.discoveredLast1h).toBe(3);
    expect(snap.discoveredLast24h).toBe(3);
    expect(snap.viaRpcLast24h).toBe(1);
    expect(snap.viaDatapiLast24h).toBe(1);
    expect(snap.viaRealtimeLast24h).toBe(1);
    expect(snap.preMigrationLast24h).toBe(2);
    expect(snap.migratedLast24h).toBe(1);
    expect(snap.rpcErrorsLast1h).toBe(2);
    expect(snap.rpc429sLast1h).toBe(1);
    expect(snap.staleSilenceMinutes).toBeGreaterThan(0);
    expect(['OK', 'DEGRADED', 'UNKNOWN', 'STALE', 'DISABLED']).toContain(snap.status);
  });

});
