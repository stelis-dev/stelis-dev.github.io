/**
 * SecurityPage — abuse blocklist management and admin audit review.
 */
import { useEffect, useState, useCallback } from 'react';
import { getAuditLogs, getBlocklist, removeBlocklistEntry, type BlockEntry } from '../api/client';
import { truncateAddress } from '../utils';

interface AuditLogEntry {
  ts?: string;
  event?: string;
  level?: string;
  ip?: string;
  address?: string;
  [key: string]: unknown;
}

function parseAuditEntry(raw: string): AuditLogEntry | null {
  try {
    return JSON.parse(raw) as AuditLogEntry;
  } catch {
    return null;
  }
}

const AUDIT_PAGE_SIZE = 15;

export function SecurityPage() {
  const [blocklist, setBlocklist] = useState<BlockEntry[]>([]);
  const [auditLogs, setAuditLogs] = useState<string[]>([]);
  const [auditPage, setAuditPage] = useState(0);
  const [msg, setMsg] = useState('');
  const [loading, setLoading] = useState(false);

  const loadBlocklist = useCallback(async () => {
    try {
      const json = await getBlocklist();
      setBlocklist(json.blocklist ?? []);
    } catch {
      /* ignore */
    }
  }, []);

  const loadAuditLogs = useCallback(async () => {
    try {
      const json = await getAuditLogs();
      setAuditLogs(json.logs ?? []);
      setAuditPage(0);
    } catch (err) {
      setMsg(`Error: ${err instanceof Error ? err.message : 'unknown'}`);
    }
  }, []);

  useEffect(() => {
    void loadBlocklist();
    void loadAuditLogs();
  }, [loadAuditLogs, loadBlocklist]);

  async function unblock(key: string) {
    setLoading(true);
    setMsg('');
    try {
      await removeBlocklistEntry(key);
      setMsg(`Unblocked: ${key}`);
      await loadBlocklist();
    } catch (err) {
      setMsg(`Error: ${err instanceof Error ? err.message : 'unknown'}`);
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <h1 className="admin-page-title">Security</h1>
      <p className="admin-page-sub">Abuse response controls for the Host.</p>

      {msg && (
        <div
          className="admin-card"
          style={{ borderColor: '#1e40af', background: '#0c1a3a', marginBottom: 20 }}
        >
          <p style={{ margin: 0, color: '#93c5fd', fontSize: 13 }}>{msg}</p>
        </div>
      )}

      <div className="admin-card">
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 16,
          }}
        >
          <div className="admin-card-title" style={{ margin: 0 }}>
            Abuse Blocklist
          </div>
          <button className="admin-btn admin-btn-primary" onClick={() => void loadBlocklist()}>
            Refresh
          </button>
        </div>
        {blocklist.length === 0 ? (
          <p style={{ color: '#64748b', margin: 0 }}>No blocked entries.</p>
        ) : (
          <table className="admin-table" style={{ tableLayout: 'fixed', width: '100%' }}>
            <thead>
              <tr>
                <th style={{ width: '60%' }}>Key</th>
                <th style={{ width: '20%' }}>TTL (s)</th>
                <th style={{ width: '20%', textAlign: 'right' }}>Action</th>
              </tr>
            </thead>
            <tbody>
              {blocklist.map((entry) => (
                <tr key={entry.key}>
                  <td style={{ wordBreak: 'break-all', fontSize: 12, fontFamily: 'monospace' }}>
                    {entry.key}
                  </td>
                  <td>{entry.ttl}</td>
                  <td style={{ textAlign: 'right' }}>
                    <button
                      className="admin-btn admin-btn-danger"
                      disabled={loading}
                      onClick={() => void unblock(entry.key)}
                    >
                      Unblock
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="admin-card">
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 16,
          }}
        >
          <div className="admin-card-title" style={{ margin: 0 }}>
            Admin Audit
          </div>
          <button className="admin-btn admin-btn-primary" onClick={() => void loadAuditLogs()}>
            Refresh
          </button>
        </div>
        {auditLogs.length === 0 ? (
          <p style={{ color: '#64748b', margin: 0 }}>No audit events recorded.</p>
        ) : (
          (() => {
            const parsed = auditLogs
              .map((raw, i) => ({ raw, i, entry: parseAuditEntry(raw) }))
              .filter((x) => x.entry);
            const totalPages = Math.max(1, Math.ceil(parsed.length / AUDIT_PAGE_SIZE));
            const safePage = Math.min(auditPage, totalPages - 1);
            const paged = parsed.slice(
              safePage * AUDIT_PAGE_SIZE,
              (safePage + 1) * AUDIT_PAGE_SIZE,
            );
            return (
              <>
                <table className="admin-table">
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>Event</th>
                      <th>IP</th>
                      <th>Address</th>
                    </tr>
                  </thead>
                  <tbody>
                    {paged.map(({ i, entry }) => {
                      if (!entry) return null;
                      const isWarn = entry.level === 'warn';
                      return (
                        <tr key={i} style={isWarn ? { color: '#fbbf24' } : undefined}>
                          <td style={{ fontSize: 13 }}>
                            {entry.ts ? new Date(entry.ts).toLocaleString() : '—'}
                          </td>
                          <td>
                            <span className={`badge ${isWarn ? 'badge-yellow' : 'badge-green'}`}>
                              {entry.event ?? '—'}
                            </span>
                          </td>
                          <td>{entry.ip ?? '—'}</td>
                          <td style={{ fontFamily: 'monospace', fontSize: 13 }}>
                            {entry.address ? truncateAddress(entry.address) : '—'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {totalPages > 1 && (
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: 12,
                      padding: '12px 0',
                    }}
                  >
                    <button
                      className="admin-btn"
                      disabled={safePage === 0}
                      onClick={() => setAuditPage((p) => Math.max(0, p - 1))}
                    >
                      Prev
                    </button>
                    <span style={{ fontSize: 13, color: '#94a3b8' }}>
                      {safePage + 1} / {totalPages}
                    </span>
                    <button
                      className="admin-btn"
                      disabled={safePage >= totalPages - 1}
                      onClick={() => setAuditPage((p) => Math.min(totalPages - 1, p + 1))}
                    >
                      Next
                    </button>
                  </div>
                )}
              </>
            );
          })()
        )}
      </div>
    </>
  );
}
