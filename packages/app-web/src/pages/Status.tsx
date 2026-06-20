import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import pkg from '../../package.json';
import { RELAY_API_BASE } from '../relayApiEndpoint';

const APP_VERSION = pkg.version;
const STATUS_PROBE_TIMEOUT_MS = 5_000;
const STATUS_PROBE_INTERVAL_MS = 30_000;

// ─── Types ───────────────────────────────────────────────────────────────────

type ServiceStatus = 'operational' | 'degraded' | 'outage' | 'loading';

interface SettlementSwapPathSummary {
  settlementTokenSymbol: string;
  settlementTokenType: string;
  effectiveFeeRateBps: number;
}

interface RelayConfigResponse {
  network: string;
  supportedSettlementSwapPaths: SettlementSwapPathSummary[];
}

interface Incident {
  id: string;
  ts: string;
  severity: 'info' | 'warn' | 'crit';
  title: string;
  body: string;
}

// ─── Constants ───────────────────────────────────────────────────────────────

// Static incidents rendered by the status page.
const INCIDENTS: Incident[] = [];

function formatBpsPercent(bps: number): string {
  if (!Number.isSafeInteger(bps) || bps < 0 || bps > 10_000) return 'invalid';
  const whole = Math.floor(bps / 100);
  const frac = String(bps % 100).padStart(2, '0');
  return `${whole}.${frac}%`;
}

// ─── Hooks ───────────────────────────────────────────────────────────────────

