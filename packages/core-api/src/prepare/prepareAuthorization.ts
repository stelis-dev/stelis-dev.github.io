import { createHash } from 'node:crypto';
import { fromBase64 } from '@mysten/sui/utils';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import { verifyPersonalMessageSignature } from '@mysten/sui/verify';
import type { PrepareAuthorizationFields } from '@stelis/contracts';
import { encodePrepareAuthorizationMessage } from '@stelis/core-relay';
import type { HostContext } from '../context.js';
import { PrepareValidationError } from './replay.js';

export const PREPARE_AUTHORIZATION_TTL_MS = 5 * 60 * 1000;
export const PREPARE_AUTHORIZATION_CLOCK_SKEW_MS = 30 * 1000;
export const MAX_PREPARE_REQUEST_NONCE_BYTES = 128;

export interface PrepareAuthorizationParams {
  txKindBytes: string;
  senderAddress: string;
  settlementTokenType: string;
  slippageBps?: number;
  gasMarginBps?: number;
  orderId?: string;
  txKindBytesHash: string;
  prepareAuthorizationTimestampMs: number;
  prepareAuthorizationRequestNonce: string;
  prepareAuthorizationSignature: string;
}

export async function verifyPrepareAuthorization(
  ctx: HostContext,
  params: PrepareAuthorizationParams,
): Promise<void> {
  const requestNonceBytes = new TextEncoder().encode(params.prepareAuthorizationRequestNonce);
  if (
    requestNonceBytes.length === 0 ||
    requestNonceBytes.length > MAX_PREPARE_REQUEST_NONCE_BYTES
  ) {
    throw new PrepareValidationError(
      'PREPARE_AUTH_NONCE_INVALID',
      `prepareAuthorizationRequestNonce must be 1-${MAX_PREPARE_REQUEST_NONCE_BYTES} UTF-8 bytes`,
      undefined,
      400,
    );
  }
  if (!Number.isSafeInteger(params.prepareAuthorizationTimestampMs)) {
    throw new PrepareValidationError(
      'PREPARE_AUTH_TIMESTAMP_INVALID',
      'prepareAuthorizationTimestampMs must be a safe integer',
      undefined,
      400,
    );
  }

  const now = Date.now();
  if (params.prepareAuthorizationTimestampMs < now - PREPARE_AUTHORIZATION_TTL_MS) {
    throw new PrepareValidationError(
      'PREPARE_AUTH_EXPIRED',
      'prepare authorization timestamp is expired',
    );
  }
  if (params.prepareAuthorizationTimestampMs > now + PREPARE_AUTHORIZATION_CLOCK_SKEW_MS) {
    throw new PrepareValidationError(
      'PREPARE_AUTH_TIMESTAMP_INVALID',
      'prepare authorization timestamp is too far in the future',
      undefined,
      400,
    );
  }

  const actualTxKindBytesHash = hashTxKindBytes(params.txKindBytes);
  const expectedTxKindBytesHash = normalizeHashHex(params.txKindBytesHash);
  if (actualTxKindBytesHash !== expectedTxKindBytesHash) {
    throw new PrepareValidationError(
      'PREPARE_AUTH_TX_KIND_HASH_MISMATCH',
      'txKindBytesHash does not match txKindBytes',
    );
  }

  const fields = prepareAuthorizationFields(ctx, params, expectedTxKindBytesHash);
  try {
    const recovered = await verifyPersonalMessageSignature(
      encodePrepareAuthorizationMessage(fields),
      params.prepareAuthorizationSignature,
    );
    if (
      normalizeSuiAddress(recovered.toSuiAddress()) !== normalizeSuiAddress(params.senderAddress)
    ) {
      throw new Error('signer mismatch');
    }
  } catch {
    throw new PrepareValidationError(
      'PREPARE_AUTH_SIGNATURE_INVALID',
      'prepare authorization signature is invalid or does not match senderAddress',
    );
  }

  const claim = await ctx.prepareRequestNonceStore.claim(
    normalizeSuiAddress(params.senderAddress),
    params.prepareAuthorizationRequestNonce,
    PREPARE_AUTHORIZATION_TTL_MS + PREPARE_AUTHORIZATION_CLOCK_SKEW_MS,
  );
  if (claim === 'duplicate') {
    throw new PrepareValidationError(
      'PREPARE_AUTH_NONCE_REUSED',
      'prepare authorization request nonce was already used',
    );
  }
}

export function prepareAuthorizationFields(
  ctx: Pick<HostContext, 'network' | 'packageId'>,
  params: Omit<PrepareAuthorizationParams, 'prepareAuthorizationSignature'>,
  normalizedTxKindBytesHash = normalizeHashHex(params.txKindBytesHash),
): PrepareAuthorizationFields {
  return {
    network: ctx.network,
    packageId: ctx.packageId,
    senderAddress: params.senderAddress,
    txKindBytesHash: normalizedTxKindBytesHash,
    settlementTokenType: params.settlementTokenType,
    slippageBps: params.slippageBps,
    gasMarginBps: params.gasMarginBps,
    orderId: params.orderId,
    timestampMs: params.prepareAuthorizationTimestampMs,
    requestNonce: params.prepareAuthorizationRequestNonce,
  };
}

function hashTxKindBytes(txKindBytes: string): string {
  try {
    return createHash('sha256').update(fromBase64(txKindBytes)).digest('hex');
  } catch {
    throw new PrepareValidationError('P0_INVALID_BASE64', 'Malformed base64 in txKindBytes');
  }
}

function normalizeHashHex(value: string): string {
  const withoutPrefix = value.startsWith('0x') ? value.slice(2) : value;
  if (!/^[0-9a-fA-F]{64}$/.test(withoutPrefix)) {
    throw new PrepareValidationError(
      'PREPARE_AUTH_TX_KIND_HASH_INVALID',
      'txKindBytesHash must be a 32-byte hex string',
      undefined,
      400,
    );
  }
  return withoutPrefix.toLowerCase();
}
