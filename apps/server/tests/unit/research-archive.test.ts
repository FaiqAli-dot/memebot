import { describe, expect, it } from 'vitest';

process.env.DATABASE_URL ??= 'postgresql://memebot:memebot@localhost:5432/memebot_test';

const ar = await import('../../src/archive/research-archive.js');
const { archiveHealth } = await import('../../src/archive/status.js');
const { CRITICAL_TABLES, OPERATIONAL_TABLES } = await import('../../src/db/data-classes.js');

describe('research archive safety', () => {
  it('only localhost archives are accepted; remote sources need TLS', () => {
    expect(ar.isLocalUrl('postgresql://u:p@localhost:5432/memebot_archive')).toBe(true);
    expect(ar.isLocalUrl('postgresql://u:p@127.0.0.1/memebot_archive')).toBe(true);
    expect(ar.isLocalUrl('postgresql://u:p@[::1]:5432/memebot_archive')).toBe(true);
    expect(ar.isLocalUrl('postgresql://u:p@db.example.com:5432/x')).toBe(false);
    expect(() => ar.connectArchive('postgresql://u:p@db.example.com:5432/x')).toThrow(/localhost/);
    expect(() => ar.connectSource('postgresql://u:p@proxy.rlwy.net:1234/railway?sslmode=disable', { readOnly: true })).toThrow(/TLS/);
    expect(() => ar.assertDistinct('postgresql://a@localhost/x', 'postgresql://b@localhost:5432/x')).toThrow();
  });

  it('no critical or operational table is ever archivable for deletion', () => {
    for (const t of [...CRITICAL_TABLES, ...OPERATIONAL_TABLES, 'token_outcome_summaries']) {
      expect(() => ar.assertArchivable(t)).toThrow();
    }
    for (const state of ['NORMAL', 'EMERGENCY_CLEANUP', 'STOP_NON_ESSENTIAL_WRITES'] as const) {
      for (const r of ar.archiveRules(new Date(), state, [], 1)) {
        expect([...CRITICAL_TABLES, ...OPERATIONAL_TABLES] as string[]).not.toContain(r.table);
      }
    }
  });

  it('compact research never drops below the minimum hot window', () => {
    const now = new Date('2026-10-04T12:00:00Z');
    const audits = ar.archiveRules(now, 'NORMAL', [], 1).find((r) => r.table === 'token_decision_audits')!;
    const floor = audits.rules.at(-1)!.params[0] as Date;
    expect(now.getTime() - floor.getTime()).toBe(ar.MIN_COMPACT_HOT_HOURS * 3_600_000);
  });

  it('a failed or stale-running archive is never healthy', () => {
    const now = new Date('2026-10-04T12:00:00Z');
    expect(archiveHealth(undefined, now)).toBe('ARCHIVE_NEVER_CONFIGURED');
    expect(archiveHealth({ status: 'FAILED', heartbeat_at: now }, now)).toBe('ARCHIVE_FAILED');
    expect(archiveHealth({ status: 'RUNNING', heartbeat_at: new Date(now.getTime() - 60_000) }, now)).toBe('ARCHIVE_RUNNING');
    expect(archiveHealth({ status: 'RUNNING', heartbeat_at: new Date(now.getTime() - 3_600_000) }, now)).toBe('ARCHIVE_FAILED');
    expect(archiveHealth({ status: 'SUCCEEDED', heartbeat_at: now }, now)).toBe('ARCHIVE_HEALTHY');
  });
});
