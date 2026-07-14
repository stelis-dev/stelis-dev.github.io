/**
 * errorMap — host-side error-to-HTTP renderer for `relay.ts` and
 * `studio.ts`.
 *
 * Each known error class carries only a contracts-owned current code and
 * dynamic evidence. `@stelis/contracts` is the sole authority for HTTP status
 * and the metadata fields each code may expose.
 *
 * Route handlers keep ownership of:
 *   - dynamic responses (`SponsorBlockedError` retry-after computed
 *     from `retryAfterMs`, rate-limit body shape,
 *     `buildSponsorUnavailableResponse`),
 *   - inline body-validation bad-request responses,
 *   - the 500 fallback (each route has a distinct fallback `code` —
 *     `INTERNAL_ERROR`, `SPONSOR_FAILED`, or plain message).
 *
 * `mapError` returns `null` for unknown types so callers can fall
 * through to their route-specific 500 response.
 *
 * Policy
 * ------
 * - Status comes only from `HOST_ERROR_HTTP_STATUS[code]`.
 * - Only deterministic fixed headers live here (e.g. static
 *   `Retry-After: 2` for prepare overload). Dynamic headers computed
 *   from error payload (e.g. `SponsorBlockedError.retryAfterMs`)
 *   remain in the route.
 * - The contracts-owned metadata policy is applied at every status. Most 5xx
 *   failures expose no metadata; terminal execution codes deliberately retain
 *   only the submitted digest so clients can reconcile the known transaction.
 *   Internal lease, slot, signer, Redis key, or endpoint details remain hidden.
 */
import {
  BlockCheckUnavailableError,
  ClientIpResolutionError,
  RequestBodyTooLargeError,
  RequestBodyParseError,
  PrepareValidationError,
  PrepareOverloadError,
  PrepareSenderQuotaError,
  PrepareStudioUserQuotaError,
  SponsorValidationError,
  SponsorPreflightError,
  SponsorOnchainError,
  SponsorCongestionError,
  SponsorTerminalProcessingError,
  SponsorSubmissionUncertainError,
  SponsorLeaseExpiredError,
} from '@stelis/core-api';
import { PromotionPrepareError, PromotionSponsorError } from '@stelis/core-api/studio';
import {
  HOST_ERROR_HTTP_STATUS,
  HOST_ERROR_META_POLICY,
  isHostErrorCode,
  isHostErrorSubcode,
  parseHostErrorResponse,
  type HostErrorCode,
  type HostErrorSubcode,
  type HostErrorMeta,
  type HostErrorMetaField,
  type HostErrorResponse,
} from '@stelis/contracts';

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

export type MappedErrorBody = HostErrorResponse & { code: HostErrorCode };

export interface MappedErrorResponse {
  status: number;
  headers?: Record<string, string>;
  body: HostErrorResponse;
}

/** Class-based extraction of the HTTP `code` and dynamic hints. */
interface ExtractedHints {
  code: HostErrorCode;
  /** Optional `subcode` for sponsor-class errors. */
  subcode?: HostErrorSubcode;
  /** Optional `digest` for SponsorOnchainError. */
  digest?: string;
  /** Internal diagnostics; failure policy selects a closed public projection. */
  meta?: Record<string, unknown>;
  /** Static fixed headers (e.g. `Retry-After: 2` for overload). */
  fixedHeaders?: Record<string, string>;
}

// ─────────────────────────────────────────────
// Class → current HostErrorCode + hint extraction
// ─────────────────────────────────────────────

