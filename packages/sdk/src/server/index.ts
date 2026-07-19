/**
 * @stelis/sdk/server — Server-side verification utilities.
 *
 * Provides:
 *   1. verifySettleEventAgainstExpected — fetch and verify against application-owned fields
 *   2. extractSettleEvents              — extract decoded SettleEvent summaries for reconciliation
 *
 * The raw BCS decoder (settleEventDecoder.ts) stays internal to this
 * package: the verifier and extractor consume it directly, and no
 * public-barrel consumer requires it.
 */

export {
  verifySettleEventAgainstExpected,
  verifySettleEventResultAgainstExpected,
  type VerifiedSettleEvent,
} from './verifySettleEventAgainstExpected.js';
export type { ExpectedSettleEventFields } from '@stelis/contracts';
export { extractSettleEvents, type ExtractedSettleEventSummary } from './extractSettleEvents.js';
