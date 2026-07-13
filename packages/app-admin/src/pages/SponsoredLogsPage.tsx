/**
 * Sponsored Logs admin page.
 *
 * Composes:
 *   - 3 KPI cards (mode-filterable) — same component as Dashboard
 *   - mode filter (All / Generic / Promotion) as a segmented control
 *   - recent log table (bounded)
 *
 * Display contract:
 *   - lifetime KPI is read from `summary` (durable aggregate); never
 *     computed from `entries`.
 *   - numeric MIST values flow as exact decimal strings; UI formatting
 *     happens only at display time via `mistToSui`.
 *   - unknown economics rows render `unavailable` placeholders; never
 *     `0` substitutions.
 *   - raw orderId is never displayed; only `orderIdHash` (already hashed
 *     in the API response) is shown.
 *   - row economics display the single `Host Net` value. Negative
 *     values are losses.
 *   - rows with a non-null `failureReason` render the reason inline under
 *     the outcome label so post-submit accounting failures (which keep
 *     `outcome === 'success'` per handler contract) cannot be missed.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  getSponsoredLogs,
  type SponsoredExecutionAggregate,
  type SponsoredExecutionLogEntry,
  type SponsoredLogsMode,
} from '../api/client';
import { SponsoredLogsKpi } from '../components/SponsoredLogsKpi';
import { mistToSui, truncateAddress } from '../utils';

const MODE_OPTIONS: readonly { value: SponsoredLogsMode; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'generic', label: 'Generic' },
  { value: 'promotion', label: 'Promotion' },
];

const REFRESH_INTERVAL_MS = 30_000;

export function SponsoredLogsPage() {
  const [mode, setMode] = useState<SponsoredLogsMode>('all');
  const [summary, setSummary] = useState<SponsoredExecutionAggregate | null>(null);
  const [entries, setEntries] = useState<SponsoredExecutionLogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async (m: SponsoredLogsMode) => {
    setLoading(true);
    try {
      const res = await getSponsoredLogs(m);
      setSummary(res.summary);
      setEntries(res.entries);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load sponsored logs');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchData(mode);
    const interval = setInterval(() => {
      void fetchData(mode);
    }, REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [mode, fetchData]);

  return (
    <div className="admin-page">
      <header style={{ marginBottom: 24 }}>
        <h1>Sponsored Logs</h1>
        <p style={{ color: '#94a3b8', fontSize: 14, marginTop: 4 }}>
          Generic and promotion sponsored executions in one log model.
        </p>
      </header>

      {error && (
        <div
          className="admin-card"
          style={{ borderColor: '#f87171', color: '#f87171', marginBottom: 16 }}
        >
          {error}
        </div>
      )}

      <SponsoredLogsKpi summary={summary} loading={loading} />

      <section style={{ marginTop: 24 }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            marginBottom: 12,
            justifyContent: 'space-between',
          }}
        >
          <div style={{ fontSize: 14, fontWeight: 600 }}>Recent Executions</div>
          <ModeFilter value={mode} onChange={setMode} />
        </div>

        <SponsoredLogsTable entries={entries} loading={loading} />
      </section>
    </div>
  );
}

function ModeFilter({
  value,
  onChange,
}: {
  readonly value: SponsoredLogsMode;
  readonly onChange: (next: SponsoredLogsMode) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="Sponsored execution mode filter"
      style={{
        display: 'inline-flex',
        gap: 0,
        background: '#0f172a',
        border: '1px solid #334155',
        borderRadius: 6,
        padding: 2,
      }}
    >
      {MODE_OPTIONS.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(opt.value)}
            style={{
              fontSize: 12,
              padding: '4px 12px',
              border: 'none',
              borderRadius: 4,
              cursor: active ? 'default' : 'pointer',
              background: active ? '#1e293b' : 'transparent',
              color: active ? '#e2e8f0' : '#94a3b8',
              fontWeight: active ? 600 : 400,
              transition: 'background 120ms, color 120ms',
            }}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

function SponsoredLogsTable({
  entries,
  loading,
}: {
  readonly entries: SponsoredExecutionLogEntry[];
  readonly loading: boolean;
}) {
  if (entries.length === 0) {
    return (
      <div className="admin-card" style={{ color: '#94a3b8' }}>
        {loading ? 'Loading…' : 'No sponsored executions in the recent window.'}
      </div>
    );
  }
  return (
    <div className="admin-card" style={{ overflowX: 'auto', padding: 0 }}>
      <table className="admin-table">
        <thead>
          <tr>
            <th>Time</th>
            <th>Mode</th>
            <th>Outcome</th>
            <th>Digest</th>
            <th style={{ textAlign: 'right' }}>Host Net</th>
            <th>Identity</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => (
            <SponsoredLogsRow key={e.receiptId} entry={e} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SponsoredLogsRow({ entry }: { readonly entry: SponsoredExecutionLogEntry }) {
  const isUnknown = entry.economicsStatus === 'unknown';
  const negativeNet = !isUnknown && entry.hostNetMist?.startsWith('-');
  // Post-submit accounting failures (e.g. SPONSOR_EXEC_GAS_USED_MISSING,
  // PROMOTION_LEDGER_CONSUME_FAILED) keep `outcome === 'success'` because
  // the TX actually submitted on-chain, but they carry a non-null
  // `failureReason` describing the recorder-visible deviation. Surface
  // that reason so the operator does not read "success" alone and miss
  // the accounting failure.
  const hasFailureReason = entry.failureReason !== null && entry.failureReason !== '';
  const reasonHighlights = hasFailureReason && (entry.outcome === 'success' || isUnknown);

  const formatSignedSui = (value: string | null): string => {
    if (value === null) return 'unavailable';
    return `${mistToSui(value)} SUI`;
  };

  const identity = useIdentityLabel(entry);

  return (
    <tr>
      <td style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11 }}>
        {formatTime(entry.createdAt)}
      </td>
      <td>{entry.mode}</td>
      <td>
        <span
          style={{
            color: entry.outcome === 'success' ? '#22c55e' : '#fbbf24',
            fontSize: 12,
          }}
        >
          {entry.outcome}
        </span>
        {hasFailureReason && (
          <div
            title={entry.failureReason ?? undefined}
            style={{
              fontSize: 10,
              marginTop: 2,
              color: reasonHighlights ? '#f87171' : '#fbbf24',
              fontFamily: "'JetBrains Mono', monospace",
              maxWidth: 220,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {entry.failureReason}
          </div>
        )}
      </td>
      <td style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11 }}>
        {entry.digest ? truncateAddress(entry.digest) : '—'}
      </td>
      <td
        style={{
          textAlign: 'right',
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 11,
          color: negativeNet ? '#f87171' : undefined,
        }}
      >
        {isUnknown ? unavailable() : formatSignedSui(entry.hostNetMist)}
      </td>
      <td style={{ fontSize: 11, color: '#94a3b8' }}>{identity}</td>
    </tr>
  );
}

function useIdentityLabel(entry: SponsoredExecutionLogEntry): string {
  return useMemo(() => {
    if (entry.mode === 'promotion') {
      const promo = entry.promotionId ?? '—';
      const user = entry.userId ? truncateAddress(entry.userId) : '—';
      return `promo:${promo} • user:${user}`;
    }
    const sender = entry.senderAddress ? truncateAddress(entry.senderAddress) : '—';
    const order = entry.orderIdHash ? `${entry.orderIdHash.slice(0, 8)}…` : null;
    return order ? `${sender} • order:${order}` : sender;
  }, [entry]);
}

function unavailable(): string {
  return 'unavailable';
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d
      .toISOString()
      .replace('T', ' ')
      .replace(/\.\d{3}Z$/, 'Z');
  } catch {
    return iso;
  }
}
