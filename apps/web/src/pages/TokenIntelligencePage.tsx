import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, money, pct } from '../lib/api';

type IntelRow = {
  tokenId: string;
  address: string;
  symbol: string;
  name: string;
  ageMinutes: number | null;
  marketCap: number | null;
  liquidity: number | null;
  volume: number | null;
  venue: string | null;
  discoverySource: string | null;
  discoverySources?: string[];
  firstSeen: string;
  status: string;
  signalScore: number | null;
  riskStatus: string | null;
  tradeStatus: string | null;
  rejectionReason: string | null;
  dbcStatus?: string | null;
  migrationStatus?: string | null;
};

type Summary = {
  tokensDiscovered: number;
  uniqueTokens: number;
  currentlyTracked: number;
  eligible: number;
  signalsGenerated: number;
  tradesOpened: number;
  rejected: number;
  positionCapRejections: number;
  rejectionBreakdown: Record<string, number>;
};

const EMPTY_SUMMARY: Summary = {
  tokensDiscovered: 0,
  uniqueTokens: 0,
  currentlyTracked: 0,
  eligible: 0,
  signalsGenerated: 0,
  tradesOpened: 0,
  rejected: 0,
  positionCapRejections: 0,
  rejectionBreakdown: {},
};

function ageLabel(mins: number | null): string {
  if (mins == null || !Number.isFinite(mins)) return '—';
  if (mins < 60) return `${Math.max(0, Math.round(mins))}m`;
  if (mins < 1440) return `${(mins / 60).toFixed(1)}h`;
  return `${(mins / 1440).toFixed(1)}d`;
}

