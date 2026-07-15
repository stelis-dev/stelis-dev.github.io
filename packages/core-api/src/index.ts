// @stelis/core-api — public API (framework-agnostic domain logic)

// Client IP resolution
export { ClientIpResolutionError, resolveClientIp, parseTrustedProxyHops } from './clientIp.js';
export { BlockCheckUnavailableError, checkBlockedRequest } from './abuseBlocking.js';

// Context
export { createHostContext } from './context.js';
export type { HostContext } from './context.js';
export { readHostChainState } from './hostChainState.js';
export type { HostChainState } from './hostChainState.js';

// Address constraints
export { canonicalizeAddress, validateAddressConstraints } from './addressConstraints.js';

// Handlers
export { handleStatus } from './handlers/status.js';

export {
  handleSponsor,
  SponsorValidationError,
  SponsorBlockedError,
  SponsorPreflightError,
  SponsorOnchainError,
  SponsorCongestionError,
  SponsorSubmissionUncertainError,
  SponsorLeaseExpiredError,
} from './handlers/sponsor.js';

// Sponsor result host callback — consumed by app-api to drive per-action
// sponsor operations state updates.
export type { SponsorResultMetadata, SponsorResultCallback } from './handlers/sponsorResult.js';

export { handlePrepare } from './handlers/prepare.js';
export { PrepareValidationError } from './prepare/replay.js';
export type { PrepareHandlerConfig } from './handlers/prepare.js';

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
export type { RedisClientLike, RawRedisClient } from './store/redisClient.js';
export { wrapRedisClient } from './store/redisClient.js';

export type { PreparedTxEntry } from './store/prepareTypes.js';
// Prepare-store production adapter. Memory adapter and store interfaces remain
// package-internal implementation boundaries.
export { RedisPrepareStore } from './store/redisPrepareStore.js';
export { RedisPrepareRequestNonceStore } from './store/prepareRequestNonceStore.js';
export {
  PrepareSenderQuotaError,
  PrepareStudioUserQuotaError,
  PrepareOverloadError,
} from './store/prepareErrors.js';

// Production in-flight limiter. Its interface and memory adapter are internal.
export { RedisPrepareInflight } from './store/redisPrepareInflight.js';

// Production rate limiter. Its interface and memory adapter are internal.
export { RedisRateLimiter } from './store/redisRateLimiter.js';

// Production abuse blocker. Its interface and memory adapter are internal.
export { RedisAbuseBlocker } from './store/redisAbuseBlocker.js';

// Sponsor slot leasing — only the production adapter and host-facing key
// parsers are exported.
// In-memory `SponsorPool` is internal/test-only; tests import it via the
// relative `../src/context.js` path.
export { parseSponsorKey, parseSponsorKeys } from './context.js';
export { RedisSponsorPool } from './store/redisSponsorPool.js';

// Shared constants and types live in `@stelis/contracts`.
// `@stelis/core-api` re-exports only its own domain/runtime APIs.

// BPS validation (shared between HTTP boundary and domain boundary)
export { validateBps } from './validateBps.js';
