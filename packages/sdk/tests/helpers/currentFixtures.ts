import type { CreditResult } from '@stelis/core-relay/browser';
import type { RelayPrepareRequest } from '../../src/types.js';

export function makeCreditResult(overrides: Partial<CreditResult> = {}): CreditResult {
  return {
    vaultObjectId: null,
    credit: '0',
    needsCreate: false,
    lastNonce: '0',
    ...overrides,
  };
}

export function makeRelayPrepareRequest(
  overrides: Partial<RelayPrepareRequest> = {},
): RelayPrepareRequest {
  return {
    txKindBytes: 'kind',
    senderAddress: `0x${'1'.repeat(64)}`,
    settlementTokenType: '0x2::sui::SUI',
    txKindBytesHash: 'ab'.repeat(32),
    prepareAuthorizationTimestampMs: 1_760_000_000_000,
    prepareAuthorizationRequestNonce: 'cd'.repeat(16),
    prepareAuthorizationSignature: 'test-prepare-authorization-signature',
    ...overrides,
  };
}
