/**
 * PromotionsPage — admin CRUD for promotion registry.
 *
 * Lists, creates, updates, transitions status, and deletes promotions.
 * Uses the admin API client for all operations.
 */
import { useEffect, useRef, useState, useCallback } from 'react';
import {
  getPromotions,
  ApiError,
  createPromotion,
  updatePromotion,
  transitionPromotionStatus,
  deletePromotion,
  type PromotionRecord,
  type PromotionStatus,
} from '../api/client';

const STATUS_COLORS: Record<PromotionStatus, string> = {
  draft: '#94a3b8',
  active: '#34d399',
  paused: '#fbbf24',
  archived: '#64748b',
};

const STATUS_LABELS: Record<PromotionStatus, string> = {
  draft: 'Draft',
  active: 'Active',
  paused: 'Paused',
  archived: 'Archived',
};

function StatusBadge({ status }: { status: PromotionStatus }) {
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '2px 10px',
        borderRadius: 12,
        fontSize: 12,
        fontWeight: 600,
        color: '#0f172a',
        background: STATUS_COLORS[status],
      }}
    >
      {STATUS_LABELS[status]}
    </span>
  );
}

function formatMist(mist: string): string {
  if (!/^(?:0|[1-9]\d*)$/.test(mist)) return mist;
  let bi: bigint;
  try {
    bi = BigInt(mist);
  } catch {
    return mist;
  }
  if (bi === 0n) return '0';
  if (bi >= 1_000_000_000n) {
    const whole = bi / 1_000_000_000n;
    const frac = ((bi % 1_000_000_000n) * 100n) / 1_000_000_000n;
    return `${whole}.${frac.toString().padStart(2, '0')} SUI`;
  }
  if (bi >= 1_000_000n) {
    const whole = bi / 1_000_000n;
    const frac = ((bi % 1_000_000n) * 100n) / 1_000_000n;
    return `${whole}.${frac.toString().padStart(2, '0')}M MIST`;
  }
  return `${mist} MIST`;
}

/**
 * Preview-only budget estimation for form UX.
 * Preview only; computeTotalRequiredBudgetMist in @stelis/core-api/studio
 * performs the submitted budget calculation. API returns the authoritative value.
 *
 * Uses BigInt directly against the raw decimal string so rounded unsafe
 * integers are never shown as if they were a valid preview value. Returns
 * `'0'` as a neutral fallback on any invalid input.
 */
function previewBudget(maxParticipants: string, perUserGasAllowanceMist: string): string {
  const mpRaw = maxParticipants.trim();
  const mpNumber = parseSafeIntegerString(mpRaw);
  if (mpNumber === null || mpNumber <= 0) return '0';
  const allowanceRaw = perUserGasAllowanceMist.trim();
  if (!/^(?:0|[1-9]\d*)$/.test(allowanceRaw)) return '0';
  return (BigInt(mpNumber) * BigInt(allowanceRaw)).toString();
}

export interface CreateFormState {
  displayName: string;
  description: string;
  maxParticipants: string;
  perUserGasAllowanceMist: string;
  postClaimUseWindowDays: string;
  claimDeadlineAt: string;
}

const EMPTY_FORM: CreateFormState = {
  displayName: '',
  description: '',
  maxParticipants: '',
  perUserGasAllowanceMist: '',
  postClaimUseWindowDays: '0',
  claimDeadlineAt: '',
};

interface ValidatedFormPayload {
  displayName: string;
  description: string;
  maxParticipants: number;
  perUserGasAllowanceMist: string;
  postClaimUseWindowMs: number;
  claimDeadlineAt: string | null;
}

type FormValidationResult =
  | { ok: true; payload: ValidatedFormPayload }
  | { ok: false; message: string };

const INTEGER_REGEX = /^-?\d+$/;
const DAY_MS = 86_400_000;

/**
 * Parse a non-empty decimal integer string into a safe `number`. Rejects
 * values outside `Number.MAX_SAFE_INTEGER` range so downstream `BigInt(n)`
 * math never silently consumes a rounded input.
 *
 * Exported for unit testing; the intended consumer is `validatePromotionForm`.
 */
