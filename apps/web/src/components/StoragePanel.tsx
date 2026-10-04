import { useCallback, useEffect, useState } from 'react';
import type { StorageReport, StorageState } from '@memebot/shared';
import { api } from '../lib/api';

const POLL_MS = 60_000;

const mb = (bytes: number | null | undefined) => (bytes == null ? '—' : `${(bytes / 1048576).toFixed(1)} MB`);
const num = (n: number | null | undefined) => (n == null ? '—' : n.toLocaleString());

const STATE_LABEL: Record<StorageState, string> = {
  NORMAL: 'NORMAL',
  WARNING: 'WARNING',
  AGGRESSIVE_CLEANUP: 'AGGRESSIVE CLEANUP',
  EMERGENCY_CLEANUP: 'EMERGENCY CLEANUP',
  STOP_NON_ESSENTIAL_WRITES: 'RESEARCH WRITES PAUSED',
};

export function storageStateClass(state: StorageState): string {
  if (state === 'NORMAL') return 'pos';
  if (state === 'WARNING') return 'storage-warn';
  return 'neg';
}

function Row({ label, value, className }: { label: string; value: string; className?: string }) {
  return (
    <div className="funnel-row">
      <span>{label}</span>
      <span className={className}>{value}</span>
    </div>
  );
}

export function useStorageReport(): { data: StorageReport | null; error: string | null } {
  const [data, setData] = useState<StorageReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setData(await api.storage());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);
  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(id);
  }, [load]);
  return { data, error };
}

/** Shown above the dashboard tabs whenever storage is not NORMAL. */
export function StorageBanner() {
  const { data } = useStorageReport();
  if (!data || data.state === 'NORMAL') return null;
  return (
    <div className={`storage-banner ${storageStateClass(data.state)}`}>
      Database storage {STATE_LABEL[data.state]}: {mb(data.usedBytes)} of {data.thresholdsMb.limit} MB (
      {data.usedPct.toFixed(0)}%). Trading continues; older research data is being trimmed.
    </div>
  );
}

export function StoragePanel() {
  const { data, error } = useStorageReport();
  if (!data) {
    return (
      <div className="panel readiness" style={{ marginBottom: '0.75rem' }}>
        <h2>Database storage</h2>
        <div style={{ color: 'var(--muted)' }}>{error ?? 'Loading…'}</div>
      </div>
    );
  }
  const t = data.thresholdsMb;
  const pctUsed = Math.min(100, data.usedPct);
  const last = data.lastCleanup;
  return (
    <div className="panel readiness week1" style={{ marginBottom: '0.75rem' }}>
      <h2>
        Database storage{' '}
        <span className={storageStateClass(data.state)}>{STATE_LABEL[data.state]}</span>
      </h2>
      <div className="storage-bar" title={`${pctUsed.toFixed(1)}% of ${t.limit} MB`}>
        <div className={`storage-bar-fill ${storageStateClass(data.state)}`} style={{ width: `${pctUsed}%` }} />
      </div>
      <div className="meta" style={{ marginBottom: '0.5rem' }}>
        {mb(data.usedBytes)} of {t.limit} MB ({data.usedPct.toFixed(1)}%) · warning {t.warning} · aggressive{' '}
        {t.aggressive} · emergency {t.emergency} · research writes pause above {t.stopWrites} MB
      </div>

      <div className="grid grid-3">
        <div>
          <h3>Usage</h3>
          <Row label="This database" value={mb(data.databaseBytes)} />
          <Row label="All databases on volume" value={mb(data.allDatabasesBytes)} />
          <Row label="Write-ahead log" value={data.walBytes == null ? 'not measurable' : mb(data.walBytes)} />
          <Row
            label={`Est. volume (+${data.unobservedOverheadMb} MB unseen overhead)`}
            value={`${mb(data.estimatedVolumeBytes)} (${data.estimatedVolumePct.toFixed(0)}%)`}
            className={data.estimatedVolumePct >= 85 ? 'neg' : undefined}
          />
          <Row
            label="Growth"
            value={data.growthMbPerHour == null ? '—' : `${data.growthMbPerHour.toFixed(1)} MB/h`}
          />
          <Row
            label="Research writes"
            value={data.researchWritesSuppressed ? 'PAUSED' : 'active'}
            className={data.researchWritesSuppressed ? 'neg' : 'pos'}
          />
          <Row label="Raw snapshot rows" value={num(data.rawSnapshotRows)} />
          <Row label="Compact research rows" value={num(data.compactResearchRows)} />
          <Row
            label="Compact research size"
            value={`${mb(data.compactResearchLiveBytes)} / ${data.compactResearchBudgetMb} MB budget`}
          />
          <Row
            label="Oldest raw snapshot"
            value={data.rawDataAgeMinutes == null ? '—' : `${data.rawDataAgeMinutes.toFixed(0)} min old`}
          />
        </div>
        <div>
          <h3>Cleanup</h3>
          <Row label="Last cleanup" value={last?.finishedAt ? new Date(last.finishedAt).toLocaleTimeString() : '—'} />
          <Row label="Rows deleted (last run)" value={num(last?.rowsDeleted)} />
          <Row label="Run at state" value={last?.state ?? '—'} />
          <Row label="Next scheduled" value={new Date(data.nextCleanupAt).toLocaleTimeString()} />
          <Row label="Interval" value={`${Math.round(data.cleanupIntervalMs / 60_000)} min (+1 min guard)`} />
        </div>
        <div>
          <h3>Reclaimable (bloat)</h3>
          {data.bloat.length === 0 ? (
            <div className="meta">None worth compacting.</div>
          ) : (
            data.bloat.map((b) => <Row key={b.table} label={b.table} value={mb(b.reclaimableBytes)} />)
          )}
        </div>
      </div>

      <div className="grid grid-2" style={{ marginTop: '0.75rem' }}>
        <div>
          <h3>Largest tables</h3>
          <table>
            <thead>
              <tr>
                <th>Table</th>
                <th>Class</th>
                <th>Total</th>
                <th>Index</th>
                <th>Rows</th>
                <th>Dead</th>
              </tr>
            </thead>
            <tbody>
              {data.largestTables.map((r) => (
                <tr key={r.table}>
                  <td>{r.table}</td>
                  <td>{r.dataClass?.toLowerCase().replace('_', ' ') ?? '—'}</td>
                  <td>{mb(r.totalBytes)}</td>
                  <td>{mb(r.indexBytes)}</td>
                  <td>{num(r.liveRows)}</td>
                  <td>{num(r.deadRows)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div>
          <h3>Largest indexes</h3>
          <table>
            <thead>
              <tr>
                <th>Index</th>
                <th>Table</th>
                <th>Size</th>
              </tr>
            </thead>
            <tbody>
              {data.largestIndexes.map((r) => (
                <tr key={r.index}>
                  <td>{r.index}</td>
                  <td>{r.table}</td>
                  <td>{mb(r.bytes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <h3 style={{ marginTop: '0.75rem' }}>Retention at current state</h3>
      <table>
        <tbody>
          {data.retention
            .filter((r) => !r.permanent)
            .map((r) => (
              <tr key={r.table}>
                <td>{r.table}</td>
                <td>{r.retention}</td>
              </tr>
            ))}
        </tbody>
      </table>
      <div className="meta">Never pruned: {data.permanentTables.join(', ')}</div>
    </div>
  );
}
