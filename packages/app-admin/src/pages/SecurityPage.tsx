/**
 * SecurityPage — abuse blocklist management and admin audit review.
 */
import { useEffect, useState, useCallback } from 'react';
import { getAuditLogs, getBlocklist, removeBlocklistEntry } from '../api/client';
import type { AdminAuditLogEntry, AdminBlocklistEntry } from '@stelis/contracts';
import { truncateAddress } from '../utils';

const AUDIT_PAGE_SIZE = 15;

export function SecurityPage() {
  const [blocklist, setBlocklist] = useState<AdminBlocklistEntry[]>([]);
  const [blockCursor, setBlockCursor] = useState<string | null>(null);
  const [previousBlockCursors, setPreviousBlockCursors] = useState<(string | null)[]>([]);
  const [nextBlockCursor, setNextBlockCursor] = useState<string | null>(null);
  const [auditLogs, setAuditLogs] = useState<AdminAuditLogEntry[]>([]);
  const [auditPage, setAuditPage] = useState(0);
  const [msg, setMsg] = useState('');
  const [loading, setLoading] = useState(false);

  const loadBlocklist = useCallback(async () => {
    try {
      const json = await getBlocklist(blockCursor === null ? {} : { cursor: blockCursor });
      setBlocklist(json.blocklist);
      setNextBlockCursor(json.nextCursor);
    } catch (err) {
      setMsg(`Error: ${err instanceof Error ? err.message : 'unknown'}`);
    }
  }, [blockCursor]);

  const loadAuditLogs = useCallback(async () => {
    try {
      const json = await getAuditLogs();
      setAuditLogs(json.logs);
      setAuditPage(0);
    } catch (err) {
      setMsg(`Error: ${err instanceof Error ? err.message : 'unknown'}`);
    }
  }, []);

  useEffect(() => {
    void loadBlocklist();
  }, [loadBlocklist]);

  useEffect(() => {
    void loadAuditLogs();
  }, [loadAuditLogs]);

  async function unblock(entry: AdminBlocklistEntry) {
    setLoading(true);
    setMsg('');
    try {
      const result = await removeBlocklistEntry({
        scope: entry.scope,
        subject: entry.subject,
      });
      setMsg(
        result.removed
          ? `Unblocked: ${entry.scope} ${entry.subject}`
          : `Already unblocked: ${entry.scope} ${entry.subject}`,
      );
      await loadBlocklist();
    } catch (err) {
      setMsg(`Error: ${err instanceof Error ? err.message : 'unknown'}`);
    } finally {
      setLoading(false);
    }
  }

  function showNextBlockPage() {
    if (nextBlockCursor === null) return;
    setPreviousBlockCursors((current) => [...current, blockCursor]);
    setBlockCursor(nextBlockCursor);
    setNextBlockCursor(null);
  }

  function showPreviousBlockPage() {
    const previous = previousBlockCursors[previousBlockCursors.length - 1];
    if (previous === undefined) return;
    setPreviousBlockCursors((current) => current.slice(0, -1));
    setBlockCursor(previous);
    setNextBlockCursor(null);
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
                <th>Scope</th>
                <th>Subject</th>
                <th>Reason</th>
                <th>Blocked until</th>
                <th style={{ textAlign: 'right' }}>Action</th>
              </tr>
            </thead>
            <tbody>
              {blocklist.map((entry) => (
                <tr key={`${entry.scope}:${entry.subject}`}>
                  <td>{entry.scope}</td>
                  <td style={{ wordBreak: 'break-all', fontSize: 12 }}>{entry.subject}</td>
                  <td>{entry.reason}</td>
                  <td>{new Date(entry.blockedUntilMs).toLocaleString()}</td>
                  <td style={{ textAlign: 'right' }}>
                    <button
                      className="admin-btn admin-btn-danger"
                      disabled={loading}
                      onClick={() => void unblock(entry)}
                    >
                      Unblock
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
          <button
            className="admin-btn"
            disabled={previousBlockCursors.length === 0 || loading}
            onClick={showPreviousBlockPage}
          >
            Previous
          </button>
          <button
            className="admin-btn"
            disabled={nextBlockCursor === null || loading}
            onClick={showNextBlockPage}
          >
            Next
          </button>
        </div>
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
            const totalPages = Math.max(1, Math.ceil(auditLogs.length / AUDIT_PAGE_SIZE));
            const safePage = Math.min(auditPage, totalPages - 1);
            const paged = auditLogs.slice(
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
                    {paged.map((entry, index) => {
                      return (
                        <tr key={`${entry.ts}:${entry.event}:${index}`}>
                          <td style={{ fontSize: 13 }}>{new Date(entry.ts).toLocaleString()}</td>
                          <td>
                            <span className="badge badge-green">{entry.event}</span>
                          </td>
                          <td>{entry.ip}</td>
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
