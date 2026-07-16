/**
 * API client for app-admin → app-api communication.
 *
 * All requests use `credentials: 'include'` for cookie-based auth.
 * In dev, Vite proxy forwards /auth, /api, /relay, /studio to app-api.
 * In prod, VITE_STELIS_API_URL provides the base URL (same pattern as
 * app-web's RELAY_API_BASE in relayApiEndpoint.ts).
 *
 * Every current Admin/Auth request, success response, and coded error is
 * validated by the shared `@stelis/contracts` wire authority at this boundary.
 */

import {
  ADMIN_BLOCKLIST_READ_ERROR_CODES,
  ADMIN_BLOCKLIST_DELETE_ERROR_CODES,
  ADMIN_PROMOTION_CREATE_ERROR_CODES,
  ADMIN_PROMOTION_DELETE_ERROR_CODES,
  ADMIN_PROMOTION_LIST_ERROR_CODES,
  ADMIN_PROMOTION_STATUS_ERROR_CODES,
  ADMIN_PROMOTION_UPDATE_ERROR_CODES,
  ADMIN_AUTH_LOGOUT_ERROR_CODES,
  ADMIN_AUTH_NONCE_ERROR_CODES,
  ADMIN_AUTH_VERIFY_ERROR_CODES,
  ADMIN_READ_ERROR_CODES,
  ADMIN_SESSION_ERROR_CODES,
  ADMIN_SPONSORED_LOGS_ERROR_CODES,
  ADMIN_WITHDRAWAL_CHALLENGE_ERROR_CODES,
  ADMIN_WITHDRAWAL_ERROR_CODES,
  parseAdminAuditLogsResponse,
  parseAdminAuthChallengeResponse,
  parseAdminAuthSuccessResponse,
  parseAdminAuthVerifyRequest,
  parseAdminBlocklistDeleteRequest,
  parseAdminBlocklistDeleteResponse,
  parseAdminBlocklistQuery,
  parseAdminBlocklistResponse,
  parseAdminPromotionCreateRequest,
  parseAdminPromotionDeleteResponse,
  parseAdminPromotionListQuery,
  parseAdminPromotionListResponse,
  parseAdminPromotionResponse,
  parseAdminPromotionStatusRequest,
  parseAdminPromotionUpdateRequest,
  parseAdminSponsoredLogsQuery,
  parseAdminSessionResponse,
  parseAdminSponsoredLogsResponse,
  parseAdminSponsoredLogsSummaryResponse,
  parseAdminStudioResponse,
  parseSponsorRefillAccountWithdrawalChallengeResponse,
  parseSponsorRefillAccountWithdrawalRequest,
  parseSponsorRefillAccountWithdrawalResponse,
  parseAdminSponsorOperationsResponse,
  parseHostErrorResponse,
  type AdminPromotionCreateRequest,
  type AdminBlocklistDeleteRequest,
  type AdminBlocklistQuery,
  type AdminPromotionListQuery,
  type AdminPromotionStatusRequest,
  type AdminPromotionUpdateRequest,
  type AdminSponsoredLogsMode,
  type AdminAuthVerifyRequest,
  type HostErrorCode,
  type HostErrorMeta,
  type SponsorRefillAccountWithdrawalRequest,
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
    public code: HostErrorCode,
    message: string,
    public meta: HostErrorMeta = {},
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function apiFetch<T>(
  url: string,
  init: RequestInit | undefined,
  parse: (value: unknown) => T,
  allowedErrorCodes: readonly HostErrorCode[],
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
    const parsed = parseHostErrorResponse(await res.json(), allowedErrorCodes, res.status);
    const { error, code, ...meta } = parsed;
    throw new ApiError(res.status, code, error, meta);
  }

  const data: unknown = await res.json();
  return parse(data);
}

// ── Session ────────────────────────────────────────────────────────────────

export function getSession() {
  return apiFetch('/auth/session', undefined, parseAdminSessionResponse, ADMIN_SESSION_ERROR_CODES);
}

export function issueAdminAuthChallenge() {
  return apiFetch(
    '/auth/nonce',
    { method: 'POST' },
    parseAdminAuthChallengeResponse,
    ADMIN_AUTH_NONCE_ERROR_CODES,
  );
}

export async function verifyAdminAuth(data: AdminAuthVerifyRequest): Promise<void> {
  const request = parseAdminAuthVerifyRequest(data);
  await apiFetch(
    '/auth/verify',
    {
      method: 'POST',
      body: JSON.stringify(request),
    },
    parseAdminAuthSuccessResponse,
    ADMIN_AUTH_VERIFY_ERROR_CODES,
  );
}

export async function renewAdminSession(data: AdminAuthVerifyRequest): Promise<void> {
  const request = parseAdminAuthVerifyRequest(data);
  await apiFetch(
    '/auth/renew',
    {
      method: 'POST',
      body: JSON.stringify(request),
    },
    parseAdminAuthSuccessResponse,
    ADMIN_AUTH_VERIFY_ERROR_CODES,
  );
}

export async function logoutAdminSession(): Promise<void> {
  await apiFetch(
    '/auth/logout',
    { method: 'POST' },
    parseAdminAuthSuccessResponse,
    ADMIN_AUTH_LOGOUT_ERROR_CODES,
  );
}

// ── Sponsor Operations / Dashboard ─────────────────────────────────────────

export function getSponsorOperations() {
  return apiFetch(
    '/api/sponsor-operations',
    undefined,
    parseAdminSponsorOperationsResponse,
    ADMIN_READ_ERROR_CODES,
  );
}

// ── Audit Logs ─────────────────────────────────────────────────────────────

