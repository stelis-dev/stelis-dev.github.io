import { normalizeSuiAddress } from '@mysten/sui/utils';
import type { PrepareAuthorizationFields } from '@stelis/contracts';

export class PrepareAuthorizationMessageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PrepareAuthorizationMessageError';
  }
}

interface CanonicalPrepareAuthorizationMessage {
  version: 1;
  network: 'mainnet' | 'testnet';
  packageId: string;
  senderAddress: string;
  txKindBytesHash: string;
  settlementTokenType: string;
  slippageBps: number | null;
  gasMarginBps: number | null;
  orderId: string | null;
  timestampMs: number;
  requestNonce: string;
}

function requireNonEmptyString(value: string, field: string): string {
  if (value.length === 0) {
    throw new PrepareAuthorizationMessageError(`${field} must not be empty`);
  }
  return value;
}

function requireNonNegativeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new PrepareAuthorizationMessageError(`${field} must be a non-negative safe integer`);
  }
  return value;
}

function optionalNonNegativeInteger(value: number | undefined, field: string): number | null {
  if (value === undefined) return null;
  return requireNonNegativeInteger(value, field);
}

function normalizeHashHex(value: string, field: string): string {
  const withoutPrefix = value.startsWith('0x') ? value.slice(2) : value;
  if (!/^[0-9a-fA-F]{64}$/.test(withoutPrefix)) {
    throw new PrepareAuthorizationMessageError(`${field} must be a 32-byte hex string`);
  }
  return withoutPrefix.toLowerCase();
}

function canonicalPrepareAuthorizationFields(
  fields: PrepareAuthorizationFields,
): CanonicalPrepareAuthorizationMessage {
  const orderId =
    fields.orderId === undefined ? null : requireNonEmptyString(fields.orderId, 'orderId');

  return {
    version: 1,
    network: fields.network,
    packageId: normalizeSuiAddress(requireNonEmptyString(fields.packageId, 'packageId')),
    senderAddress: normalizeSuiAddress(
      requireNonEmptyString(fields.senderAddress, 'senderAddress'),
    ),
    txKindBytesHash: normalizeHashHex(
      requireNonEmptyString(fields.txKindBytesHash, 'txKindBytesHash'),
      'txKindBytesHash',
    ),
    settlementTokenType: requireNonEmptyString(fields.settlementTokenType, 'settlementTokenType'),
    slippageBps: optionalNonNegativeInteger(fields.slippageBps, 'slippageBps'),
    gasMarginBps: optionalNonNegativeInteger(fields.gasMarginBps, 'gasMarginBps'),
    orderId,
    timestampMs: requireNonNegativeInteger(fields.timestampMs, 'timestampMs'),
    requestNonce: requireNonEmptyString(fields.requestNonce, 'requestNonce'),
  };
}

/**
 * Serialize prepare authorization fields into the exact message a wallet signs.
 */
export function serializePrepareAuthorizationMessage(fields: PrepareAuthorizationFields): string {
  return JSON.stringify(canonicalPrepareAuthorizationFields(fields));
}

/**
 * UTF-8 encode the canonical prepare authorization message.
 */
export function encodePrepareAuthorizationMessage(fields: PrepareAuthorizationFields): Uint8Array {
  return new TextEncoder().encode(serializePrepareAuthorizationMessage(fields));
}
