/**
 * API client for app-admin → app-api communication.
 *
 * All requests use `credentials: 'include'` for cookie-based auth.
 * In dev, Vite proxy forwards /auth, /api, /relay, /studio to app-api.
 * In prod, VITE_STELIS_API_URL provides the base URL (same pattern as
 * app-web's RELAY_API_BASE in relayApiEndpoint.ts).
 *
 * Cross-package contract types used by this file (sponsor operations admin
 * payload family + settlement swap path response data) come from
 * `@stelis/contracts` as `import type` only. `DashboardPage.tsx` imports one runtime
 * withdraw-message helper from `@stelis/contracts`, while this client
 * keeps its request helpers local and intentionally type-only with
 * respect to `@stelis/contracts`.
 */

import type {
  SingleHopSettlementSwapPathResponse,
  SponsorOperationsStatus as SponsorOperationsState,
} from '@stelis/contracts';

/**
 * API base URL — platform-agnostic.
 * DEV:  empty — Vite proxy forwards relative paths.
 * PROD: VITE_STELIS_API_URL (build-time env var, e.g. https://your-api-host.example).
 */
const API_BASE = import.meta.env.DEV
  ? ''
  : (import.meta.env.VITE_STELIS_API_URL?.replace(/\/+$/, '') ?? '');

export function buildApiUrl(path: string): string {
  return `${API_BASE}${path}`;
}

// ── Typed fetch wrapper ────────────────────────────────────────────────────

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function apiFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(buildApiUrl(url), {
    ...init,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    throw new ApiError(
      res.status,
      (body.error as string) ?? `HTTP_${res.status}`,
      (body.message as string) ?? (body.error as string) ?? `Request failed: ${res.status}`,
    );
  }

  return res.json() as Promise<T>;
}

// ── Session ────────────────────────────────────────────────────────────────

export interface Session {
  address: string;
  exp: number;
  iat: number;
}

export function getSession(): Promise<Session> {
  return apiFetch<Session>('/auth/session');
}

export function getNonce(): Promise<{ nonce: string }> {
  return apiFetch<{ nonce: string }>('/auth/nonce');
}