export function getAuditLogs() {
  return apiFetch('/api/logs', undefined, parseAdminAuditLogsResponse, ADMIN_READ_ERROR_CODES);
}

// ── Blocklist ──────────────────────────────────────────────────────────────

export function getBlocklist(query: AdminBlocklistQuery = {}) {
  const current = parseAdminBlocklistQuery(query);
  const search = new URLSearchParams();
  if (current.cursor !== null) search.set('cursor', current.cursor);
  if (query.limit !== undefined) search.set('limit', String(current.limit));
  const encoded = search.toString();
  return apiFetch(
    `/api/blocklist${encoded.length === 0 ? '' : `?${encoded}`}`,
    undefined,
    parseAdminBlocklistResponse,
    ADMIN_BLOCKLIST_READ_ERROR_CODES,
  );
}

export function removeBlocklistEntry(identity: AdminBlocklistDeleteRequest) {
  const request = parseAdminBlocklistDeleteRequest(identity);
  return apiFetch(
    '/api/blocklist',
    {
      method: 'DELETE',
      body: JSON.stringify(request),
    },
    parseAdminBlocklistDeleteResponse,
    ADMIN_BLOCKLIST_DELETE_ERROR_CODES,
  );
}

// ── Withdraw ───────────────────────────────────────────────────────────────

export function issueSponsorRefillAccountWithdrawalChallenge() {
  return apiFetch(
    '/api/sponsor-refill-account/withdrawal-challenge',
    { method: 'POST' },
    parseSponsorRefillAccountWithdrawalChallengeResponse,
    ADMIN_WITHDRAWAL_CHALLENGE_ERROR_CODES,
  );
}

export function executeSponsorRefillAccountWithdrawal(data: SponsorRefillAccountWithdrawalRequest) {
  const request = parseSponsorRefillAccountWithdrawalRequest(data);
  return apiFetch(
    '/api/sponsor-refill-account/withdraw',
    {
      method: 'POST',
      body: JSON.stringify(request),
    },
    parseSponsorRefillAccountWithdrawalResponse,
    ADMIN_WITHDRAWAL_ERROR_CODES,
  );
}

// ── Studio ─────────────────────────────────────────────────────────────

export function getStudio() {
  return apiFetch('/api/studio', undefined, parseAdminStudioResponse, ADMIN_READ_ERROR_CODES);
}

// ── Promotions ────────────────────────────────────────────────────────────

export function getPromotions(query: AdminPromotionListQuery = {}) {
  const current = parseAdminPromotionListQuery(query);
  const search = new URLSearchParams();
  if (current.status !== undefined) search.set('status', current.status);
  if (current.cursor !== null) search.set('cursor', current.cursor);
  if (query.limit !== undefined) search.set('limit', String(current.limit));
  const encoded = search.toString();
  return apiFetch(
    `/api/promotions${encoded.length === 0 ? '' : `?${encoded}`}`,
    undefined,
    parseAdminPromotionListResponse,
    ADMIN_PROMOTION_LIST_ERROR_CODES,
  );
}

export function createPromotion(data: AdminPromotionCreateRequest) {
  const request = parseAdminPromotionCreateRequest(data);
  return apiFetch(
    '/api/promotions',
    {
      method: 'POST',
      body: JSON.stringify(request),
    },
    parseAdminPromotionResponse,
    ADMIN_PROMOTION_CREATE_ERROR_CODES,
  );
}

export function updatePromotion(id: string, data: AdminPromotionUpdateRequest) {
  const request = parseAdminPromotionUpdateRequest(data);
  return apiFetch(
    `/api/promotions/${encodeURIComponent(id)}`,
    {
      method: 'PUT',
      body: JSON.stringify(request),
    },
    parseAdminPromotionResponse,
    ADMIN_PROMOTION_UPDATE_ERROR_CODES,
  );
}

export function transitionPromotionStatus(
  id: string,
  status: AdminPromotionStatusRequest['status'],
  reason?: string,
) {
  const request = parseAdminPromotionStatusRequest({
    status,
    ...(reason === undefined ? {} : { reason }),
  });
  return apiFetch(
    `/api/promotions/${encodeURIComponent(id)}/status`,
    {
      method: 'POST',
      body: JSON.stringify(request),
    },
    parseAdminPromotionResponse,
    ADMIN_PROMOTION_STATUS_ERROR_CODES,
  );
}

export function deletePromotion(id: string) {
  return apiFetch(
    `/api/promotions/${encodeURIComponent(id)}`,
    { method: 'DELETE' },
    parseAdminPromotionDeleteResponse,
    ADMIN_PROMOTION_DELETE_ERROR_CODES,
  );
}

// ── Sponsored execution logs ───────────────────────────────────────────────

export function getSponsoredLogsSummary(mode: AdminSponsoredLogsMode = 'all') {
  const query = parseAdminSponsoredLogsQuery({ mode });
  return apiFetch(
    `/api/sponsored-logs/summary?mode=${encodeURIComponent(query.mode)}`,
    undefined,
    parseAdminSponsoredLogsSummaryResponse,
    ADMIN_SPONSORED_LOGS_ERROR_CODES,
  );
}

export function getSponsoredLogs(mode: AdminSponsoredLogsMode = 'all', limit?: number) {
  const query = parseAdminSponsoredLogsQuery({
    mode,
    ...(limit === undefined ? {} : { limit: String(limit) }),
  });
  const qs = new URLSearchParams({ mode: query.mode, limit: String(query.limit) });
  return apiFetch(
    `/api/sponsored-logs?${qs.toString()}`,
    undefined,
    parseAdminSponsoredLogsResponse,
    ADMIN_SPONSORED_LOGS_ERROR_CODES,
  );
}
