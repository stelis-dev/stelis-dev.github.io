/**
 * Shared test fixtures for prepare pipeline tests.
 *
 * Named file-level constants per AGENTS.md test fixture rules:
 * "Dummy addresses must use named file-level constants."
 */
import type { SingleHopSettlementSwapPath } from '@stelis/contracts';
import type { PlannerConfig, PlannerInput } from '../../src/prepare/settlementPlanner.js';
import type { SettlePlanAuditFields } from '../../src/prepare/settlePlanTypes.js';

// ─────────────────────────────────────────────
// Named addresses
// ─────────────────────────────────────────────

export const ADDR_PKG = '0x' + '1'.repeat(64);
export const ADDR_CONFIG = '0x' + '2'.repeat(64);
export const ADDR_REGISTRY = '0x' + '3'.repeat(64);
export const ADDR_POOL = '0x' + '4'.repeat(64);
export const ADDR_POOL2 = '0x' + '5'.repeat(64);
export const ADDR_PAYMENT_COIN = '0x' + '6'.repeat(64);
export const ADDR_VAULT = '0x' + '7'.repeat(64);
export const ADDR_DEEP_COIN = '0x' + '8'.repeat(64);
export const ADDR_SENDER = '0x' + 'a'.repeat(64);
export const ADDR_SETTLEMENT_PAYOUT_RECIPIENT = '0x' + 'b'.repeat(64);
export const ADDR_USABLE_COIN = '0x' + 'c'.repeat(64);

// ─────────────────────────────────────────────
// Token types
// ─────────────────────────────────────────────

export const DEEP_TOKEN_TYPE = `${ADDR_PKG}::token::DEEP`;
export const USDC_TOKEN_TYPE = `${ADDR_PKG}::token::USDC`;
export const MID_TOKEN_TYPE = `${ADDR_PKG}::mid::DEEP`;
export const SUI_TYPE = '0x2::sui::SUI';
export const DEEP_TYPE_FULL = `${ADDR_PKG}::deep::DEEP`;

// ─────────────────────────────────────────────
// Settlement swap path fixtures
// ─────────────────────────────────────────────

export const SETTLEMENT_SWAP_PATH_BFQ: SingleHopSettlementSwapPath = {
  hops: [
    {
      poolId: ADDR_POOL,
      baseType: DEEP_TOKEN_TYPE,
      quoteType: SUI_TYPE,
      swapDirection: 'baseForQuote',
      feeBps: 0,
    },
  ],
  settlementTokenType: DEEP_TOKEN_TYPE,
  settlementTokenSymbol: 'DEEP',
  settlementTokenDecimals: 6,
  lotSize: 1_000n,
  minSize: 10_000n,
  effectiveFeeRateBps: 0,
  settlementSwapDirection: 'baseForQuote',
};

// ─────────────────────────────────────────────
// Planner config
// ─────────────────────────────────────────────

export const BASE_CONFIG: PlannerConfig = {
  minSettleMist: 1_000n,
  quotedHostFeeMist: 100_000n,
  protocolFlatFeeMist: 20_000n,
};

// ─────────────────────────────────────────────
// Planner input factory
// ─────────────────────────────────────────────

export function makeInput(overrides: Partial<PlannerInput> = {}): PlannerInput {
  return {
    settlementSwapPath: SETTLEMENT_SWAP_PATH_BFQ,
    profile: 'with_vault',
    vaultObjectId: ADDR_VAULT,
    creditMist: 0n,
    ...overrides,
  };
}

// ─────────────────────────────────────────────
// Audit fields
// ─────────────────────────────────────────────

export const BASE_AUDIT: SettlePlanAuditFields = {
  executionCostClaim: 5_000_000n,
  settlementPayoutRecipient: ADDR_SETTLEMENT_PAYOUT_RECIPIENT,
  receiptId: new Uint8Array(32).fill(0xaa),
  nonce: 1n,
  simGasReported: 3_000_000n,
  gasVarianceFixedMist: 200_000n,
  slippageBufferMist: 50_000n,
  quotedHostFeeMist: 100_000n,
  expectedProtocolFeeMist: 20_000n,
  expectedConfigVersion: 1n,
  quoteTimestampMs: 1741680000000,
  policyHash: new Uint8Array(32).fill(0xbb),
  orderIdHash: new Uint8Array(0),
};
