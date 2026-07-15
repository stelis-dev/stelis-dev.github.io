/**
 * StelisClient — thin HTTP wrapper around a Stelis Host's Relay API and Studio routes.
 *
 * Usage:
 *   const client = new StelisClient({ endpoint: 'http://localhost:3200/relay' });
 *   const prepared = await client.prepare({ ... });
 */
import type {
  StelisClientConfig,
  StelisRequestTimeouts,
  RelayConfigResponse,
  RelayPrepareRequest,
  RelayPrepareResponse,
  RelaySponsorRequest,
  RelaySponsorResponse,
  PromotionPrepareRequest,
  PromotionPrepareResponse,
  PromotionSponsorRequest,
  PromotionSponsorResponse,
  PromotionPageQuery,
  PromotionListResponse,
  PromotionDetailResponse,
} from './types.js';
import {
  parsePromotionPrepareResponse,
  parsePromotionSponsorResponse,
  parsePromotionPageQuery,
  parsePromotionListResponse,
  parsePromotionDetailResponse,
  parseRelayConfigResponse,
  parseRelayPrepareResponse,
  parseHostErrorResponse,
  parseRelaySponsorResponse,
  parseRelayStatusResponse,
  PROMOTION_PREPARE_ERROR_CODES,
  PROMOTION_SPONSOR_ERROR_CODES,
  RELAY_CONFIG_ERROR_CODES,
  RELAY_PREPARE_ERROR_CODES,
  RELAY_SPONSOR_ERROR_CODES,
  RELAY_STATUS_ERROR_CODES,
  STUDIO_DETAIL_ERROR_CODES,
  STUDIO_LIST_ERROR_CODES,
  type HostErrorCode,
  type HostErrorMeta,
  type RelayStatusResponse,
} from '@stelis/contracts';

interface ResolvedRequestTimeouts {
  statusMs: number;
  configMs: number;
  prepareMs: number;
  sponsorMs: number;
  studioReadMs: number;
  studioWriteMs: number;
}

const DEFAULT_REQUEST_TIMEOUTS: ResolvedRequestTimeouts = {
  statusMs: 5_000,
  configMs: 5_000,
  prepareMs: 20_000,
  sponsorMs: 20_000,
  studioReadMs: 10_000,
  studioWriteMs: 20_000,
};

export class StelisApiException extends Error {
  constructor(
    public readonly code: HostErrorCode,
    message: string,
    public readonly status: number,
    /** Closed current Host error fields other than `error` and `code`. */
    public readonly meta?: HostErrorMeta,
  ) {
    super(message);
    this.name = 'StelisApiException';
  }
}

export class StelisClient {
  private readonly endpoint: string;
  /**
   * App root URL for /studio/* endpoints.
   * Derived by stripping a terminal /relay path segment from the Relay API endpoint.
   * e.g. 'http://localhost:3200/relay' → 'http://localhost:3200'
   */
  private readonly studioBase: string;
  private readonly timeouts: ResolvedRequestTimeouts;

  constructor(config: StelisClientConfig) {
    // Strip trailing slash
    this.endpoint = config.endpoint.replace(/\/+$/, '');
    // Derive studio base: strip terminal /relay segment
    this.studioBase = this.endpoint.replace(/\/relay$/, '');
    this.timeouts = resolveRequestTimeouts(config.requestTimeouts);
  }

  // ─────────────────────────────────────────
  // GET /status
  // ─────────────────────────────────────────

  async getStatus(): Promise<RelayStatusResponse> {
    return parseRelayStatusResponse(
      await this.get('/status', this.timeouts.statusMs, RELAY_STATUS_ERROR_CODES),
    );
  }

  async getConfig(): Promise<RelayConfigResponse> {
    return parseRelayConfigResponse(
      await this.get('/config', this.timeouts.configMs, RELAY_CONFIG_ERROR_CODES),
    );
  }

  // ─────────────────────────────────────────
  // POST /prepare
  // ─────────────────────────────────────────

  async prepare(
    params: RelayPrepareRequest,
    headers?: Record<string, string>,
  ): Promise<RelayPrepareResponse> {
    return parseRelayPrepareResponse(
      await this.post(
        '/prepare',
        params,
        this.timeouts.prepareMs,
        RELAY_PREPARE_ERROR_CODES,
        headers,
      ),
    );
  }

  // ─────────────────────────────────────────
  // POST /sponsor
  // ─────────────────────────────────────────

  async sponsor(
    params: RelaySponsorRequest,
    headers?: Record<string, string>,
  ): Promise<RelaySponsorResponse> {
    return parseRelaySponsorResponse(
      await this.post(
        '/sponsor',
        params,
        this.timeouts.sponsorMs,
        RELAY_SPONSOR_ERROR_CODES,
        headers,
      ),
    );
  }

  // ─────────────────────────────────────────
  // Promotion endpoints (POST /studio/promotions/:id/*)
  // ─────────────────────────────────────────

  async promotionPrepare(
    promotionId: string,
    params: PromotionPrepareRequest,
    developerJwt: string,
  ): Promise<PromotionPrepareResponse> {
    return parsePromotionPrepareResponse(
      await this.studioPost(
        `/studio/promotions/${encodeURIComponent(promotionId)}/prepare`,
        params,
        this.timeouts.studioWriteMs,
        PROMOTION_PREPARE_ERROR_CODES,
        { Authorization: `Bearer ${developerJwt}` },
      ),
    );
  }

