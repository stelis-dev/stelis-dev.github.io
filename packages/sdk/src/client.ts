/**
 * StelisClient — thin HTTP wrapper around the Relay API.
 *
 * Usage:
 *   const client = new StelisClient({ endpoint: 'http://localhost:3200/relay' });
 *   const prepared = await client.prepare({ ... });
 */
import type {
  StelisClientConfig,
  StelisRequestTimeouts,
  StatusResponse,
  PrepareParams,
  PrepareResponse,
  SponsorParams,
  SponsorResponse,
  StelisApiError,
  PromotionPrepareParams,
  PromotionPrepareResponse,
  PromotionSponsorParams,
  PromotionSponsorResponse,
  PromotionListResponse,
  PromotionDetailResponse,
} from './types.js';

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
    public readonly code: string,
    message: string,
    public readonly status: number,
    /** Extra fields from the API error response (e.g. minSettleMist, subcode). */
    public readonly meta?: Record<string, unknown>,
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

  async getStatus(): Promise<StatusResponse> {
    return this.get<StatusResponse>('/status', this.timeouts.statusMs);
  }

  // ─────────────────────────────────────────
  // POST /prepare
  // ─────────────────────────────────────────

  async prepare(params: PrepareParams, headers?: Record<string, string>): Promise<PrepareResponse> {
    return this.post<PrepareResponse>('/prepare', params, this.timeouts.prepareMs, headers);
  }

  // ─────────────────────────────────────────
  // POST /sponsor
  // ─────────────────────────────────────────

  async sponsor(params: SponsorParams, headers?: Record<string, string>): Promise<SponsorResponse> {
    return this.post<SponsorResponse>('/sponsor', params, this.timeouts.sponsorMs, headers);
  }

  // ─────────────────────────────────────────
  // Promotion endpoints (POST /studio/promotions/:id/*)
  // ─────────────────────────────────────────

  async promotionPrepare(
    promotionId: string,
    params: PromotionPrepareParams,
    developerJwt: string,
  ): Promise<PromotionPrepareResponse> {
    return this.studioPost<PromotionPrepareResponse>(
      `/studio/promotions/${encodeURIComponent(promotionId)}/prepare`,
      params,
      this.timeouts.studioWriteMs,
      { Authorization: `Bearer ${developerJwt}` },
    );
  }

  async promotionSponsor(
    promotionId: string,
    params: PromotionSponsorParams,
    developerJwt: string,
  ): Promise<PromotionSponsorResponse> {
    return this.studioPost<PromotionSponsorResponse>(
      `/studio/promotions/${encodeURIComponent(promotionId)}/sponsor`,
      params,
      this.timeouts.studioWriteMs,
      { Authorization: `Bearer ${developerJwt}` },
    );
  }

  // ─────────────────────────────────────────
  // Promotion discovery (GET /studio/promotions, developer JWT)
  // ─────────────────────────────────────────

  async listPromotions(developerJwt: string): Promise<PromotionListResponse> {
    return this.studioGet<PromotionListResponse>(
      '/studio/promotions',
      {
        Authorization: `Bearer ${developerJwt}`,
      },
      this.timeouts.studioReadMs,
    );
  }

  async getPromotionDetail(
    promotionId: string,
    developerJwt: string,
  ): Promise<PromotionDetailResponse> {
    return this.studioGet<PromotionDetailResponse>(
      `/studio/promotions/${encodeURIComponent(promotionId)}`,
      { Authorization: `Bearer ${developerJwt}` },
      this.timeouts.studioReadMs,
    );
  }

  // ─────────────────────────────────────────
  // Internal HTTP helpers
  // ─────────────────────────────────────────

  private async get<T>(path: string, timeoutMs: number): Promise<T> {
    const res = await fetch(`${this.endpoint}${path}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return this.handleResponse<T>(res);
  }

  private async post<T>(
    path: string,
    body: unknown,
    timeoutMs: number,
    extraHeaders?: Record<string, string>,
  ): Promise<T> {
    const res = await fetch(`${this.endpoint}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...extraHeaders },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return this.handleResponse<T>(res);
  }

  /** GET against studioBase (for /studio/* endpoints). */
  private async studioGet<T>(
    path: string,
    headers: Record<string, string>,
    timeoutMs: number,
  ): Promise<T> {
    const res = await fetch(`${this.studioBase}${path}`, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    return this.handleResponse<T>(res);
  }

  /** POST against studioBase (for /studio/* endpoints). */
  private async studioPost<T>(
    path: string,
    body: unknown,
    timeoutMs: number,
    headers: Record<string, string>,
  ): Promise<T> {
    const res = await fetch(`${this.studioBase}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return this.handleResponse<T>(res);
  }

  private async handleResponse<T>(res: Response): Promise<T> {
    const raw = await res.text();
    const data = parseJsonIfPossible(raw);

    if (!res.ok) {
      const code = isStelisApiError(data) ? data.code : 'UNKNOWN';
      const message = isStelisApiError(data)
        ? data.error
        : (summarizeHttpBody(raw) ?? res.statusText ?? `HTTP ${res.status}`);
      // Preserve extra fields (minSettleMist, requiredTotalIn, subcode, etc.)
      const extra =
        typeof data === 'object' && data !== null
          ? Object.fromEntries(
              Object.entries(data as Record<string, unknown>).filter(
                ([k]) => k !== 'code' && k !== 'error',
              ),
            )
          : undefined;
      throw new StelisApiException(
        code,
        message,
        res.status,
        extra && Object.keys(extra).length > 0 ? extra : undefined,
      );
    }

    if (data === undefined) {
      // Successful HTTP status with a non-JSON body indicates an invalid Relay API response.
      // Surface the raw body snippet instead of a JSON parser SyntaxError.
      const bodyHint = summarizeHttpBody(raw);
      throw new Error(
        bodyHint
          ? `Invalid non-JSON response from Relay API: ${bodyHint}`
          : `Invalid empty response from Relay API (HTTP ${res.status})`,
      );
    }

    return data as T;
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

/**
 * Narrow an unknown API error response to StelisApiError shape.
 * Checks at runtime that `code` and `error` fields are present as strings.
 */
function isStelisApiError(value: unknown): value is StelisApiError {
  return (
    typeof value === 'object' &&
    value !== null &&
    'code' in value &&
    typeof (value as Record<string, unknown>).code === 'string' &&
    'error' in value &&
    typeof (value as Record<string, unknown>).error === 'string'
  );
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

function summarizeHttpBody(raw: string): string | undefined {
  const trimmed = raw.trim().replace(/\s+/g, ' ');
  if (!trimmed) return undefined;
  return trimmed.length > 240 ? `${trimmed.slice(0, 240)}...` : trimmed;
}
