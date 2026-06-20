import { describe, expect, it } from 'vitest';
import type { PrepareAuthorizationFields } from '@stelis/contracts';
import {
  hashPrepareAuthorizationMessage,
  PrepareAuthorizationMessageError,
  serializePrepareAuthorizationMessage,
} from '../src/prepareAuthorization.js';

const PKG = `0x${'1'.repeat(64)}`;
const SENDER = `0x${'2'.repeat(64)}`;

const BASE_FIELDS: PrepareAuthorizationFields = {
  network: 'testnet',
  packageId: PKG,
  senderAddress: SENDER,
  txKindBytesHash: '0x' + 'ab'.repeat(32),
  settlementTokenType: `${PKG}::deep::DEEP`,
  slippageBps: 50,
  gasMarginBps: 250,
  orderId: 'order-123',
  timestampMs: 1_761_007_200_000,
  requestNonce: 'request-nonce-1',
};

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

describe('prepare authorization message', () => {
  it('serializes the same canonical message for equivalent input fields', async () => {
    const sameFields: PrepareAuthorizationFields = {
      requestNonce: BASE_FIELDS.requestNonce,
      timestampMs: BASE_FIELDS.timestampMs,
      orderId: BASE_FIELDS.orderId,
      gasMarginBps: BASE_FIELDS.gasMarginBps,
      slippageBps: BASE_FIELDS.slippageBps,
      settlementTokenType: BASE_FIELDS.settlementTokenType,
      txKindBytesHash: 'AB'.repeat(32),
      senderAddress: BASE_FIELDS.senderAddress,
      packageId: BASE_FIELDS.packageId,
      network: BASE_FIELDS.network,
    };

    expect(serializePrepareAuthorizationMessage(BASE_FIELDS)).toBe(
      serializePrepareAuthorizationMessage(sameFields),
    );
    expect(hex(await hashPrepareAuthorizationMessage(BASE_FIELDS))).toBe(
      hex(await hashPrepareAuthorizationMessage(sameFields)),
    );
  });

  it('changes the hash when txKindBytesHash changes', async () => {
    const first = await hashPrepareAuthorizationMessage(BASE_FIELDS);
    const second = await hashPrepareAuthorizationMessage({
      ...BASE_FIELDS,
      txKindBytesHash: 'cd'.repeat(32),
    });

    expect(hex(first)).not.toBe(hex(second));
  });

  it('keeps requestNonce separate from the relay-assigned settlement nonce', () => {
    const parsed = JSON.parse(serializePrepareAuthorizationMessage(BASE_FIELDS)) as Record<
      string,
      unknown
    >;

    expect(parsed.requestNonce).toBe(BASE_FIELDS.requestNonce);
    expect(parsed).not.toHaveProperty('nonce');
  });

  it('fails on an empty requestNonce', () => {
    expect(() =>
      serializePrepareAuthorizationMessage({
        ...BASE_FIELDS,
        requestNonce: '',
      }),
    ).toThrow(PrepareAuthorizationMessageError);
  });
});