export function parseSafeIntegerString(raw: string): number | null {
  if (raw.length === 0 || !INTEGER_REGEX.test(raw)) return null;
  const n = Number(raw);
  if (!Number.isSafeInteger(n)) return null;
  return n;
}

function postClaimWindowMsToDaysInput(ms: number): string {
  if (ms <= 0) return '0';
  if (!Number.isSafeInteger(ms) || ms % DAY_MS !== 0) return '';
  return String(ms / DAY_MS);
}

/**
 * Submit-time form validation. Mirrors the admin API parse guards (safe
 * integer + positive bigint) so invalid input never reaches the request payload.
 * Produces a normalized payload shape for `createPromotion` / `updatePromotion`.
 *
 * Exported so test harnesses can verify the `{ ok: false }` rejection path
 * without spinning up a full render — `handleCreate` / `handleUpdate` both
 * short-circuit on `!validation.ok` before any `fetch` call.
 */
export function validatePromotionForm(form: CreateFormState): FormValidationResult {
  const displayName = form.displayName.trim();
  if (displayName.length === 0) {
    return { ok: false, message: 'Display name is required' };
  }

  const maxRaw = form.maxParticipants.trim();
  const maxParticipants = parseSafeIntegerString(maxRaw);
  if (maxParticipants === null || maxParticipants <= 0) {
    return {
      ok: false,
      message: 'Max participants must be a positive safe integer (≤ 2^53 − 1)',
    };
  }

  const allowanceRaw = form.perUserGasAllowanceMist.trim();
  if (allowanceRaw.length === 0) {
    return { ok: false, message: 'Per-user gas allowance (MIST) is required' };
  }
  if (!/^(?:0|[1-9]\d*)$/.test(allowanceRaw)) {
    return { ok: false, message: 'Per-user gas allowance must be a decimal bigint (MIST)' };
  }
  let allowance: bigint;
  try {
    allowance = BigInt(allowanceRaw);
  } catch {
    return { ok: false, message: 'Per-user gas allowance must be a valid bigint (MIST)' };
  }
  if (allowance <= 0n) {
    return { ok: false, message: 'Per-user gas allowance must be positive (MIST)' };
  }

  const daysRaw = form.postClaimUseWindowDays.trim();
  const postClaimDays = parseSafeIntegerString(daysRaw);
  if (postClaimDays === null || postClaimDays < 0) {
    return {
      ok: false,
      message: 'Post-claim use window (days) must be a non-negative safe integer (≤ 2^53 − 1)',
    };
  }
  const postClaimUseWindowMs = postClaimDays * DAY_MS;
  if (!Number.isSafeInteger(postClaimUseWindowMs)) {
    return {
      ok: false,
      message: 'Post-claim use window overflows safe integer range — use fewer days',
    };
  }

  let claimDeadlineAt: string | null = null;
  if (form.claimDeadlineAt) {
    const parsed = new Date(form.claimDeadlineAt);
    if (Number.isNaN(parsed.getTime())) {
      return { ok: false, message: 'Claim deadline is not a valid date' };
    }
    claimDeadlineAt = parsed.toISOString();
  }

  return {
    ok: true,
    payload: {
      displayName,
      description: form.description,
      maxParticipants,
      perUserGasAllowanceMist: allowanceRaw,
      postClaimUseWindowMs,
      claimDeadlineAt,
    },
  };
}