export function verifySignature(data: {
  nonce: string;
  signature: string;
  address: string;
}): Promise<void> {
  return apiFetch('/auth/verify', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function renewSession(data: {
  nonce: string;
  signature: string;
  address: string;
}): Promise<void> {
  return apiFetch('/auth/renew', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function logout(): Promise<void> {
  return apiFetch('/auth/logout', { method: 'POST' });
}

// ── Sponsor Operations / Dashboard ─────────────────────────────────────────

interface FeeConfig {
  maxHostFeeMist: string;
  protocolFlatFeeMist: string;
  maxClaimMist: string;
  minSettleMist: string;
  configVersion: string;
}

export interface SponsorOperationsStatus {
  // `/api/sponsor-operations` runs a bounded sponsor refill account probe and reads the shared Redis
  // state on every request after boot-time sync. The field is always a
  // concrete payload.
  sponsorOperations: SponsorOperationsState;
  primaryAddress: string | null;
  settlementPayoutRecipientAddress: string;
  network: string;
  sponsorBalanceWarnMist?: string;
  sponsorBalanceRefillTargetMist?: string;
  feeConfig: FeeConfig | null;
  /**
   * Subset of `SingleHopSettlementSwapPathResponse` consumed by admin pages. Fields
   * `lotSize`, `minSize`, and `settlementTokenDecimals` are omitted because
   * admin never reads them. The shared transport type lives in
   * `@stelis/contracts` (type-only import above); drift is prevented at
   * type-check time by deriving this subset from it directly.
   */
  supportedSettlementSwapPaths: Array<
    Pick<
      SingleHopSettlementSwapPathResponse,
      | 'settlementTokenSymbol'
      | 'settlementTokenType'
      | 'settlementSwapDirection'
      | 'hops'
      | 'effectiveFeeRateBps'
    >
  >;
  // Config-page fields (also returned by /api/sponsor-operations)
  quotedHostFeeMist?: string;
  onChainIds?: {
    packageId: string | null;
    configId: string | null;
    vaultRegistryId: string | null;
    deepbookPackageId: string | null;
  };
  refillEnabled?: boolean;
  studioEnabled?: boolean;
  rpcFleet?: {
    endpoints: Array<{
      url: string;
      role: 'primary' | 'secondary';
      status: 'healthy' | 'cooldown';
      cooldownRemainingMs: number;
    }>;
    totalEndpoints: number;
    healthyEndpoints: number;
  };
}

export function getSponsorOperations(): Promise<SponsorOperationsStatus> {
  return apiFetch<SponsorOperationsStatus>('/api/sponsor-operations');
}

// ── Audit Logs ─────────────────────────────────────────────────────────────

export function getAuditLogs(): Promise<{ logs: string[] }> {
  return apiFetch<{ logs: string[] }>('/api/logs');
}

// ── Blocklist ──────────────────────────────────────────────────────────────

export interface BlockEntry {
  key: string;
  ttl: number;
}

export function getBlocklist(): Promise<{ blocklist: BlockEntry[] }> {
  return apiFetch<{ blocklist: BlockEntry[] }>('/api/blocklist');
}

export function removeBlocklistEntry(key: string): Promise<void> {
  return apiFetch('/api/blocklist', {
    method: 'DELETE',
    body: JSON.stringify({ key }),
  });
}

// ── Withdraw ───────────────────────────────────────────────────────────────

export function getSponsorRefillAccountWithdrawNonce(): Promise<{
  nonce: string;
  expiresAt: string;
}> {
  return apiFetch<{ nonce: string; expiresAt: string }>('/api/sponsor-refill-account/withdraw');
}

export function executeSponsorRefillAccountWithdraw(data: {
  nonce: string;
  signature: string;
  amountMist: string;
}): Promise<{ digest: string }> {
  return apiFetch<{ digest: string }>('/api/sponsor-refill-account/withdraw', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

// ── Studio ─────────────────────────────────────────────────────────────

export interface StudioStatusResponse {
  enabled: boolean;
  config?: {
    developerJwtTrustConfigured: boolean;
    developerJwtVerifyUrlConfigured: boolean;
  };
}

export function getStudio(): Promise<StudioStatusResponse> {
  return apiFetch<StudioStatusResponse>('/api/studio');
}

// ── Promotions ────────────────────────────────────────────────────────────

type PromotionType = 'gas_sponsorship';
export type PromotionStatus = 'draft' | 'active' | 'paused' | 'archived';

export interface PromotionRecord {
  promotionId: string;
  type: PromotionType;
  displayName: string;
  description: string;
  status: PromotionStatus;
  maxParticipants: number;
  perUserGasAllowanceMist: string;
  /** Derived: maxParticipants * perUserGasAllowanceMist. Computed by API, not stored. */
  totalRequiredBudgetMist: string;
  claimDeadlineAt: string | null;
  postClaimUseWindowMs: number;
  startAt: string | null;
  pauseReason: string | null;
  archiveReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export function getPromotions(
  status?: PromotionStatus,
): Promise<{ promotions: PromotionRecord[] }> {
  const qs = status ? `?status=${status}` : '';
  return apiFetch<{ promotions: PromotionRecord[] }>(`/api/promotions${qs}`);
}

export function createPromotion(
  data: Partial<PromotionRecord>,
): Promise<{ promotion: PromotionRecord }> {
  return apiFetch<{ promotion: PromotionRecord }>('/api/promotions', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function updatePromotion(
  id: string,
  data: Partial<PromotionRecord>,
): Promise<{ promotion: PromotionRecord }> {
  return apiFetch<{ promotion: PromotionRecord }>(`/api/promotions/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export function transitionPromotionStatus(
  id: string,
  status: PromotionStatus,
  reason?: string,
): Promise<{ promotion: PromotionRecord }> {
  return apiFetch<{ promotion: PromotionRecord }>(
    `/api/promotions/${encodeURIComponent(id)}/status`,
    {
      method: 'POST',
      body: JSON.stringify({ status, reason }),
    },
  );
}

export function deletePromotion(id: string): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>(`/api/promotions/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

// ── Sponsored execution logs ───────────────────────────────────────────────

export type SponsoredLogsMode = 'all' | 'generic' | 'promotion';

export interface SponsoredExecutionAggregate {
  mode: SponsoredLogsMode;
  /** Unsigned decimal MIST string. */
  sponsoredExecutions: string;
  /** Unsigned decimal count. */
  lossCount: string;
  /** Sum of known host net rows. */
  cumulativeHostNetMist: string;
  /** Sum of negative known host net rows. */
  cumulativeLossMist: string;
}

export type SponsoredLogsRowMode = 'generic' | 'promotion';
export type SponsoredLogsEconomicsStatus = 'known' | 'unknown';

export interface SponsoredExecutionLogEntry {
  schemaVersion: 1;
  createdAt: string;
  mode: SponsoredLogsRowMode;
  outcome: string;
  receiptId: string;
  digest: string | null;
  senderAddress: string | null;
  sponsorAddress: string | null;
  slotId: string | null;
  executionPathKey: string | null;
  orderIdHash: string | null;
  promotionId: string | null;
  userId: string | null;
  recoveredGasMist: string | null;
  hostPaidGasMist: string | null;
  hostNetMist: string | null;
  /**
   * Unsigned decimal MIST string for known rows (`"0"` when fee is
   * explicitly zero). `null` when `economicsStatus === "unknown"`.
   */
  hostFeeMist: string | null;
  /**
   * Protocol fee is protocol revenue and does not enter host net.
   * Kept on the row for audit/debugging; not shown in the default log table.
   */
  protocolFeeMist: string | null;
  grossGasMist: string | null;
  storageRebateMist: string | null;
  economicsStatus: SponsoredLogsEconomicsStatus;
  failureReason: string | null;
}

export function getSponsoredLogsSummary(
  mode: SponsoredLogsMode = 'all',
): Promise<{ summary: SponsoredExecutionAggregate }> {
  return apiFetch<{ summary: SponsoredExecutionAggregate }>(
    `/api/sponsored-logs/summary?mode=${encodeURIComponent(mode)}`,
  );
}

export function getSponsoredLogs(
  mode: SponsoredLogsMode = 'all',
  limit?: number,
): Promise<{ summary: SponsoredExecutionAggregate; entries: SponsoredExecutionLogEntry[] }> {
  const qs = new URLSearchParams({ mode });
  if (limit !== undefined) qs.set('limit', String(limit));
  return apiFetch<{
    summary: SponsoredExecutionAggregate;
    entries: SponsoredExecutionLogEntry[];
  }>(`/api/sponsored-logs?${qs.toString()}`);
}
