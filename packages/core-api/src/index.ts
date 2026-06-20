// @stelis/core-api — public API (framework-agnostic domain logic)

// Client IP resolution
export {
  ClientIpResolutionError,
  resolveClientIp,
  parseTrustedProxyHops,
  normalizeTrustedProxyHops,
} from './clientIp.js';
export {
  ABUSE_BLOCKED_CODE,
  DEFAULT_ABUSE_BLOCKER_CONFIG,
  BlockCheckUnavailableError,
  checkBlockedRequest,
  recordSponsorFailureForAbuse,
  toBlockedError,
} from './abuseBlocking.js';
// Failure policy exports — narrowed to verified external consumers only.
//
// Verified external consumers (across `packages/app-api`, `packages/sdk`,
// `packages/app-web`, `packages/app-admin`):
//   - `packages/app-api/src/errorMap.ts` reads `FAILURE_TABLE[code]`
//     for the default HTTP status and uses the `FailureCode` type for
//     hint/code typing.
//
// Internal `core-api` modules (`abuseBlocking.ts`,
// `store/memoryAbuseBlocker.ts`, `store/redisAbuseBlocker.ts`,
// `session/sponsoredExecution/genericExecutionPolicy.ts`,
// `studio/promotionAbusePolicy.ts`)
// consume the rest of the failures module via relative `./failures.js`
// or `../failures.js` imports and do not need a main-barrel
// re-export.
//
// Do not widen this API for symmetry. Add a new entry only for a verified
// current consumer.
export { FAILURE_TABLE } from './failures.js';
export type { FailureCode } from './failures.js';

// Context
export { createHostContext } from './context.js';
export type { HostRuntimeConfig, HostContext } from './context.js';

// Address constraints
export { canonicalizeAddress, validateAddressConstraints } from './addressConstraints.js';
export type { AddressConstraintInput } from './addressConstraints.js';

// Handlers
export { handleStatus } from './handlers/status.js';
export type { StatusResponse } from './handlers/status.js';

export {
  handleSponsor,
  SponsorValidationError,
  SponsorBlockedError,
  SponsorPreflightError,
  SponsorOnchainError,
  SponsorCongestionError,
  SponsorLeaseExpiredError,
} from './handlers/sponsor.js';
export type { SponsorParams, SponsorResult } from './handlers/sponsor.js';

// Sponsor result host callback — consumed by app-api to drive per-action
// sponsor operations state updates.
export type {
  SponsorResultOutcome,
  SponsorResultRoute,
  SponsorResultMetadata,
  SponsorResultCallback,
} from './handlers/sponsorResult.js';

export { handlePrepare } from './handlers/prepare.js';
export { PrepareValidationError } from './prepare/replay.js';
export type { PrepareParams, PrepareResult, PrepareHandlerConfig } from './handlers/prepare.js';

// Shared request-body helpers
export {
  MAX_SPONSOR_REQUEST_BODY_BYTES,
  MAX_PREPARE_REQUEST_BODY_BYTES,
  MAX_SMALL_REQUEST_BODY_BYTES,
  RequestBodyTooLargeError,
  RequestBodyParseError,
  readJsonBodyWithLimit,
} from './requestBody.js';

// Store adapters
export type { RedisClientLike, RedisSetOptions, RawRedisClient } from './store/redisClient.js';
export { wrapRedisClient } from './store/redisClient.js';

export type { PreparedTxEntry, PrepareStoreAdapter } from './store/prepareTypes.js';
export { PREPARE_TTL_MS } from './preparePolicy.js';
// Prepare-store production adapter + shared concurrency caps that the host
// needs at the same boundary. Memory adapter is an internal / test-only fixture
// kept in `src/store/memoryPrepareStore.ts`.
export {
  MAX_CONCURRENT_PER_IP,
  MAX_OUTSTANDING_PER_STUDIO_USER,
} from './store/memoryPrepareStore.js';
export { RedisPrepareStore } from './store/redisPrepareStore.js';
export type { RedisPrepareStoreOptions } from './store/redisPrepareStore.js';
export type { PrepareRequestNonceStore } from './store/prepareRequestNonceStore.js';
export { RedisPrepareRequestNonceStore } from './store/prepareRequestNonceStore.js';
export type { RedisPrepareRequestNonceStoreOptions } from './store/prepareRequestNonceStore.js';
export {
  PrepareSenderQuotaError,
  PrepareStudioUserQuotaError,
  PrepareOverloadError,
} from './store/prepareErrors.js';

// Prepare in-flight limiter — only the production adapter and the
// shared interface are exported. Memory adapter is internal/test-only.
export type { PrepareInflightLimiter, InflightHandle } from './store/prepareInflightTypes.js';
export { RedisPrepareInflight } from './store/redisPrepareInflight.js';
export type { RedisPrepareInflightOptions } from './store/redisPrepareInflight.js';

// Rate limiting — only the production adapter and the shared interface
// are exported. Memory adapter is internal/test-only.
export type { RateLimitAdapter, RateLimitResult, RateLimitConfig } from './store/rateLimitTypes.js';
export { RedisRateLimiter } from './store/redisRateLimiter.js';

// Abuse blocking — only the production adapter and the shared interface
// are exported. Memory adapter is internal/test-only.
export type {
  AbuseBlockStatus,
  AbuseBlockerAdapter,
  AbuseBlockerConfig,
} from './store/abuseBlockTypes.js';
export { RedisAbuseBlocker } from './store/redisAbuseBlocker.js';

// Sponsor slot leasing — only the production adapter, the shared
// interface types, and the host-facing key parsers are exported.
// In-memory `SponsorPool` is internal/test-only; tests import it via the
// relative `../src/context.js` path.
export { parseSponsorKey, parseSponsorKeys } from './context.js';
export type { SponsorLease, SponsorPoolAdapter } from './context.js';
export { RedisSponsorPool } from './store/redisSponsorPool.js';

// Shared constants and types live in `@stelis/contracts`.
// `@stelis/core-api` re-exports only its own domain/runtime APIs.

// BPS validation (shared between HTTP boundary and domain boundary)
export { validateBps } from './validateBps.js';
export type { BpsValidationError } from './validateBps.js';