  async promotionSponsor(
    promotionId: string,
    params: PromotionSponsorRequest,
    developerJwt: string,
  ): Promise<PromotionSponsorResponse> {
    return parsePromotionSponsorResponse(
      await this.studioPost(
        `/studio/promotions/${encodeURIComponent(promotionId)}/sponsor`,
        params,
        this.timeouts.studioWriteMs,
        PROMOTION_SPONSOR_ERROR_CODES,
        { Authorization: `Bearer ${developerJwt}` },
      ),
    );
  }

  // ─────────────────────────────────────────
  // Promotion discovery (GET /studio/promotions, developer JWT)
  // ─────────────────────────────────────────

  async listPromotions(
    developerJwt: string,
    query: PromotionPageQuery = {},
  ): Promise<PromotionListResponse> {
    const page = parsePromotionPageQuery(query);
    const search = new URLSearchParams();
    if (page.cursor !== null) search.set('cursor', page.cursor);
    if (query.limit !== undefined) search.set('limit', String(page.limit));
    const serializedQuery = search.toString();
    const suffix = serializedQuery === '' ? '' : `?${serializedQuery}`;
    return parsePromotionListResponse(
      await this.studioGet(
        `/studio/promotions${suffix}`,
        {
          Authorization: `Bearer ${developerJwt}`,
        },
        this.timeouts.studioReadMs,
        STUDIO_LIST_ERROR_CODES,
      ),
    );
  }

  async getPromotionDetail(
    promotionId: string,
    developerJwt: string,
  ): Promise<PromotionDetailResponse> {
    return parsePromotionDetailResponse(
      await this.studioGet(
        `/studio/promotions/${encodeURIComponent(promotionId)}`,
        { Authorization: `Bearer ${developerJwt}` },
        this.timeouts.studioReadMs,
        STUDIO_DETAIL_ERROR_CODES,
      ),
    );
  }

  // ─────────────────────────────────────────
  // Internal HTTP helpers
  // ─────────────────────────────────────────

  private async get(
    path: string,
    timeoutMs: number,
    allowedErrorCodes: readonly HostErrorCode[],
  ): Promise<unknown> {
    const res = await fetch(`${this.endpoint}${path}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return this.handleResponse(res, allowedErrorCodes);
  }

  private async post(
    path: string,
    body: unknown,
    timeoutMs: number,
    allowedErrorCodes: readonly HostErrorCode[],
    extraHeaders?: Record<string, string>,
  ): Promise<unknown> {
    const res = await fetch(`${this.endpoint}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...extraHeaders },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return this.handleResponse(res, allowedErrorCodes);
  }

  /** GET against studioBase (for /studio/* endpoints). */
  private async studioGet(
    path: string,
    headers: Record<string, string>,
    timeoutMs: number,
    allowedErrorCodes: readonly HostErrorCode[],
  ): Promise<unknown> {
    const res = await fetch(`${this.studioBase}${path}`, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    return this.handleResponse(res, allowedErrorCodes);
  }

  /** POST against studioBase (for /studio/* endpoints). */
  private async studioPost(
    path: string,
    body: unknown,
    timeoutMs: number,
    allowedErrorCodes: readonly HostErrorCode[],
    headers: Record<string, string>,
  ): Promise<unknown> {
    const res = await fetch(`${this.studioBase}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return this.handleResponse(res, allowedErrorCodes);
  }

  private async handleResponse(
    res: Response,
    allowedErrorCodes: readonly HostErrorCode[],
  ): Promise<unknown> {
    const raw = await res.text();
    const data = parseJsonIfPossible(raw);

    if (!res.ok) {
      let apiError;
      try {
        apiError = parseHostErrorResponse(data, allowedErrorCodes, res.status);
      } catch {
        throw new Error(`Stelis Host returned a non-current error response (HTTP ${res.status})`);
      }
      let extra: HostErrorMeta | undefined;
      const { error: _error, code: _code, ...currentMeta } = apiError;
      if (Object.keys(currentMeta).length > 0) extra = currentMeta;
      throw new StelisApiException(
        apiError.code,
        apiError.error,
        res.status,
        extra && Object.keys(extra).length > 0 ? extra : undefined,
      );
    }

    if (data === undefined) {
      // Successful HTTP status with a non-JSON body indicates an invalid Host response.
      throw new Error(`Stelis Host returned a non-JSON success response (HTTP ${res.status})`);
    }

    return data;
  }
}

function resolveRequestTimeouts(overrides?: StelisRequestTimeouts): ResolvedRequestTimeouts {
  const o = overrides ?? {};
  return {
    statusMs: resolveTimeoutMs('statusMs', o.statusMs, DEFAULT_REQUEST_TIMEOUTS.statusMs),
    configMs: resolveTimeoutMs('configMs', o.configMs, DEFAULT_REQUEST_TIMEOUTS.configMs),
    prepareMs: resolveTimeoutMs('prepareMs', o.prepareMs, DEFAULT_REQUEST_TIMEOUTS.prepareMs),
    sponsorMs: resolveTimeoutMs('sponsorMs', o.sponsorMs, DEFAULT_REQUEST_TIMEOUTS.sponsorMs),
    studioReadMs: resolveTimeoutMs(
      'studioReadMs',
      o.studioReadMs,
      DEFAULT_REQUEST_TIMEOUTS.studioReadMs,
    ),
    studioWriteMs: resolveTimeoutMs(
      'studioWriteMs',
      o.studioWriteMs,
      DEFAULT_REQUEST_TIMEOUTS.studioWriteMs,
    ),
  };
}

function resolveTimeoutMs(name: string, value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(
      `[StelisClient] requestTimeouts.${name} must be a positive integer within Number.MAX_SAFE_INTEGER, got ${String(value)}`,
    );
  }
  return value;
}

function parseJsonIfPossible(raw: string): unknown | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}
