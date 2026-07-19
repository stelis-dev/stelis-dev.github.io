/**
 * DashboardPage — sponsor operations status, RPC fleet, service accounts, withdrawal.
 */
import { useEffect, useState, useCallback } from 'react';
import { useOutletContext } from 'react-router-dom';
import {
  ApiError,
  getSponsorOperations,
  issueSponsorRefillAccountWithdrawalChallenge,
  executeSponsorRefillAccountWithdrawal,
  getSponsoredLogsSummary,
} from '../api/client';
import { SponsoredLogsKpi } from '../components/SponsoredLogsKpi';
import {
  buildSponsorRefillAccountWithdrawMessage,
  isPositiveU64DecimalString,
  parseSponsorRefillAccountWithdrawalRequest,
  type AdminSponsorOperationsResponse,
  type AdminSponsoredExecutionAggregate,
  type SuiNetwork,
  type SponsorRefillAccountWithdrawalRequest,
  type SponsorSlotState,
} from '@stelis/contracts';
import { getWallets } from '@mysten/wallet-standard';
import { mistToSui as formatMistToSui, suiToMist, truncateAddress, CopyButton } from '../utils';
import type { SuiSignPersonalMessageFeature } from '../types';
import type { AuthContext } from '../components/AuthGuard';

// ── Helpers ────────────────────────────────────────────────────────────────

function formatOptionalMistToSui(amountMist: string | null | undefined): string | null {
  if (amountMist == null) return null;
  try {
    return formatMistToSui(amountMist);
  } catch {
    return null;
  }
}

const SLOT_STATE_COLOR: Record<SponsorSlotState, string> = {
  healthy: '#22c55e',
  low_balance: '#ef4444',
  refilling: '#f59e0b',
  rpc_unreachable: '#64748b',
  refill_failed: '#ef4444',
};

const SLOT_STATE_LABEL: Record<SponsorSlotState, string> = {
  healthy: '● Healthy',
  low_balance: '● Low balance',
  refilling: '● Refilling',
  rpc_unreachable: '○ RPC unreachable',
  refill_failed: '● Refill failed',
};

type WithdrawAmountValidation = { ok: true; amountMist: string } | { ok: false; message: string };

type WithdrawSignerResolution =
  | {
      ok: true;
      signFeature: SuiSignPersonalMessageFeature;
      suiAccount: { address: string };
    }
  | { ok: false; message: string };

interface PendingWithdrawal {
  readonly adminAddress: string;
  readonly network: SuiNetwork;
  readonly request: SponsorRefillAccountWithdrawalRequest;
}

const PENDING_WITHDRAWAL_STORAGE_KEY = 'stelis:admin:pending-withdrawal';

function readPendingWithdrawal(
  adminAddress: string | null,
  network: SuiNetwork,
): PendingWithdrawal | null {
  try {
    if (adminAddress === null) {
      sessionStorage.removeItem(PENDING_WITHDRAWAL_STORAGE_KEY);
      return null;
    }
    const raw = sessionStorage.getItem(PENDING_WITHDRAWAL_STORAGE_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed) ||
      Object.keys(parsed).some(
        (key) => key !== 'adminAddress' && key !== 'network' && key !== 'request',
      )
    ) {
      sessionStorage.removeItem(PENDING_WITHDRAWAL_STORAGE_KEY);
      return null;
    }
    const envelope = parsed as Record<string, unknown>;
    if (envelope.adminAddress !== adminAddress || envelope.network !== network) {
      sessionStorage.removeItem(PENDING_WITHDRAWAL_STORAGE_KEY);
      return null;
    }
    return {
      adminAddress,
      network,
      request: parseSponsorRefillAccountWithdrawalRequest(envelope.request),
    };
  } catch {
    try {
      sessionStorage.removeItem(PENDING_WITHDRAWAL_STORAGE_KEY);
    } catch {
      // Storage is unavailable; fail closed without retaining an in-memory request.
    }
    return null;
  }
}

function pendingWithdrawalMatchesRuntime(
  request: PendingWithdrawal,
  adminAddress: string | null,
  network: SuiNetwork,
): boolean {
  return request.adminAddress === adminAddress && request.network === network;
}

function rememberPendingWithdrawal(request: PendingWithdrawal | null): void {
  try {
    if (request === null) {
      sessionStorage.removeItem(PENDING_WITHDRAWAL_STORAGE_KEY);
    } else {
      sessionStorage.setItem(PENDING_WITHDRAWAL_STORAGE_KEY, JSON.stringify(request));
    }
  } catch {
    // The in-memory request still preserves exact retry identity for this mounted page.
  }
}