function extractHints(err: Error): ExtractedHints | null {
  // 413 — request body too large.
  if (err instanceof RequestBodyTooLargeError) {
    return { code: 'REQUEST_BODY_TOO_LARGE' };
  }
  // 400 — request body parse failure (uses generic BAD_REQUEST code).
  if (err instanceof RequestBodyParseError) {
    return { code: 'BAD_REQUEST' };
  }
  // 400 — request-source identity cannot be resolved safely.
  if (err instanceof ClientIpResolutionError) {
    return { code: 'CLIENT_IP_UNRESOLVED' };
  }
  // 503 + Retry-After: 2 — in-flight prepare overload.
  if (err instanceof PrepareOverloadError) {
    return {
      code: 'PREPARE_OVERLOADED',
      fixedHeaders: { 'Retry-After': '2' },
    };
  }
  // Contracts-owned code with a closed diagnostic projection.
  if (err instanceof PrepareValidationError) {
    if (!isHostErrorCode(err.code)) return null;
    return {
      code: err.code,
      meta: err.meta,
    };
  }
  // 429 — Studio user outstanding-prepare quota exceeded.
  if (err instanceof PrepareStudioUserQuotaError) {
    return { code: 'PREPARE_STUDIO_USER_QUOTA_EXCEEDED' };
  }
  // 429 — verified wallet sender outstanding-prepare quota exceeded.
  if (err instanceof PrepareSenderQuotaError) {
    return { code: 'PREPARE_SENDER_QUOTA_EXCEEDED' };
  }
  // Contracts-owned sponsor-validation code.
  if (err instanceof SponsorValidationError) {
    return {
      code: err.code,
    };
  }
  // 422 fixed + optional subcode.
  if (err instanceof SponsorPreflightError) {
    return {
      code: 'SPONSOR_PREFLIGHT_FAILED',
      subcode: err.subcode,
    };
  }
  // 422 fixed + required digest + optional subcode.
  if (err instanceof SponsorOnchainError) {
    return {
      code: 'SPONSOR_ONCHAIN_FAILED',
      digest: err.digest,
      subcode: err.subcode,
    };
  }
  // 503 — shared-object congestion.
  if (err instanceof SponsorCongestionError) {
    return { code: 'SPONSOR_CONGESTION', digest: err.digest };
  }
  if (err instanceof SponsorTerminalProcessingError) {
    return { code: err.code, digest: err.digest };
  }
  // The transaction was signed and may have reached Sui, but the Host could
  // not prove a current terminal result. Preserve the derived transaction
  // identity so clients can reconcile instead of retrying as if submission
  // had never happened.
  if (err instanceof SponsorSubmissionUncertainError) {
    return { code: err.code, digest: err.digest };
  }
  // 503 — abuse-block adapter unavailable.
  if (err instanceof BlockCheckUnavailableError) {
    return { code: 'BLOCK_CHECK_UNAVAILABLE' };
  }
  // 503 + Retry-After: 1 — sponsor lease TTL elapsed.
  if (err instanceof SponsorLeaseExpiredError) {
    return {
      code: 'LEASE_EXPIRED',
      fixedHeaders: { 'Retry-After': '1' },
    };
  }
  // Studio promotion-prepare classified errors.
  if (err instanceof PromotionPrepareError) {
    return {
      code: err.code,
    };
  }
  // Studio promotion-sponsor classified errors. Optional subcode mirrors
  // the generic sponsor preflight/on-chain pattern.
  if (err instanceof PromotionSponsorError) {
    return {
      code: err.code,
      subcode: err.meta.subcode,
      digest: err.meta.digest,
    };
  }
  return null;
}

// ─────────────────────────────────────────────
// mapError
// ─────────────────────────────────────────────

/**
 * Map a thrown value to a structured HTTP response, or return `null`
 * when the error is outside this mapper's scope. Unknown values flow
 * through to the caller's 500 fallback (each route uses its own
 * fallback `code`).
 */
export function mapError(
  err: unknown,
  allowedCodes: readonly HostErrorCode[],
): MappedErrorResponse | null {
  if (!(err instanceof Error)) return null;
  const hints = extractHints(err);
  if (!hints) return null;
  if (!allowedCodes.includes(hints.code)) return null;

  const status = HOST_ERROR_HTTP_STATUS[hints.code];

  let body: MappedErrorBody;
  try {
    body = buildPublicBody(hints, status);
  } catch {
    return null;
  }

  return hints.fixedHeaders ? { status, headers: hints.fixedHeaders, body } : { status, body };
}

