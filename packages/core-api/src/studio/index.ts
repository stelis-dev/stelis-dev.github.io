/**
 * @stelis/core-api/studio — studio platform domain modules.
 *
 * Framework-agnostic studio domain logic.
 * Runtime host concerns (env, singleton, boot) remain in app-api.
 */

// Domain types
export type { StudioHostContext } from './types.js';

// Auth token extraction (framework-agnostic Bearer token parser)
export { extractBearerToken } from './extractBearerToken.js';

// Developer JWT trust verification
export {
  verifyDeveloperJwt,
  parseDeveloperJwtTrustConfig,
  type DeveloperJwtTrustConfig,
  type VerifiedDeveloperIdentity,
} from './developerJwtVerifier.js';

// Validation pipeline (S1/S2/S3) is internal to promotion prepare/sponsor
// handlers and their policy modules. No verified external consumer → not re-exported
// from the package barrel. Internal consumers import directly from './validation.js'.

// ─────────────────────────────────────────────
// Promotion system
// ─────────────────────────────────────────────

// Promotion value types (defined in domain.ts)
export type { Promotion, PromotionStatus } from './domain.js';
export { computeTotalRequiredBudgetMist } from './domain.js';

// Promotion store adapter API (store-owned DTOs + transition control).
// Memory adapter is a test-only fixture and is not exported from this
// production barrel; tests reach it through `@stelis/core-api/testing/studio`
// (cross-package) or relative `../src/studio/promotionStore.js` (within
// core-api).
export type {
  CreatePromotionInput,
  UpdatePromotionInput,
  PromotionStoreAdapter,
} from './promotionStore.js';
export { RedisPromotionStore, PromotionCurrentConflictError } from './promotionStore.js';

// Promotion execution accounting is owned by PromotionExecutionLedger
// (see executionLedger.ts).

// Usage/event store adapter API (value types live in domain.ts).
// Memory adapter is a test-only fixture; see comment above.
export type { PromotionUsageStoreAdapter } from './promotionUsageStore.js';
export { RedisPromotionUsageStore } from './promotionUsageStore.js';

// Derived summary
export type { PromotionAdminSummary } from './promotionDerivedSummary.js';
export {
  computePromotionAdminSummary,
  computeUserPromotionDetail,
  computePromotionListItem,
} from './promotionDerivedSummary.js';

// ─────────────────────────────────────────────
// Promotion execution ledger
// ─────────────────────────────────────────────

export type { PromotionExecutionLedger } from './executionLedger.js';
export { MAX_PROMOTION_LEDGER_VALUE_MIST } from './executionLedger.js';
// Memory ledger is a test-only fixture reachable through
// `@stelis/core-api/testing/studio` or
// `../src/studio/executionLedgerMemory.js`.
export { RedisPromotionExecutionLedger } from './executionLedgerRedis.js';

// Claim handler
export type { ClaimFailureReason } from './promotionClaimHandler.js';
export { handlePromotionClaim } from './promotionClaimHandler.js';

// Target policy — canonical Host allowlist representation
export { canonicalizePromotionTarget } from './promotionTargetPolicy.js';

// Promotion abuse policy
export { PROMOTION_ABUSE_CODES, recordPromotionAbuseEvent } from './promotionAbusePolicy.js';

// Promotion prepare handler
export type { PromotionPrepareContext } from './preparePromotionSponsoredHandler.js';
export {
  handlePromotionPrepare,
  PromotionPrepareError,
} from './preparePromotionSponsoredHandler.js';

// Promotion sponsor handler
export type { PromotionSponsorContext } from './sponsorPromotionSponsoredHandler.js';
export {
  handlePromotionSponsor,
  PromotionSponsorError,
} from './sponsorPromotionSponsoredHandler.js';