function validateWithdrawAmountInput(amount: string): WithdrawAmountValidation {
  if (amount.trim().length === 0) {
    return { ok: false, message: 'Withdrawal amount is required' };
  }
  if (amount.trim().startsWith('-')) {
    return { ok: false, message: 'Withdrawal amount must be greater than 0' };
  }

  let amountMist: string;
  try {
    amountMist = suiToMist(amount);
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : 'Invalid withdrawal amount',
    };
  }

  if (amountMist === '0') {
    return { ok: false, message: 'Withdrawal amount must be greater than 0' };
  }
  if (!isPositiveU64DecimalString(amountMist)) {
    return { ok: false, message: 'Withdrawal amount must fit a positive u64 MIST value' };
  }

  return { ok: true, amountMist };
}

function resolveWithdrawSigner(adminAddress: string): WithdrawSignerResolution {
  const signingWallets = getWallets()
    .get()
    .filter((wallet) => 'sui:signPersonalMessage' in wallet.features);

  if (signingWallets.length === 0) {
    return { ok: false, message: 'Wallet not connected' };
  }

  const suiWallet = signingWallets.find((wallet) =>
    wallet.accounts.some((account) => account.address === adminAddress),
  );
  if (!suiWallet) {
    return { ok: false, message: 'Admin account not found' };
  }

  const suiAccount = suiWallet.accounts.find((account) => account.address === adminAddress);
  if (!suiAccount) {
    return { ok: false, message: 'Admin account not found' };
  }

  return {
    ok: true,
    signFeature: suiWallet.features['sui:signPersonalMessage'] as SuiSignPersonalMessageFeature,
    suiAccount,
  };
}

type RpcFleet = AdminSponsorOperationsResponse['rpcFleet'];

