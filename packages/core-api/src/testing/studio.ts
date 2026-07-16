/**
 * @stelis/core-api/testing/studio — test-only fixture API for the
 * Studio domain memory adapters.
 *
 * Production package barrels (`@stelis/core-api`, `@stelis/core-api/studio`) do
 * not expose memory coordination adapters. The implementation files remain in
 * `src/studio/...` because the conformance suites and unit tests inside
 * `core-api` reach them via relative imports; this module gives external test
 * packages (e.g. `app-api/tests`) an explicit, test-named subpath to import
 * from instead of widening the production barrel.
 *
 * Production code MUST NOT import from this subpath. Production hosts
 * inject the Redis-backed adapters
 * (`RedisPromotionStore`, `RedisPromotionExecutionLedger`) which are exported from
 * `@stelis/core-api/studio`.
 */
export { MemoryPromotionStore } from '../studio/promotionStore.js';
export { MemoryPromotionExecutionLedger } from '../studio/executionLedgerMemory.js';