function useHostStatus() {
  const [status, setStatus] = useState<ServiceStatus>('loading');
  const [avgLatencyMs, setAvgLatencyMs] = useState<number | null>(null);
  const [lastChecked, setLastChecked] = useState<Date | null>(null);
  const [config, setConfig] = useState<RelayConfigResponse | null>(null);

  // Fetch Relay config response once (network + supported settlement swap paths)
  useEffect(() => {
    fetch(`${RELAY_API_BASE}/config`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: RelayConfigResponse | null) => {
        if (data) setConfig(data);
      })
      .catch(() => null);
  }, []);

  // Probe service health on the fixed status-page interval.
  useEffect(() => {
    let cancelled = false;

    async function probe() {
      try {
        const start = Date.now();
        const res = await fetch(`${RELAY_API_BASE}/status`, {
          signal: AbortSignal.timeout(STATUS_PROBE_TIMEOUT_MS),
        });
        const latency = Date.now() - start;
        if (cancelled) return;

        if (res.ok) {
          // /relay/status returns { ok: true } on success
          setStatus('operational');
          setAvgLatencyMs(latency);
        } else if (res.status >= 500) {
          setStatus('outage');
        } else {
          setStatus('degraded');
        }
      } catch {
        if (!cancelled) setStatus('outage');
      }
      if (!cancelled) setLastChecked(new Date());
    }

    probe();
    const interval = setInterval(probe, STATUS_PROBE_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  return { status, avgLatencyMs, lastChecked, config };
}

// ─── Sub-components ──────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: ServiceStatus }) {
  const cfg: Record<ServiceStatus, { label: string; cls: string; icon: string }> = {
    loading: { label: 'Checking…', cls: 'status-loading', icon: '⟳' },
    operational: { label: 'Operational', cls: 'status-operational', icon: '●' },
    degraded: { label: 'Degraded', cls: 'status-degraded', icon: '▲' },
    outage: { label: 'Outage', cls: 'status-outage', icon: '✕' },
  };
  const { label, cls, icon } = cfg[status];
  return (
    <div className={`status-badge ${cls}`}>
      <span className="status-dot">{icon}</span>
      <span>{label}</span>
    </div>
  );
}

function MetricCard({
  label,
  value,
  unit,
}: {
  label: string;
  value: string | null;
  unit?: string;
}) {
  return (
    <div className="metric-card">
      <div className="metric-label">{label}</div>
      <div className="metric-value">
        {value ?? '—'}
        {value && unit && <span className="metric-unit">{unit}</span>}
      </div>
    </div>
  );
}

function SettlementSwapPathRow({
  settlementSwapPath,
  network,
}: {
  settlementSwapPath: SettlementSwapPathSummary;
  network: string;
}) {
  const feeLabel =
    settlementSwapPath.effectiveFeeRateBps === 0
      ? 'Whitelisted (0% fee)'
      : `Input fee: ${formatBpsPercent(settlementSwapPath.effectiveFeeRateBps)}`;
  return (
    <div className="token-row">
      <div className="token-info">
        <span className="token-symbol">{settlementSwapPath.settlementTokenSymbol}</span>
        <span className="token-network">
          {network} · {feeLabel}
        </span>
      </div>
      <span className="token-badge supported">✓ Configured</span>
    </div>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

export function StatusPage() {
  const { status, avgLatencyMs, lastChecked, config } = useHostStatus();

  const fmtLatency = avgLatencyMs !== null ? `${avgLatencyMs}` : null;
  const fmtChecked = lastChecked
    ? lastChecked.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : null;

  // Network label from config (e.g. "testnet" → "Sui Testnet")
  const networkLabel = config
    ? `Sui ${config.network.charAt(0).toUpperCase() + config.network.slice(1)}`
    : '…';

  return (
    <main className="status-page">
      {/* Header */}
      <div className="status-header">
        <h1 className="status-title">Stelis Host Status</h1>
        <p className="status-subtitle">
          Live status of this Stelis Host (single endpoint probe).
        </p>
        <StatusBadge status={status} />
        {fmtChecked && <p className="last-checked">Last checked: {fmtChecked}</p>}
      </div>

      {/* Key public metrics */}
      <section className="status-section">
        <h2 className="section-title">Service Metrics (live)</h2>
        <div className="metrics-grid">
          <MetricCard
            label="Reachability"
            value={
              status === 'operational'
                ? '✓ Reachable'
                : status === 'loading'
                  ? '…'
                  : '✕ Unreachable'
            }
          />
          <MetricCard label="Last Response Time" value={fmtLatency} unit="ms" />
          <MetricCard label="Network" value={networkLabel} />
        </div>
        <p className="metrics-note">
          Metrics reflect the current probe cycle (every {STATUS_PROBE_INTERVAL_MS / 1000}s).
          Internal profitability and infrastructure metrics are not disclosed publicly.
        </p>
      </section>

      {/* Token and settlement swap path support — dynamic from /relay/config */}
      <section className="status-section">
        <h2 className="section-title">Supported Tokens &amp; Settlement Swap Paths</h2>
        <div className="token-list">
          {config ? (
            config.supportedSettlementSwapPaths.map((settlementSwapPath, i) => (
              <SettlementSwapPathRow
                key={i}
                settlementSwapPath={settlementSwapPath}
                network={config.network}
              />
            ))
          ) : (
            <div className="token-row" style={{ color: 'var(--text-muted)', fontSize: 13 }}>
              Loading…
            </div>
          )}
        </div>
        <p className="metrics-note">
          This page shows configured settlement swap paths from <code>/relay/config</code>. Actual
          execution still depends on live liquidity, on-chain <code>Config</code> limits such as{' '}
          <code>max_claim_mist</code>, and prepare-time validation, which are checked in Sandbox and
          again during prepare.
        </p>
      </section>

      {/* API endpoints */}
      <section className="status-section">
        <h2 className="section-title">API Endpoints</h2>
        <div className="endpoint-status-list">
          {[
            { path: 'GET /relay/status', desc: 'Health check' },
            {
              path: 'GET /relay/config',
              desc: 'Relay config response (settlement swap paths, network)',
            },
            {
              path: 'POST /relay/prepare',
              desc: 'Build sponsored TX (dry-run + cost, 422 on simulation rejection)',
            },
            { path: 'POST /relay/sponsor', desc: 'Sign + execute sponsored TX' },
          ].map((ep) => (
            <div key={ep.path} className="endpoint-status-row">
              <code className="ep-path">{ep.path}</code>
              <span className="ep-desc">{ep.desc}</span>
              <span className="ep-status ep-loading">—</span>
            </div>
          ))}
        </div>
        <p className="metrics-note">
          Individual endpoint health is not independently verified. Status reflects overall service
          reachability via /relay/status.
        </p>
      </section>

      {/* Published incidents */}
      <section className="status-section">
        <h2 className="section-title">Published Incidents</h2>
        {INCIDENTS.length === 0 ? (
          <div className="no-incidents">
            <span>✓</span>
            <span>No incidents are published.</span>
          </div>
        ) : (
          <div className="incident-list">
            {INCIDENTS.map((inc) => (
              <div key={inc.id} className={`incident-row sev-${inc.severity}`}>
                <div className="incident-meta">
                  <span className="incident-ts">{inc.ts}</span>
                  <span className="incident-sev">{inc.severity.toUpperCase()}</span>
                </div>
                <div className="incident-title">{inc.title}</div>
                <div className="incident-body">{inc.body}</div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Footer */}
      <footer className="status-footer">
        <p>
          Shared Settlement Network — Stelis Host v{APP_VERSION} · {networkLabel} ·{' '}
          <Link to="/docs">API Docs</Link> · <Link to="/playground">Playground</Link>
        </p>
        <p className="footer-note">
          This page shows publicly safe aggregate metrics only. Internal operational metrics are not
          disclosed.
        </p>
      </footer>
    </main>
  );
}
export default StatusPage;