function RpcFleetCard({ rpcFleet }: { rpcFleet: RpcFleet }) {
  return (
    <div className="admin-card">
      <div className="admin-card-title">RPC Endpoints ({rpcFleet.endpoints.length} qualified)</div>
      <table className="admin-table">
        <thead>
          <tr>
            <th>Endpoint</th>
            <th>Role</th>
          </tr>
        </thead>
        <tbody>
          {rpcFleet.endpoints.map((ep, index) => (
            <tr key={`${ep.role}:${index}`}>
              <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{ep.origin}</td>
              <td>
                <span
                  style={{
                    color: ep.role === 'primary' ? '#f59e0b' : '#94a3b8',
                    fontWeight: ep.role === 'primary' ? 600 : 400,
                  }}
                >
                  {ep.role}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── WithdrawSection ────────────────────────────────────────────────────────

function WithdrawSection({
  adminAddress,
  network,
  sponsorRefillAccountAddress,
  sponsorRefillAccountBalanceSui,
  onSuccess,
}: {
  adminAddress: string | null;
  network: SuiNetwork;
  sponsorRefillAccountAddress: string | null;
  sponsorRefillAccountBalanceSui: string | null;
  onSuccess: () => void;
}) {
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingRequest, setPendingRequest] = useState<PendingWithdrawal | null>(() =>
    readPendingWithdrawal(adminAddress, network),
  );
  const amountValidation = validateWithdrawAmountInput(amount);
  const showAmountValidation = amount.trim().length > 0 && !amountValidation.ok;

  useEffect(() => {
    setPendingRequest((current) => {
      if (current === null || pendingWithdrawalMatchesRuntime(current, adminAddress, network)) {
        return current;
      }
      rememberPendingWithdrawal(null);
      return null;
    });
  }, [adminAddress, network]);

  const handleWithdraw = useCallback(async () => {
    if (!adminAddress) return;
    setResult(null);

    setBusy(true);
    setError(null);
    let request = pendingRequest;

    try {
      if (request !== null && !pendingWithdrawalMatchesRuntime(request, adminAddress, network)) {
        request = null;
        setPendingRequest(null);
        rememberPendingWithdrawal(null);
        throw new Error(
          'Pending withdrawal no longer matches the active admin account and network',
        );
      }
      if (request === null) {
        const nextAmountValidation = validateWithdrawAmountInput(amount);
        if (!nextAmountValidation.ok) throw new Error(nextAmountValidation.message);
        const signerResolution = resolveWithdrawSigner(adminAddress);
        if (!signerResolution.ok) throw new Error(signerResolution.message);

        const { nonce } = await issueSponsorRefillAccountWithdrawalChallenge();
        const amountMist = nextAmountValidation.amountMist;
        const message = buildSponsorRefillAccountWithdrawMessage(network, amountMist, nonce);
        const { signature } = await signerResolution.signFeature.signPersonalMessage({
          message: new TextEncoder().encode(message),
          account: signerResolution.suiAccount,
        });
        request = {
          adminAddress,
          network,
          request: parseSponsorRefillAccountWithdrawalRequest({ nonce, signature, amountMist }),
        };
        setPendingRequest(request);
        rememberPendingWithdrawal(request);
      }

      const { digest } = await executeSponsorRefillAccountWithdrawal(request.request);
      setPendingRequest(null);
      rememberPendingWithdrawal(null);
      setResult(`Success: ${digest}`);
      setAmount('');
      onSuccess();
    } catch (err) {
      const terminalHttpResponse =
        err instanceof ApiError &&
        (err.code === 'WITHDRAWAL_NONCE_MISSING' ||
          err.code === 'WITHDRAWAL_RUNWAY_BLOCKED' ||
          err.code === 'WITHDRAWAL_FAILED' ||
          err.code === 'WITHDRAWAL_NOT_ACCEPTED' ||
          err.code === 'WITHDRAWAL_SIGNATURE_INVALID');
      if (terminalHttpResponse) {
        setPendingRequest(null);
        rememberPendingWithdrawal(null);
      } else if (request !== null) {
        setPendingRequest(request);
        rememberPendingWithdrawal(request);
      }
      setError(err instanceof Error ? err.message : 'Withdrawal failed');
    } finally {
      setBusy(false);
    }
  }, [adminAddress, amount, network, onSuccess, pendingRequest]);

  return (
    <div className="admin-card">
      <div className="admin-card-title">
        Sponsor Refill Account Withdrawal
        <span style={{ fontSize: 12, color: '#64748b', fontWeight: 400, marginLeft: 8 }}>
          (sends SUI to Admin Wallet)
        </span>
      </div>
      <div style={{ display: 'flex', gap: 12, alignItems: 'end', flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 160 }}>
          <label
            style={{
              fontSize: 12,
              color: '#94a3b8',
              display: 'flex',
              justifyContent: 'space-between',
              marginBottom: 4,
            }}
          >
            <span>Amount (SUI)</span>
            {sponsorRefillAccountBalanceSui && (
              <span style={{ color: '#64748b' }}>Available: {sponsorRefillAccountBalanceSui}</span>
            )}
          </label>
          <input
            type="number"
            className="admin-input"
            style={{ width: '100%' }}
            placeholder="0.5"
            step="0.000000001"
            value={amount}
            disabled={pendingRequest !== null}
            onChange={(e) => {
              setAmount(e.target.value);
              setError(null);
            }}
            min="0.000000001"
          />
          {showAmountValidation && (
            <div style={{ fontSize: 11, color: '#fbbf24', marginTop: 4 }}>
              {amountValidation.message}
            </div>
          )}
        </div>
        <button
          className="admin-btn admin-btn-primary"
          style={{ whiteSpace: 'nowrap' }}
          disabled={busy || !adminAddress || (pendingRequest === null && !amountValidation.ok)}
          onClick={() => void handleWithdraw()}
        >
          {busy ? 'Processing…' : pendingRequest === null ? 'Withdraw' : 'Retry pending withdrawal'}
        </button>
      </div>
      {pendingRequest && (
        <div style={{ fontSize: 11, color: '#fbbf24', marginTop: 6 }}>
          Pending signed request: {pendingRequest.request.amountMist} MIST
        </div>
      )}
      <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 10, lineHeight: 1.6 }}>
        <span style={{ fontFamily: 'monospace' }}>
          {sponsorRefillAccountAddress ? truncateAddress(sponsorRefillAccountAddress) : '—'}
        </span>
        <span style={{ color: '#64748b', margin: '0 6px' }}>→</span>
        <span style={{ fontFamily: 'monospace' }}>
          {adminAddress ? truncateAddress(adminAddress) : '—'}
        </span>
        <span style={{ color: '#64748b', marginLeft: 8 }}>
          (Sponsor Refill Account → Admin Wallet)
        </span>
      </div>
      {result && <p style={{ color: '#22c55e', fontSize: 13, marginTop: 8 }}>{result}</p>}
      {error && <p style={{ color: '#f87171', fontSize: 13, marginTop: 8 }}>{error}</p>}
    </div>
  );
}

// ── DashboardPage ──────────────────────────────────────────────────────────

export function DashboardPage() {
  const { session } = useOutletContext<AuthContext>();
  const [data, setData] = useState<AdminSponsorOperationsResponse | null>(null);
  const [error, setError] = useState('');
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const [sponsoredSummary, setSponsoredSummary] = useState<AdminSponsoredExecutionAggregate | null>(
    null,
  );
  const [sponsoredLoading, setSponsoredLoading] = useState(false);

  const poll = useCallback(async () => {
    try {
      const sponsorOperationsJson = await getSponsorOperations();
      setData(sponsorOperationsJson);
      setLastUpdated(new Date());
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch sponsor operations data');
    }
  }, []);

  const pollSponsored = useCallback(async () => {
    setSponsoredLoading(true);
    try {
      const res = await getSponsoredLogsSummary('all');
      setSponsoredSummary(res.summary);
    } catch {
      // Silent — Dashboard tile shows placeholder; SponsoredLogsPage
      // shows detailed errors.
    } finally {
      setSponsoredLoading(false);
    }
  }, []);

  useEffect(() => {
    void poll();
    void pollSponsored();
    const interval = setInterval(() => void poll(), 15_000);
    const sponsoredInterval = setInterval(() => void pollSponsored(), 30_000);
    return () => {
      clearInterval(interval);
      clearInterval(sponsoredInterval);
    };
  }, [poll, pollSponsored]);

  if (!data) {
    return (
      <>
        <h1 className="admin-page-title">Dashboard</h1>
        <p className="admin-page-sub">Loading…</p>
        {error && <p style={{ color: '#f87171' }}>{error}</p>}
        <div className="admin-stat-grid" style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
          {['Network', 'Sponsor Slots'].map((label) => (
            <div className="admin-stat" key={label}>
              <div className="admin-stat-label">{label}</div>
              <div
                className="skeleton skeleton-line"
                style={{ width: '50%', height: 24, marginTop: 4 }}
              />
            </div>
          ))}
        </div>
      </>
    );
  }

  // `/admin/sponsor-operations` always returns a concrete sponsor operations payload. Boot
  // sync populates sponsor operations state before requests, and the admin
  // route probes the sponsor refill account before it reads the shared state.
  const sponsorOperations = data.sponsorOperations;
  const sponsorRefillAccountAddress = sponsorOperations.sponsorRefillAccount.address;
  const sponsorRefillAccountBalanceSui = formatOptionalMistToSui(
    sponsorOperations.sponsorRefillAccount.totalBalanceMist,
  );
  const healthySlots = sponsorOperations.healthySlots;
  const degradedSlots = sponsorOperations.degradedSlots;
  const leasedSlots = sponsorOperations.slotLeases.leasedSlots;
  const freeSlots = sponsorOperations.slotLeases.freeSlots;
  const slotLeaseByAddress = new Map(
    sponsorOperations.slotLeases.slots.map((slot) => [slot.address, slot.leased]),
  );
  const gatePaused = sponsorOperations.gateErrorCode !== null;
  const gateReason = sponsorOperations.gateErrorCode;

  return (
    <>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 6,
        }}
      >
        <h1 className="admin-page-title" style={{ marginBottom: 0 }}>
          Dashboard
        </h1>
        <button className="admin-btn admin-btn-primary" onClick={() => void poll()}>
          Refresh
        </button>
      </div>
      <p className="admin-page-sub">
        {lastUpdated ? `Last updated: ${lastUpdated.toLocaleTimeString()}` : 'Loading…'}
      </p>

      {error && <p style={{ color: '#f87171', marginBottom: 20 }}>{error}</p>}

      {/* Stat grid */}
      <div className="admin-stat-grid" style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
        <div className="admin-stat">
          <div className="admin-stat-label">Network</div>
          <div className="admin-stat-value" style={{ fontSize: 18 }}>
            {data.network ?? '—'}
          </div>
        </div>
        <div className="admin-stat">
          <div className="admin-stat-label">Sponsor Slots</div>
          <div className="admin-stat-value" style={{ display: 'grid', gap: 4, fontSize: 13 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
              <span style={{ color: '#64748b' }}>Healthy</span>
              <span style={{ color: healthySlots > 0 ? '#22c55e' : '#64748b', fontWeight: 700 }}>
                {healthySlots}
              </span>
              <span style={{ color: '#64748b' }}>Degraded</span>
              <span style={{ color: degradedSlots > 0 ? '#ef4444' : '#64748b', fontWeight: 700 }}>
                {degradedSlots}
              </span>
            </div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
              <span style={{ color: '#64748b' }}>Leased</span>
              <span style={{ color: leasedSlots > 0 ? '#f59e0b' : '#64748b', fontWeight: 700 }}>
                {leasedSlots}
              </span>
              <span style={{ color: '#64748b' }}>Free</span>
              <span style={{ color: freeSlots > 0 ? '#22c55e' : '#64748b', fontWeight: 700 }}>
                {freeSlots}
              </span>
            </div>
          </div>
          <div
            style={{
              color: gatePaused ? '#ef4444' : '#22c55e',
              fontSize: 12,
              fontWeight: 700,
              marginTop: 6,
            }}
            title="The aggregate sponsor operations gate closes /prepare with 503 when no healthy, free sponsor slot is available. /sponsor checks the exact slot already leased to its receipt."
          >
            {gatePaused ? `Closed — ${gateReason ?? 'unknown'}` : 'Open'}
          </div>
        </div>
      </div>

      {/* Sponsored logs KPI (mode = all) */}
      <div style={{ marginBottom: 20 }}>
        <SponsoredLogsKpi summary={sponsoredSummary} loading={sponsoredLoading} />
      </div>

      {/* Qualified RPC endpoints */}
      <RpcFleetCard rpcFleet={data.rpcFleet} />

      {/* Service Accounts */}
      <div className="admin-card">
        <div className="admin-card-title">Service Accounts</div>
        <table className="admin-table">
          <thead>
            <tr>
              <th>Role</th>
              <th>Address</th>
              <th>Balance (SUI)</th>
              <th>Lease</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Settlement Payout Recipient</td>
              <td
                style={{ fontFamily: 'monospace', fontSize: 13 }}
                title={data.settlementPayoutRecipientAddress}
              >
                {data.settlementPayoutRecipientAddress
                  ? truncateAddress(data.settlementPayoutRecipientAddress)
                  : '—'}{' '}
                {data.settlementPayoutRecipientAddress && (
                  <CopyButton value={data.settlementPayoutRecipientAddress} />
                )}
              </td>
              <td style={{ color: '#64748b', fontStyle: 'italic' }}>n/a</td>
              <td style={{ color: '#64748b', fontStyle: 'italic' }}>n/a</td>
              <td style={{ color: '#64748b', fontStyle: 'italic' }}>n/a</td>
            </tr>
            <tr>
              <td>Sponsor Refill Account</td>
              <td
                style={{ fontFamily: 'monospace', fontSize: 13 }}
                title={sponsorRefillAccountAddress ?? undefined}
              >
                {sponsorRefillAccountAddress ? truncateAddress(sponsorRefillAccountAddress) : '—'}{' '}
                {sponsorRefillAccountAddress && <CopyButton value={sponsorRefillAccountAddress} />}
              </td>
              <td>{sponsorRefillAccountBalanceSui ?? '—'}</td>
              <td style={{ color: '#64748b', fontStyle: 'italic' }}>n/a</td>
              <td
                style={{
                  fontWeight: 600,
                  color: sponsorOperations.sponsorRefillAccount.healthy ? '#22c55e' : '#ef4444',
                }}
              >
                {sponsorOperations.sponsorRefillAccount.healthy ? 'Healthy' : 'Unavailable'}
              </td>
            </tr>
            {sponsorOperations?.slots.map((slot) => {
              const leased = slotLeaseByAddress.get(slot.address);
              return (
                <tr key={slot.address}>
                  <td>Sponsor</td>
                  <td style={{ fontFamily: 'monospace', fontSize: 13 }} title={slot.address}>
                    {truncateAddress(slot.address)} <CopyButton value={slot.address} />
                  </td>
                  <td>{formatOptionalMistToSui(slot.addressBalanceMist) ?? '—'}</td>
                  <td
                    style={{
                      color: leased === undefined ? '#64748b' : leased ? '#f59e0b' : '#22c55e',
                      fontWeight: 600,
                    }}
                  >
                    {leased === undefined ? 'Unknown' : leased ? 'Leased' : 'Free'}
                  </td>
                  <td
                    style={{
                      color: SLOT_STATE_COLOR[slot.state],
                      fontWeight: 600,
                    }}
                  >
                    {SLOT_STATE_LABEL[slot.state]}
                  </td>
                </tr>
              );
            })}
            {sponsorOperations && sponsorOperations.slots.length === 0 && (
              <tr>
                <td colSpan={5} style={{ color: '#64748b', fontStyle: 'italic' }}>
                  No sponsor slots configured
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Withdrawal */}
      <WithdrawSection
        adminAddress={session?.address ?? null}
        network={data.network}
        sponsorRefillAccountAddress={sponsorRefillAccountAddress}
        sponsorRefillAccountBalanceSui={sponsorRefillAccountBalanceSui}
        onSuccess={poll}
      />
    </>
  );
}