export function PromotionsPage() {
  const [promotions, setPromotions] = useState<PromotionRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<PromotionStatus | ''>('');
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState<CreateFormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const editingIdRef = useRef<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const loadPromotions = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await getPromotions(statusFilter || undefined);
      setPromotions(result.promotions);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load promotions');
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => {
    void loadPromotions();
  }, [loadPromotions]);

  const handleCreate = async () => {
    const validation = validatePromotionForm(form);
    if (!validation.ok) {
      setActionError(validation.message);
      return;
    }
    setSaving(true);
    setActionError(null);
    try {
      await createPromotion({
        type: 'gas_sponsorship',
        ...validation.payload,
      });
      setShowCreate(false);
      setForm(EMPTY_FORM);
      await loadPromotions();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'PROMOTION_CURRENT_CONFLICT') {
        await loadPromotions();
      }
      setActionError(err instanceof Error ? err.message : 'Create failed');
    } finally {
      setSaving(false);
    }
  };

  const handleUpdate = async (id: string) => {
    const validation = validatePromotionForm(form);
    if (!validation.ok) {
      setActionError(validation.message);
      return;
    }
    setSaving(true);
    setActionError(null);
    try {
      await updatePromotion(id, validation.payload);
      if (editingIdRef.current === id) {
        editingIdRef.current = null;
        setEditingId(null);
        setForm(EMPTY_FORM);
      }
      await loadPromotions();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'PROMOTION_CURRENT_CONFLICT') {
        if (editingIdRef.current === id) {
          editingIdRef.current = null;
          setEditingId(null);
          setForm(EMPTY_FORM);
        }
        await loadPromotions();
      }
      setActionError(err instanceof Error ? err.message : 'Update failed');
    } finally {
      setSaving(false);
    }
  };

  const handleTransition = async (id: string, status: PromotionStatus, reason?: string) => {
    setActionError(null);
    try {
      await transitionPromotionStatus(id, status, reason);
      if (editingIdRef.current === id) {
        editingIdRef.current = null;
        setEditingId(null);
        setForm(EMPTY_FORM);
      }
      await loadPromotions();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'PROMOTION_CURRENT_CONFLICT') {
        if (editingIdRef.current === id) {
          editingIdRef.current = null;
          setEditingId(null);
          setForm(EMPTY_FORM);
        }
        await loadPromotions();
      }
      setActionError(err instanceof Error ? err.message : 'Status transition failed');
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this draft promotion?')) return;
    setActionError(null);
    try {
      await deletePromotion(id);
      if (editingIdRef.current === id) {
        editingIdRef.current = null;
        setEditingId(null);
        setForm(EMPTY_FORM);
      }
      await loadPromotions();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'PROMOTION_CURRENT_CONFLICT') {
        if (editingIdRef.current === id) {
          editingIdRef.current = null;
          setEditingId(null);
          setForm(EMPTY_FORM);
        }
        await loadPromotions();
      }
      setActionError(err instanceof Error ? err.message : 'Delete failed');
    }
  };

  const startEdit = (p: PromotionRecord) => {
    editingIdRef.current = p.promotionId;
    setEditingId(p.promotionId);
    setShowCreate(false);
    setForm({
      displayName: p.displayName,
      description: p.description,
      maxParticipants: String(p.maxParticipants),
      perUserGasAllowanceMist: p.perUserGasAllowanceMist,
      postClaimUseWindowDays: postClaimWindowMsToDaysInput(p.postClaimUseWindowMs),
      claimDeadlineAt: p.claimDeadlineAt ? p.claimDeadlineAt.slice(0, 16) : '',
    });
  };

  // ── Status summary cards ──────────────────────────────────────
  const counts = {
    total: promotions.length,
    active: promotions.filter((p) => p.status === 'active').length,
    draft: promotions.filter((p) => p.status === 'draft').length,
    paused: promotions.filter((p) => p.status === 'paused').length,
    archived: promotions.filter((p) => p.status === 'archived').length,
  };

  return (
    <div>
      <div className="admin-page-header">
        <h2>Promotions</h2>
        <button
          type="button"
          className="admin-btn admin-btn-primary"
          disabled={saving}
          onClick={() => {
            setShowCreate(true);
            editingIdRef.current = null;
            setEditingId(null);
            setForm(EMPTY_FORM);
          }}
        >
          + New Promotion
        </button>
      </div>

      {/* Summary cards */}
      <div className="admin-stat-row" style={{ marginBottom: 20 }}>
        <div className="admin-stat-card">
          <div className="admin-stat-label">Total</div>
          <div className="admin-stat-value">{counts.total}</div>
        </div>
        <div className="admin-stat-card">
          <div className="admin-stat-label">Active</div>
          <div className="admin-stat-value" style={{ color: '#34d399' }}>
            {counts.active}
          </div>
        </div>
        <div className="admin-stat-card">
          <div className="admin-stat-label">Draft</div>
          <div className="admin-stat-value">{counts.draft}</div>
        </div>
        <div className="admin-stat-card">
          <div className="admin-stat-label">Paused</div>
          <div className="admin-stat-value" style={{ color: '#fbbf24' }}>
            {counts.paused}
          </div>
        </div>
      </div>

      {/* Filter */}
      <div style={{ marginBottom: 16 }}>
        <select
          id="promo-status-filter"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as PromotionStatus | '')}
          className="admin-select"
        >
          <option value="">All Statuses</option>
          <option value="draft">Draft</option>
          <option value="active">Active</option>
          <option value="paused">Paused</option>
          <option value="archived">Archived</option>
        </select>
      </div>

      {actionError && (
        <div className="admin-alert admin-alert-error" style={{ marginBottom: 12 }}>
          {actionError}
        </div>
      )}

      {/* Create / Edit form */}
      {(showCreate || editingId) && (
        <div className="admin-card" style={{ marginBottom: 20, padding: 20 }}>
          <h3 style={{ marginBottom: 12 }}>{editingId ? 'Edit Promotion' : 'Create Promotion'}</h3>
          <div className="admin-form-grid">
            <label htmlFor="promo-name">
              Display Name
              <input
                id="promo-name"
                type="text"
                className="admin-input"
                value={form.displayName}
                onChange={(e) => setForm({ ...form, displayName: e.target.value })}
                placeholder="e.g. Launch Week Gas Sponsorship"
              />
            </label>
            <label htmlFor="promo-desc">
              Description
              <input
                id="promo-desc"
                type="text"
                className="admin-input"
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                placeholder="Optional description"
              />
            </label>
            {!editingId && (
              <div style={{ fontSize: 13, color: '#94a3b8', padding: '4px 0' }}>
                Type: <strong>Gas Sponsorship</strong>
                <span style={{ fontSize: 11, marginLeft: 8 }}>
                  (only creatable type in this version)
                </span>
              </div>
            )}
            <label htmlFor="promo-max">
              Max Participants (required, must be {'>'} 0)
              <input
                id="promo-max"
                type="number"
                className="admin-input"
                value={form.maxParticipants}
                onChange={(e) => setForm({ ...form, maxParticipants: e.target.value })}
                min="1"
              />
            </label>
            <label htmlFor="promo-allowance">
              Per-User Gas Allowance (MIST)
              <input
                id="promo-allowance"
                type="text"
                className="admin-input"
                value={form.perUserGasAllowanceMist}
                onChange={(e) => setForm({ ...form, perUserGasAllowanceMist: e.target.value })}
                placeholder="e.g. 10000000"
              />
            </label>
            <div>
              <div style={{ fontSize: 12, color: '#64748b', marginBottom: 4 }}>
                Derived Total Required Budget (preview)
              </div>
              <div
                style={{
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: 15,
                  fontWeight: 600,
                  color: '#e2e8f0',
                }}
              >
                {formatMist(previewBudget(form.maxParticipants, form.perUserGasAllowanceMist))}
              </div>
              {(parseSafeIntegerString(form.maxParticipants.trim()) ?? 0) <= 0 && (
                <div style={{ fontSize: 11, color: '#fbbf24', marginTop: 2 }}>
                  ⚠ maxParticipants must be a positive safe integer (≤ 2^53 − 1) for gas sponsorship
                </div>
              )}
            </div>
            <label htmlFor="promo-post-claim">
              Post-Claim Use Window (days, 0 = unlimited)
              <input
                id="promo-post-claim"
                type="number"
                className="admin-input"
                value={form.postClaimUseWindowDays}
                onChange={(e) => setForm({ ...form, postClaimUseWindowDays: e.target.value })}
                min="0"
              />
            </label>
            <label htmlFor="promo-deadline">
              Claim Deadline (optional)
              <input
                id="promo-deadline"
                type="datetime-local"
                className="admin-input"
                value={form.claimDeadlineAt}
                onChange={(e) => setForm({ ...form, claimDeadlineAt: e.target.value })}
              />
            </label>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button
              type="button"
              className="admin-btn admin-btn-primary"
              disabled={saving || !form.displayName}
              onClick={() => (editingId ? handleUpdate(editingId) : handleCreate())}
            >
              {saving ? 'Saving…' : editingId ? 'Update' : 'Create'}
            </button>
            <button
              type="button"
              className="admin-btn"
              disabled={saving}
              onClick={() => {
                setShowCreate(false);
                editingIdRef.current = null;
                setEditingId(null);
                setForm(EMPTY_FORM);
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Promotions list */}
      {loading ? (
        <div className="admin-loading">Loading…</div>
      ) : error ? (
        <div className="admin-alert admin-alert-error">{error}</div>
      ) : promotions.length === 0 ? (
        <div className="admin-empty">No promotions found.</div>
      ) : (
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Type</th>
                <th>Status</th>
                <th>Participants</th>
                <th>Budget</th>
                <th>Allowance/User</th>
                <th>Created</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {promotions.map((p) => (
                <tr key={p.promotionId}>
                  <td>
                    <strong>{p.displayName}</strong>
                    {p.description && (
                      <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 2 }}>
                        {p.description}
                      </div>
                    )}
                  </td>
                  <td style={{ fontSize: 12, textTransform: 'capitalize' }}>
                    {p.type.replace('_', ' ')}
                  </td>
                  <td>
                    <StatusBadge status={p.status} />
                  </td>
                  <td>{p.maxParticipants}</td>
                  <td style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12 }}>
                    {formatMist(p.totalRequiredBudgetMist)}
                  </td>
                  <td style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12 }}>
                    {formatMist(p.perUserGasAllowanceMist)}
                  </td>
                  <td style={{ fontSize: 12, color: '#94a3b8' }}>
                    {new Date(p.createdAt).toLocaleDateString()}
                  </td>
                  <td>
                    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                      {p.status === 'draft' && (
                        <>
                          <button
                            type="button"
                            className="admin-btn admin-btn-sm"
                            disabled={saving}
                            onClick={() => startEdit(p)}
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            className="admin-btn admin-btn-sm admin-btn-primary"
                            onClick={() => handleTransition(p.promotionId, 'active')}
                          >
                            Activate
                          </button>
                          <button
                            type="button"
                            className="admin-btn admin-btn-sm admin-btn-danger"
                            onClick={() => handleDelete(p.promotionId)}
                          >
                            Delete
                          </button>
                        </>
                      )}
                      {p.status === 'active' && (
                        <>
                          <button
                            type="button"
                            className="admin-btn admin-btn-sm"
                            onClick={() => {
                              const reason = prompt('Pause reason (optional):');
                              handleTransition(p.promotionId, 'paused', reason ?? undefined);
                            }}
                          >
                            Pause
                          </button>
                          <button
                            type="button"
                            className="admin-btn admin-btn-sm admin-btn-danger"
                            onClick={() => {
                              const reason = prompt('Archive reason (optional):');
                              handleTransition(p.promotionId, 'archived', reason ?? undefined);
                            }}
                          >
                            Archive
                          </button>
                        </>
                      )}
                      {p.status === 'paused' && (
                        <>
                          <button
                            type="button"
                            className="admin-btn admin-btn-sm admin-btn-primary"
                            onClick={() => handleTransition(p.promotionId, 'active')}
                          >
                            Resume
                          </button>
                          <button
                            type="button"
                            className="admin-btn admin-btn-sm admin-btn-danger"
                            onClick={() => {
                              const reason = prompt('Archive reason (optional):');
                              handleTransition(p.promotionId, 'archived', reason ?? undefined);
                            }}
                          >
                            Archive
                          </button>
                        </>
                      )}
                      {p.status === 'archived' && (
                        <span style={{ fontSize: 11, color: '#64748b' }}>
                          {p.archiveReason || 'Archived'}
                        </span>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
