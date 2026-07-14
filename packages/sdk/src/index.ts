// @stelis/sdk — public API

// ─────────────────────────────────────────────
// High-level SDK (recommended)
// ─────────────────────────────────────────────

export { StelisSDK } from './sdk.js';
export { StelisSponsoredError } from './errors.js';
export { StelisApiException } from './client.js';

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

export type {
  // SDK initialization
  StelisConnectOptions,
  StelisRequestTimeouts,
  SettlementToken,
  ExecuteSponsoredOptions,
  ExecuteSponsoredResult,
  GasEstimateResult,
  ExecuteSuiFirstResult,
  // Relay config response & responses
  RelayConfigResponse,
  RelayPrepareRequest,
  RelayPrepareResponse,
  RelaySponsorRequest,
  RelaySponsorResponse,
  SettleProfile,
  // Settlement swap path config (1-hop only)
  SingleHopSettlementSwapPath,
  DeepBookPoolHop,
  // Prepare (2-step usage)
  PrepareSponsoredOptions,
  PrepareSponsoredResult,
  // Promotion (promotion-specific sponsored execution)
  PromotionPrepareRequest,
  PromotionPrepareResponse,
  PromotionSponsorRequest,
  PromotionSponsorResponse,
  ExecutePromotionSponsoredOptions,
  ExecutePromotionSponsoredResult,
  // Promotion discovery (server-to-server, developer JWT)
  PromotionListItem,
  PromotionListResponse,
  UserPromotionDetail,
  PromotionDetailResponse,
  PromotionUnavailableReason,
} from './types.js';

// ─────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────

export { checkSettlementSwapPathLiquidity } from './swap.js';
export type { SettlementSwapPathLiquidityStatus } from './swap.js';

// ─────────────────────────────────────────────
// Credit query (shared trust root via core-relay)
// ─────────────────────────────────────────────

export { queryUserCredit, CreditQueryInconsistentStateError } from '@stelis/core-relay/browser';
export type { CreditResult } from '@stelis/core-relay/browser';

// ─────────────────────────────────────────────
// Integrity verification (S-16)
// ─────────────────────────────────────────────

export { StelisIntegrityError } from './integrity.js';
export { parseRelayConfigResponse } from '@stelis/contracts';

// ─────────────────────────────────────────────
// On-chain contract IDs (re-export from @stelis/contracts)
// ─────────────────────────────────────────────

export { STELIS_CONTRACT_IDS, DEEPBOOK_IDS } from '@stelis/contracts';

// ─────────────────────────────────────────────
// Promotion discovery (standalone helpers)
// ─────────────────────────────────────────────

import { StelisClient } from './client.js';
import type { PromotionListResponse, PromotionDetailResponse } from './types.js';

/**
 * List available promotions for a user (server-to-server).
 *
 * Standalone helper — does not require a full StelisSDK instance.
 * Uses developer JWT authentication.
 *
 * @param baseUrl      - App API base URL (e.g. 'http://localhost:3200').
 *                       If a /relay suffix is present, it is stripped automatically.
 * @param developerJwt - Developer-signed JWT (Authorization: Bearer header).
 */
export async function listAvailablePromotions(
  baseUrl: string,
  developerJwt: string,
): Promise<PromotionListResponse> {
  const client = new StelisClient({ endpoint: baseUrl });
  return client.listPromotions(developerJwt);
}

/**
 * Get promotion detail and user state (server-to-server).
 *
 * Standalone helper — does not require a full StelisSDK instance.
 * Uses developer JWT authentication.
 *
 * @param baseUrl      - App API base URL (e.g. 'http://localhost:3200').
 * @param promotionId  - Promotion identifier.
 * @param developerJwt - Developer-signed JWT (Authorization: Bearer header).
 */
export async function getPromotionUserState(
  baseUrl: string,
  promotionId: string,
  developerJwt: string,
): Promise<PromotionDetailResponse> {
  const client = new StelisClient({ endpoint: baseUrl });
  return client.getPromotionDetail(promotionId, developerJwt);
}
