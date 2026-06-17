/**
 * errorMap — host-side error-to-HTTP renderer for `relay.ts` and
 * `studio.ts`.
 *
 * Lookups go through the shared failure data table
 * (`@stelis/core-api`'s `FAILURE_TABLE`). Each known error class is a
 * thin carrier for dynamic fields (digest / subcode / meta / statusHint
 * override / retry-after header); the table owns the public-policy
 * defaults (HTTP status, public code).
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
 * - Status comes from `FAILURE_TABLE[code].httpStatus` by default; if
 *   the class exposes `statusHint`, that value takes precedence
 *   (mirrors the runtime override pattern in
 *   `PrepareValidationError` / `SponsorValidationError`).
 * - Only deterministic fixed headers live here (e.g. static
 *   `Retry-After: 2` for prepare overload). Dynamic headers computed
 *   from error payload (e.g. `SponsorBlockedError.retryAfterMs`)
 *   remain in the route.
 * - Class-specific body fields (`digest`, `subcode`, spread `meta`)
 *   are preserved verbatim so the HTTP response shape does not
 *   change.
 */
import {
  BlockCheckUnavailableError,
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
  SponsorLeaseExpiredError,
  FAILURE_TABLE,
  type FailureCode,
} from '@stelis/core-api';
import { PromotionPrepareError, PromotionSponsorError } from '@stelis/core-api/studio';
import { DeveloperJwtAuthError } from './middleware/studioAuth.js';

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

export interface MappedErrorBody {
  error: string;
  code: string;
  [extra: string]: unknown;
}

export interface MappedErrorResponse {
  status: number;
  headers?: Record<string, string>;
  body: MappedErrorBody;
}

/** Class-based extraction of the HTTP `code` and dynamic hints. */
interface ExtractedHints {
  code: FailureCode;
  /** Runtime override of the table-default HTTP status. */
  statusHint?: number;
  /** Optional `subcode` for sponsor-class errors. */
  subcode?: string;
  /** Optional `digest` for SponsorOnchainError. */
  digest?: string;
  /** Diagnostic `meta` dictionary spread into the response body. */
  meta?: Record<string, unknown>;
  /** Static fixed headers (e.g. `Retry-After: 2` for overload). */
  fixedHeaders?: Record<string, string>;
}

function isClientIpResolutionError(err: Error): boolean {
  return (
    err.name === 'ClientIpResolutionError' ||
    (err as { readonly code?: unknown }).code === 'CLIENT_IP_UNRESOLVED'
  );
}

// ─────────────────────────────────────────────
// Class → FailureCode + hint extraction
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
  if (isClientIpResolutionError(err)) {
    return { code: 'CLIENT_IP_UNRESOLVED' };
  }
  // 503 + Retry-After: 2 — in-flight prepare overload.
  if (err instanceof PrepareOverloadError) {
    return {
      code: 'PREPARE_OVERLOADED',
      fixedHeaders: { 'Retry-After': '2' },
    };
  }
  // 422 default (statusHint override), + spread meta for diagnostic fields.
  if (err instanceof PrepareValidationError) {
    return {
      // PrepareValidationError carries its own HTTP code as a string
      // literal that must already be in KNOWN_PREPARE_ERROR_CODES (locked
      // by `errorCodeLock.test.ts`). We do not validate the cast here;
      // the lock test catches drift before runtime.
      code: err.code as FailureCode,
      statusHint: err.statusHint,
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
  // 422 default (statusHint override).
  if (err instanceof SponsorValidationError) {
    return {
      code: err.code as FailureCode,
      statusHint: err.statusHint,
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
    return { code: 'SPONSOR_CONGESTION' };
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
      code: err.code as FailureCode,
      statusHint: err.statusHint,
    };
  }
  // Studio promotion-sponsor classified errors. Optional subcode mirrors
  // the generic sponsor preflight/on-chain pattern.
  if (err instanceof PromotionSponsorError) {
    return {
      code: err.code as FailureCode,
      statusHint: err.statusHint,
      subcode: err.subcode,
    };
  }
  // Studio JWT auth failures (uses generic AUTH_FAILED code).
  if (err instanceof DeveloperJwtAuthError) {
    return {
      code: 'AUTH_FAILED',
      statusHint: err.statusHint,
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
export function mapError(err: unknown): MappedErrorResponse | null {
  if (!(err instanceof Error)) return null;
  const hints = extractHints(err);
  if (!hints) return null;

  // FAILURE_TABLE drives the default HTTP status and policy
  // projection (classification, abuse impact). The lookup is best-effort:
  // PrepareValidationError / SponsorValidationError / PromotionPrepareError
  // / PromotionSponsorError carry user-provided code strings whose runtime
  // shape is locked by `errorCodeLock.test.ts` against the JSON schema, but
  // tests may inject narrow synthetic codes. When a synthetic code is
  // missing from the table, fall back to the class's `statusHint`; the
  // dynamic-carrier classes always provide one for that exact case.
  const policy = FAILURE_TABLE[hints.code];
  const defaultStatus = policy?.httpStatus ?? 500;
  const status = hints.statusHint ?? defaultStatus;

  const body: MappedErrorBody = { error: err.message, code: hints.code };
  if (hints.digest !== undefined) body.digest = hints.digest;
  if (hints.subcode !== undefined) body.subcode = hints.subcode;
  if (hints.meta) Object.assign(body, hints.meta);

  return hints.fixedHeaders ? { status, headers: hints.fixedHeaders, body } : { status, body };
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
