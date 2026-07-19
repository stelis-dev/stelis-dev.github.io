/**
 * errorMap — host-side error-to-HTTP renderer for every current Host route.
 *
 * Each known error class carries only a contracts-owned current code and
 * dynamic evidence. `@stelis/contracts` is the sole authority for HTTP status
 * and the metadata fields each code may expose.
 *
 * Route handlers keep ownership only of the code and typed dynamic metadata
 * selected by the current operation. Public messages, statuses, and permitted
 * metadata fields come from `@stelis/contracts`.
 *
 * `mapError` returns `null` for unknown types so callers can fall
 * through to their route-specific coded 500 response.
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
  SponsorSubmissionUncertainError,
  SponsorLeaseExpiredError,
} from '@stelis/core-api';
import { PromotionPrepareError, PromotionSponsorError } from '@stelis/core-api/studio';
import { SuiOperationError } from '@stelis/core-relay';
import {
  HOST_ERROR_HTTP_STATUS,
  HOST_ERROR_META_POLICY,
  hostErrorPublicMessage,
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

type MappedErrorBody = HostErrorResponse;
type HostInternalFailureCode = Extract<HostErrorCode, 'INTERNAL_ERROR' | 'SPONSOR_FAILED'>;

interface MappedErrorResponse {
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
  internalFailureCode: HostInternalFailureCode,
): MappedErrorResponse | null {
  if (!(err instanceof Error)) return null;
  const hints: ExtractedHints | null =
    err instanceof SuiOperationError ? { code: internalFailureCode } : extractHints(err);
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
  return requireCodedHostError(
    hints.code,
    status,
    projectPublicBodyFields(HOST_ERROR_META_POLICY[hints.code]?.allowed ?? [], hints),
  );
}

function requireCodedHostError(
  code: HostErrorCode,
  status: number,
  meta: HostErrorMeta = {},
): MappedErrorBody {
  const value: HostErrorResponse = {
    error: hostErrorPublicMessage(code),
    code,
    ...meta,
  };
  return parseHostErrorResponse(value, [code], status);
}

function projectPublicBodyFields(
  fields: readonly HostErrorMetaField[],
  hints: ExtractedHints,
): HostErrorMeta {
  const projected: HostErrorMeta = {};
  for (const field of fields) {
    switch (field) {
      case 'retryAfterMs': {
        const value = hints.meta?.retryAfterMs;
        if (typeof value === 'number') projected.retryAfterMs = value;
        break;
      }
      case 'subcode': {
        const value = hints.subcode ?? hints.meta?.subcode;
        if (isHostErrorSubcode(value)) projected.subcode = value;
        break;
      }
      case 'digest':
        if (hints.digest !== undefined) projected.digest = hints.digest;
        break;
      case 'operationId': {
        const value = hints.meta?.operationId;
        if (typeof value === 'string') projected.operationId = value;
        break;
      }
      case 'minSettleMist': {
        const value = hints.meta?.minSettleMist;
        if (typeof value === 'string') projected.minSettleMist = value;
        break;
      }
      case 'requiredTotalIn': {
        const value = hints.meta?.requiredTotalIn;
        if (typeof value === 'string') projected.requiredTotalIn = value;
        break;
      }
      case 'isEstimate': {
        const value = hints.meta?.isEstimate;
        if (typeof value === 'boolean') projected.isEstimate = value;
        break;
      }
      default: {
        const exhaustive: never = field;
        return exhaustive;
      }
    }
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

/** Build a coded Host error from the contracts-owned message and status authorities. */
export function codedHostError(
  code: HostErrorCode,
  allowedCodes: readonly HostErrorCode[],
  meta: HostErrorMeta = {},
  headers?: Record<string, string>,
): MappedErrorResponse {
  const status = HOST_ERROR_HTTP_STATUS[code];
  const parsed = parseHostErrorResponse(
    { error: hostErrorPublicMessage(code), code, ...meta },
    allowedCodes,
    status,
  );
  return headers ? { status, headers, body: parsed } : { status, body: parsed };
}