function buildPublicBody(hints: ExtractedHints, status: number): MappedErrorBody {
  if (status >= 500) {
    return requireCodedHostError(
      {
        error: 'Internal server error',
        code: hints.code,
        ...projectPublicBodyFields(HOST_ERROR_META_POLICY[hints.code]?.allowed ?? [], hints),
      },
      hints.code,
      status,
    );
  }

  return requireCodedHostError(
    {
      error: publicErrorMessage(status),
      code: hints.code,
      ...projectPublicBodyFields(HOST_ERROR_META_POLICY[hints.code]?.allowed ?? [], hints),
    },
    hints.code,
    status,
  );
}

function publicErrorMessage(status: number): string {
  if (status === 400) return 'Invalid request';
  if (status === 401) return 'Authentication failed';
  if (status === 403) return 'Request forbidden';
  if (status === 404) return 'Resource not found';
  if (status === 409) return 'Request conflicts with current state';
  if (status === 410) return 'Resource expired';
  if (status === 413) return 'Request body too large';
  if (status === 429) return 'Request temporarily blocked';
  return 'Request rejected';
}

function requireCodedHostError(
  value: HostErrorResponse,
  code: HostErrorCode,
  status: number,
): MappedErrorBody {
  const parsed = parseHostErrorResponse(value, [code], status);
  if (parsed.code === undefined) throw new Error('Mapped Host error must carry a code');
  return { ...parsed, code: parsed.code };
}

function projectPublicBodyFields(
  fields: readonly HostErrorMetaField[],
  hints: ExtractedHints,
): HostErrorMeta {
  const projected: HostErrorMeta = {};
  for (const field of fields) {
    if (field === 'digest') {
      if (hints.digest !== undefined) projected.digest = hints.digest;
      continue;
    }
    if (field === 'subcode') {
      const value = hints.subcode ?? hints.meta?.subcode;
      if (isHostErrorSubcode(value)) projected.subcode = value;
      continue;
    }
    if (field === 'isEstimate') {
      if (typeof hints.meta?.isEstimate === 'boolean') {
        projected.isEstimate = hints.meta.isEstimate;
      }
      continue;
    }

    const value = hints.meta?.[field];
    if (typeof value !== 'string') continue;
    if (field === 'minSettleMist') projected.minSettleMist = value;
    else projected.requiredTotalIn = value;
  }
  return projected;
}

// ─────────────────────────────────────────────
// Hono bridge
// ─────────────────────────────────────────────

/**
 * Convenience bridge: render a `MappedErrorResponse` via Hono's
 * `c.json`. The generic `any` cast on `status` is required because
 * Hono's status generic is narrower than `number`, so the cast is
 * centralised here.
 */
type HonoJsonContext = {
  json: (
    body: unknown,
    init?: number | { status?: number; headers?: Record<string, string> },
  ) => Response;
};

export function respondMapped(c: HonoJsonContext, mapped: MappedErrorResponse): Response {
  if (mapped.headers) {
    return c.json(mapped.body, { status: mapped.status, headers: mapped.headers });
  }
  return c.json(mapped.body, mapped.status as never);
}

/** Build a coded Host error without giving the caller an HTTP-status choice. */
export function codedHostError(
  body: HostErrorResponse & { code: HostErrorCode },
  allowedCodes: readonly HostErrorCode[],
  headers?: Record<string, string>,
): MappedErrorResponse {
  const status = HOST_ERROR_HTTP_STATUS[body.code];
  const parsed = parseHostErrorResponse(body, allowedCodes, status);
  return headers ? { status, headers, body: parsed } : { status, body: parsed };
}

/**
 * Build a transport-only Host error. Domain failures cannot use this path;
 * uncoded responses are limited by the shared parser to 429/500/503.
 */
export function uncodedHostError(
  body: Omit<HostErrorResponse, 'code'> & { code?: never },
  allowedCodes: readonly HostErrorCode[],
  status: 429 | 500 | 503,
  headers?: Record<string, string>,
): MappedErrorResponse {
  const parsed = parseHostErrorResponse(body, allowedCodes, status);
  return headers ? { status, headers, body: parsed } : { status, body: parsed };
}