export function TokenIntelligencePage() {
  const [summary, setSummary] = useState<Summary>(EMPTY_SUMMARY);
  const [rows, setRows] = useState<IntelRow[]>([]);
  const [total, setTotal] = useState(0);
  const [sources, setSources] = useState<Record<string, unknown>[]>([]);
  const [meteoraDbc, setMeteoraDbc] = useState<Record<string, unknown> | null>(null);
  const [storage, setStorage] = useState<Record<string, unknown> | null>(null);
  const [missed, setMissed] = useState<{
    falseNegatives: Record<string, unknown>[];
    successfulRejections: Record<string, unknown>[];
  }>({ falseNegatives: [], successfulRejections: [] });
  const [selected, setSelected] = useState<Record<string, unknown> | null>(null);
  const [q, setQ] = useState('');
  const [discoverySource, setDiscoverySource] = useState('');
  const [venue, setVenue] = useState('');
  const [status, setStatus] = useState('');
  const [rejectionReason, setRejectionReason] = useState('');
  const [traded, setTraded] = useState<'all' | 'yes' | 'no'>('all');
  const [signalGenerated, setSignalGenerated] = useState<'all' | 'yes' | 'no'>('all');
  const [bucketFilter, setBucketFilter] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      setError(null);
      const qs = new URLSearchParams({ limit: '80' });
      if (q) qs.set('q', q);
      if (discoverySource) qs.set('discoverySource', discoverySource);
      if (venue) qs.set('venue', venue);
      if (status) qs.set('status', status);
      if (rejectionReason) qs.set('rejectionReason', rejectionReason);
      if (traded !== 'all') qs.set('traded', traded);
      if (signalGenerated !== 'all') qs.set('signalGenerated', signalGenerated);

      const [dash, list] = await Promise.all([
        api.intelligence(),
        api.intelligenceTokens(`?${qs}`),
      ]);
      setSummary((dash.summary as Summary) ?? EMPTY_SUMMARY);
      setSources((dash.sources as Record<string, unknown>[]) ?? []);
      setMeteoraDbc((dash.meteoraDbc as Record<string, unknown>) ?? null);
      setStorage((dash.storage as Record<string, unknown>) ?? null);
      setMissed(
        (dash.missed as {
          falseNegatives: Record<string, unknown>[];
          successfulRejections: Record<string, unknown>[];
        }) ?? { falseNegatives: [], successfulRejections: [] },
      );
      setRows(list.rows as IntelRow[]);
      setTotal(list.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    void load();
  }, [discoverySource, venue, status, rejectionReason, traded, signalGenerated]);

  const visibleRows = useMemo(() => {
    if (!bucketFilter) return rows;
    const map: Record<string, string[]> = {
      liquidity: ['LIQUIDITY_TOO_LOW', 'LIQUIDITY_UNKNOWN', 'LIQUIDITY_RISK'],
      age: ['TOKEN_TOO_YOUNG', 'TOKEN_TOO_OLD'],
      market_cap: ['MARKET_CAP_TOO_LOW', 'MARKET_CAP_TOO_HIGH'],
      volume: ['INSUFFICIENT_VOLUME'],
      risk: ['HIGH_RISK', 'VOLATILITY_EXTREME', 'RISK_STATE_BLOCKED'],
      signal_threshold: ['SCORE_BELOW_THRESHOLD', 'STRATEGY_REJECTED', 'EXPECTED_VALUE_TOO_LOW'],
      position_capacity: [
        'MAX_OPEN_POSITIONS',
        'INSUFFICIENT_CAPACITY',
        'INSUFFICIENT_CASH',
        'POSITION_SIZE_TOO_LARGE',
        'CORRELATED_EXPOSURE',
      ],
    };
    const codes = map[bucketFilter] ?? [];
    return rows.filter((r) => r.rejectionReason && codes.includes(r.rejectionReason));
  }, [rows, bucketFilter]);

  async function openDetail(tokenId: string) {
    const detail = await api.intelligenceToken(tokenId);
    setSelected(detail);
  }

  const breakdown = summary.rejectionBreakdown ?? {};

  return (
    <div className="page">
      <div className="panel">
        <h2>Token Intelligence</h2>
        <p className="muted">
          Persistent discovery ledger and decision audit trail. Observation only — does not change
          strategy.
        </p>
        {error && <div className="badge danger">{error}</div>}

        <div className="stat-grid" style={{ marginTop: '0.75rem' }}>
          {[
            ['Discovered', summary.tokensDiscovered],
            ['Unique', summary.uniqueTokens],
            ['Tracked', summary.currentlyTracked],
            ['Eligible', summary.eligible],
            ['Signals', summary.signalsGenerated],
            ['Traded', summary.tradesOpened],
            ['Rejected', summary.rejected],
            ['Pos-cap', summary.positionCapRejections],
          ].map(([label, value]) => (
            <div key={String(label)} className="stat">
              <div className="stat-label">{label}</div>
              <div className="stat-value">{value as number}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="panel">
        <h3>Rejection breakdown</h3>
        <div className="filters">
          {Object.entries(breakdown).map(([k, v]) => (
            <button
              key={k}
              type="button"
              className={bucketFilter === k ? 'badge run' : 'badge'}
              onClick={() => setBucketFilter(bucketFilter === k ? '' : k)}
            >
              {k}: {v}
            </button>
          ))}
        </div>
      </div>

      <div className="panel">
        <h3>Token table</h3>
        <div className="filters">
          <input
            placeholder="Search name / symbol / address"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void load();
            }}
          />
          <select value={discoverySource} onChange={(e) => setDiscoverySource(e.target.value)}>
            <option value="">All sources</option>
            <option value="METEORA_DBC">meteora_dbc</option>
            <option value="DEXSCREENER_NEW_PAIR">dexscreener_profiles</option>
            <option value="DEXSCREENER_BOOST">dexscreener_boosts</option>
            <option value="GECKO_NEW_POOL">geckoterminal_new_pools</option>
          </select>
          <select value={venue} onChange={(e) => setVenue(e.target.value)}>
            <option value="">All venues</option>
            <option value="meteora_dbc">meteora_dbc</option>
            <option value="meteora_damm">meteora_damm</option>
            <option value="raydium">raydium</option>
            <option value="pump">pump</option>
            <option value="unknown">unknown</option>
          </select>
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All statuses</option>
            <option value="DISCOVERED">DISCOVERED</option>
            <option value="TRACKED">TRACKED</option>
            <option value="ELIGIBILITY">ELIGIBILITY</option>
            <option value="SIGNAL">SIGNAL</option>
            <option value="RISK_GATE">RISK_GATE</option>
            <option value="POSITION_CAPACITY">POSITION_CAPACITY</option>
            <option value="TRADED">TRADED</option>
          </select>
          <select value={traded} onChange={(e) => setTraded(e.target.value as 'all' | 'yes' | 'no')}>
            <option value="all">Traded: all</option>
            <option value="yes">Traded</option>
            <option value="no">Not traded</option>
          </select>
          <select
            value={signalGenerated}
            onChange={(e) => setSignalGenerated(e.target.value as 'all' | 'yes' | 'no')}
          >
            <option value="all">Signal: all</option>
            <option value="yes">Signal generated</option>
            <option value="no">No signal</option>
          </select>
          <input
            placeholder="Rejection reason"
            value={rejectionReason}
            onChange={(e) => setRejectionReason(e.target.value)}
          />
          <button type="button" onClick={() => void load()}>
            Apply
          </button>
        </div>
        <div className="muted" style={{ marginBottom: '0.5rem' }}>
          Showing {visibleRows.length} / {total}
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Token</th>
                <th>Symbol</th>
                <th>Age</th>
                <th>MC</th>
                <th>Liq</th>
                <th>Vol</th>
                <th>Venue</th>
                <th>Source</th>
                <th>First seen</th>
                <th>Status</th>
                <th>Score</th>
                <th>Risk</th>
                <th>Trade</th>
                <th>Rejection</th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((r) => (
                <tr key={r.tokenId}>
                  <td>
                    <button type="button" className="linkish" onClick={() => void openDetail(r.tokenId)}>
                      {r.name?.slice(0, 18) || r.address.slice(0, 8)}
                    </button>
                    <div>
                      <Link to={`/tokens/${r.tokenId}`} className="muted">
                        open
                      </Link>
                    </div>
                  </td>
                  <td>{r.symbol}</td>
                  <td>{ageLabel(r.ageMinutes)}</td>
                  <td>{money(r.marketCap, 0)}</td>
                  <td>{money(r.liquidity, 0)}</td>
                  <td>{money(r.volume, 0)}</td>
                  <td>{r.venue ?? '—'}</td>
                  <td>{r.discoverySource ?? '—'}</td>
                  <td>{r.firstSeen ? new Date(r.firstSeen).toLocaleString() : '—'}</td>
                  <td>{r.status}</td>
                  <td>{r.signalScore != null ? r.signalScore.toFixed(2) : '—'}</td>
                  <td>{r.riskStatus ?? '—'}</td>
                  <td>{r.tradeStatus ?? '—'}</td>
                  <td>{r.rejectionReason ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {selected && (
        <div className="panel">
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem' }}>
            <h3>Token detail</h3>
            <button type="button" onClick={() => setSelected(null)}>
              Close
            </button>
          </div>
          <pre className="code-block">{JSON.stringify(selected, null, 2)}</pre>
        </div>
      )}

      <div className="panel">
        <h3>Missed opportunity analysis</h3>
        <p className="muted">Research only — never auto-modifies thresholds.</p>
        <div className="stat-grid">
          <div className="stat">
            <div className="stat-label">False-negative candidates</div>
            <div className="stat-value">{missed.falseNegatives.length}</div>
          </div>
          <div className="stat">
            <div className="stat-label">Successful rejections</div>
            <div className="stat-value">{missed.successfulRejections.length}</div>
          </div>
        </div>
        <div className="table-wrap" style={{ marginTop: '0.75rem' }}>
          <table>
            <thead>
              <tr>
                <th>Type</th>
                <th>Symbol</th>
                <th>Reason</th>
                <th>Max gain 24h</th>
                <th>Max DD 24h</th>
                <th>Summary</th>
              </tr>
            </thead>
            <tbody>
              {missed.falseNegatives.slice(0, 20).map((r) => (
                <tr key={`fn-${String(r.tokenId)}`}>
                  <td>FALSE NEG</td>
                  <td>{String(r.symbol)}</td>
                  <td>{String(r.reason ?? '—')}</td>
                  <td>{pct(r.maxGain24h as number)}</td>
                  <td>—</td>
                  <td>{String(r.outcomeSummary ?? '—')}</td>
                </tr>
              ))}
              {missed.successfulRejections.slice(0, 20).map((r) => (
                <tr key={`sr-${String(r.tokenId)}`}>
                  <td>SUCCESS REJECT</td>
                  <td>{String(r.symbol)}</td>
                  <td>{String(r.reason ?? '—')}</td>
                  <td>—</td>
                  <td>{pct(r.maxDrawdown24h as number)}</td>
                  <td>{String(r.outcomeSummary ?? '—')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel">
        <h3>Meteora DBC discovery health</h3>
        <p className="muted">
          After deploy, status should move from UNKNOWN → OK once a real (non-demo) DBC init is
          seen. Long silence → STALE. Endpoint:{' '}
          <code>/api/intelligence/sources</code> (<code>meteoraDbc</code> field).
        </p>
        {meteoraDbc ? (
          <>
            <div className="stat-grid">
              <div className="stat">
                <div className="stat-label">Status</div>
                <div className="stat-value">{String(meteoraDbc.status)}</div>
              </div>
              <div className="stat">
                <div className="stat-label">Last RPC poll</div>
                <div className="stat-value" style={{ fontSize: '0.75rem' }}>
                  {meteoraDbc.lastSuccessfulRpcPollAt
                    ? String(meteoraDbc.lastSuccessfulRpcPollAt)
                    : '—'}
                </div>
              </div>
              <div className="stat">
                <div className="stat-label">Last real init</div>
                <div className="stat-value" style={{ fontSize: '0.75rem' }}>
                  {meteoraDbc.lastRealDbcInitAt ? String(meteoraDbc.lastRealDbcInitAt) : '—'}
                </div>
              </div>
              <div className="stat">
                <div className="stat-label">Last mint</div>
                <div className="stat-value" style={{ fontSize: '0.7rem' }}>
                  {meteoraDbc.lastRealDbcInitMint
                    ? String(meteoraDbc.lastRealDbcInitMint).slice(0, 12) + '…'
                    : '—'}
                </div>
              </div>
              <div className="stat">
                <div className="stat-label">DBC 1h / 24h</div>
                <div className="stat-value">
                  {String(meteoraDbc.discoveredLast1h ?? 0)} /{' '}
                  {String(meteoraDbc.discoveredLast24h ?? 0)}
                </div>
              </div>
              <div className="stat">
                <div className="stat-label">RPC / datapi / realtime (24h)</div>
                <div className="stat-value" style={{ fontSize: '0.85rem' }}>
                  {String(meteoraDbc.viaRpcLast24h ?? 0)} / {String(meteoraDbc.viaDatapiLast24h ?? 0)}{' '}
                  / {String(meteoraDbc.viaRealtimeLast24h ?? 0)}
                </div>
              </div>
              <div className="stat">
                <div className="stat-label">Pre-mig / migrated (24h)</div>
                <div className="stat-value">
                  {String(meteoraDbc.preMigrationLast24h ?? 0)} /{' '}
                  {String(meteoraDbc.migratedLast24h ?? 0)}
                </div>
              </div>
              <div className="stat">
                <div className="stat-label">RPC errors / 429s (1h)</div>
                <div className="stat-value">
                  {String(meteoraDbc.rpcErrorsLast1h ?? 0)} / {String(meteoraDbc.rpc429sLast1h ?? 0)}
                </div>
              </div>
              <div className="stat">
                <div className="stat-label">Consecutive failures</div>
                <div className="stat-value">{String(meteoraDbc.consecutiveFailures ?? 0)}</div>
              </div>
              <div className="stat">
                <div className="stat-label">Stale silence</div>
                <div className="stat-value">{String(meteoraDbc.staleSilenceMinutes ?? '—')}m</div>
              </div>
            </div>
            <p className="muted" style={{ marginTop: '0.5rem' }}>
              {String(meteoraDbc.note ?? '')}
            </p>
          </>
        ) : (
          <p className="muted">No Meteora DBC health snapshot yet.</p>
        )}
      </div>

      <div className="panel">
        <h3>Discovery source health</h3>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Source</th>
                <th>Enabled</th>
                <th>Status</th>
                <th>Healthy</th>
                <th>Last success</th>
                <th>Last discovery</th>
                <th>Failures</th>
                <th>Approx discovered</th>
                <th>Interval</th>
                <th>Last error</th>
              </tr>
            </thead>
            <tbody>
              {sources.map((s) => (
                <tr key={String(s.sourceKey)}>
                  <td>{String(s.sourceKey)}</td>
                  <td>{s.enabled ? 'yes' : 'no'}</td>
                  <td>{String(s.status ?? (s.healthy ? 'OK' : 'DEGRADED'))}</td>
                  <td>{s.healthy ? 'yes' : 'NO'}</td>
                  <td>{s.lastSuccessAt ? String(s.lastSuccessAt) : '—'}</td>
                  <td>{s.lastDiscoveryAt ? String(s.lastDiscoveryAt) : '—'}</td>
                  <td>{String(s.consecutiveFailures ?? 0)}</td>
                  <td>{String(s.tokensDiscoveredApprox ?? 0)}</td>
                  <td>{s.pollingIntervalMs != null ? `${s.pollingIntervalMs}ms` : '—'}</td>
                  <td>{s.lastError ? String(s.lastError) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel">
        <h3>Storage</h3>
        {storage ? (
          <div className="stat-grid">
            <div className="stat">
              <div className="stat-label">Est. DB bytes</div>
              <div className="stat-value">
                {storage.estimatedDbBytes != null
                  ? Number(storage.estimatedDbBytes).toLocaleString()
                  : '—'}
              </div>
            </div>
            <div className="stat">
              <div className="stat-label">Soft limit</div>
              <div className="stat-value">
                {storage.softLimitBytes != null
                  ? Number(storage.softLimitBytes).toLocaleString()
                  : '—'}
              </div>
            </div>
            <div className="stat">
              <div className="stat-label">Approaching limit</div>
              <div className="stat-value">{storage.approachingLimit ? 'YES' : 'no'}</div>
            </div>
            <div className="stat">
              <div className="stat-label">Oldest raw</div>
              <div className="stat-value" style={{ fontSize: '0.85rem' }}>
                {storage.oldestRawSnapshotAt ? String(storage.oldestRawSnapshotAt) : '—'}
              </div>
            </div>
            <div className="stat">
              <div className="stat-label">Next cleanup</div>
              <div className="stat-value" style={{ fontSize: '0.85rem' }}>
                {storage.nextCleanupAt ? String(storage.nextCleanupAt) : '—'}
              </div>
            </div>
            <div className="stat">
              <div className="stat-label">Cleanup every</div>
              <div className="stat-value" style={{ fontSize: '0.85rem' }}>
                {storage.cleanupIntervalMs != null
                  ? `${Math.round(Number(storage.cleanupIntervalMs) / 60_000)}m`
                  : '15m'}
              </div>
            </div>
            <div className="stat">
              <div className="stat-label">Retention HF / research / logs</div>
              <div className="stat-value" style={{ fontSize: '0.8rem' }}>
                {String(storage.rawRetentionHours ?? 3)}h /{' '}
                {String(storage.researchRetentionHours ?? 72)}h /{' '}
                {String(storage.eventRetentionDays ?? 3)}d
              </div>
            </div>
          </div>
        ) : (
          <p className="muted">No storage snapshot yet.</p>
        )}
        {storage?.storageGrowthEstimate != null ? (
          <p className="muted" style={{ marginTop: '0.5rem' }}>
            {String(
              (storage.storageGrowthEstimate as { basis?: string }).basis ??
                JSON.stringify(storage.storageGrowthEstimate),
            )}
          </p>
        ) : null}
        {storage?.counts != null ? (
          <pre className="code-block" style={{ marginTop: '0.75rem' }}>
            {JSON.stringify(storage.counts, null, 2)}
          </pre>
        ) : null}
      </div>
    </div>
  );
}
