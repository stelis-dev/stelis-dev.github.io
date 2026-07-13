/**
 * API client for app-admin → app-api communication.
 *
 * All requests use `credentials: 'include'` for cookie-based auth.
 * In dev, Vite proxy forwards /auth, /api, /relay, /studio to app-api.
 * In prod, VITE_STELIS_API_URL provides the base URL (same pattern as
 * app-web's RELAY_API_BASE in relayApiEndpoint.ts).
 *
 * Current auth and Sponsor Refill Account withdrawal wire types and response
 * parsers come from `@stelis/contracts`. Other admin-only routes remain local
 * because this boundary does not broaden their public contract surface.
 */

import {
  parseAdminAuthChallengeResponse,
  parseAdminAuthSuccessResponse,
  parseSponsorRefillAccountWithdrawalChallengeResponse,
  parseSponsorRefillAccountWithdrawalResponse,
  type AdminAuthVerifyRequest,
  SingleHopSettlementSwapPathResponse,
  type SponsorRefillAccountWithdrawalRequest,
  SuiNetwork,
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

async function apiFetch<T>(
  url: string,
  init?: RequestInit,
  parse?: (value: unknown) => T,
): Promise<T> {
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
      (typeof body.code === 'string' ? body.code : undefined) ??
        (body.error as string) ??
        `HTTP_${res.status}`,
      (body.message as string) ?? (body.error as string) ?? `Request failed: ${res.status}`,
    );
  }

  const data: unknown = await res.json();
  return parse ? parse(data) : (data as T);
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

export function issueAdminAuthChallenge() {
  return apiFetch('/auth/nonce', { method: 'POST' }, parseAdminAuthChallengeResponse);
}

export async function verifyAdminAuth(data: AdminAuthVerifyRequest): Promise<void> {
  await apiFetch(
    '/auth/verify',
    {
      method: 'POST',
      body: JSON.stringify(data),
    },
    parseAdminAuthSuccessResponse,
  );
}

export async function renewAdminSession(data: AdminAuthVerifyRequest): Promise<void> {
  await apiFetch(
    '/auth/renew',
    {
      method: 'POST',
      body: JSON.stringify(data),
    },
    parseAdminAuthSuccessResponse,
  );
}

export async function logoutAdminSession(): Promise<void> {
  await apiFetch('/auth/logout', { method: 'POST' }, parseAdminAuthSuccessResponse);
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
  network: SuiNetwork;
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

export function issueSponsorRefillAccountWithdrawalChallenge() {
  return apiFetch(
    '/api/sponsor-refill-account/withdrawal-challenge',
    { method: 'POST' },
    parseSponsorRefillAccountWithdrawalChallengeResponse,
  );
}

export function executeSponsorRefillAccountWithdrawal(data: SponsorRefillAccountWithdrawalRequest) {
  return apiFetch(
    '/api/sponsor-refill-account/withdraw',
    {
      method: 'POST',
      body: JSON.stringify(data),
    },
    parseSponsorRefillAccountWithdrawalResponse,
  );
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
export type SponsoredLogsOutcome = 'success' | 'onchain_revert' | 'internal_error';

export interface SponsoredExecutionLogEntry {
  createdAt: string;
  mode: SponsoredLogsRowMode;
  outcome: SponsoredLogsOutcome;
  receiptId: string;
  digest: string | null;
  senderAddress: string;
  sponsorAddress: string;
  executionPathKey: string;
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
