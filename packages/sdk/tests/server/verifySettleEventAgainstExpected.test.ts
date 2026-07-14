import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  verifySettleEventAgainstExpected,
  verifySettleEventInTransaction,
} from '../../src/server/verifySettleEventAgainstExpected.js';
import { decodeSettleEvent } from '../../src/server/settleEventDecoder.js';
import type { SuiClientTypes } from '@mysten/sui/client';
import type { SuiGrpcClient } from '@mysten/sui/grpc';
import { STELIS_CONTRACT_IDS } from '@stelis/contracts';
import { serializeSettleEventBcs, type SettleEventBcsInput } from '../helpers/settleEventBcs.js';

const PACKAGE_ID = STELIS_CONTRACT_IDS.testnet!.packageId;

function hex2bytes(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/, '');
  const bytes: number[] = [];
  for (let i = 0; i < clean.length; i += 2) {
    bytes.push(parseInt(clean.slice(i, i + 2), 16));
  }
  return Uint8Array.from(bytes);
}

function sha256Bytes(input: string): Uint8Array {
  const buf = createHash('sha256').update(input).digest();
  return new Uint8Array(buf);
}

const RECEIPT_ID_HEX = 'aabbccdd' + '00'.repeat(28);
const ORDER_ID = 'ord_001';
const USER_ADDR = '0x' + '0'.repeat(56) + '1234abcd'; // TEST_USER
const TREASURY_ADDR = '0x' + 'ff'.repeat(32);
const SETTLEMENT_PAYOUT_RECIPIENT_ADDR = '0x' + 'ee'.repeat(32);
const EXPECTED_BASE = {
  receiptId: RECEIPT_ID_HEX,
  orderId: ORDER_ID,
  user: USER_ADDR,
} as const;

function makeSettleEventBcs() {
  const data: SettleEventBcsInput = {
    receipt_id: hex2bytes(RECEIPT_ID_HEX),
    nonce: 1n,
    policy_hash: new Uint8Array(32),
    quote_timestamp_ms: 1700000000000n,
    exec_timestamp_ms: 1700000000000n,
    sim_gas_reported: 1000n,
    gas_variance_fixed_mist: 500n,
    slippage_buffer_mist: 200n,
    execution_cost_claim_mist: 50000n,
    quoted_host_fee_mist: 10000n,
    protocol_fee: 5000n,
    protocol_treasury: TREASURY_ADDR,
    payout: 60000n,
    total_in: 65000n,
    surplus_credited: 0n,
    config_version: 3n,
    user: USER_ADDR,
    settlement_payout_recipient: SETTLEMENT_PAYOUT_RECIPIENT_ADDR,
    order_id_hash: sha256Bytes(ORDER_ID),
  };
  return serializeSettleEventBcs(data);
}

function makeEvent(bcsBytes: Uint8Array, eventType = `${PACKAGE_ID}::events::SettleEvent`) {
  return {
    packageId: PACKAGE_ID,
    module: 'events',
    sender: USER_ADDR,
    eventType,
    bcs: bcsBytes,
    json: null,
  };
}

function successfulTransaction(
  events: SuiClientTypes.Event[],
  digest = '0xDIGEST',
): SuiClientTypes.TransactionResult<{ events: true }> {
  return {
    $kind: 'Transaction',
    Transaction: {
      events,
      digest,
      signatures: [],
      epoch: '1',
      status: { success: true, error: null },
      balanceChanges: undefined,
      effects: undefined,
      objectTypes: undefined,
      transaction: undefined,
      bcs: undefined,
    },
  };
}

function failedTransaction(
  events: SuiClientTypes.Event[],
): SuiClientTypes.TransactionResult<{ events: true }> {
  return {
    $kind: 'FailedTransaction',
    FailedTransaction: {
      events,
      digest: '0xDIGEST',
      signatures: [],
      epoch: '1',
      status: {
        success: false,
        error: {
          $kind: 'Unknown',
          Unknown: null,
          message: 'MoveAbort in settlement',
        },
      },
      balanceChanges: undefined,
      effects: undefined,
      objectTypes: undefined,
      transaction: undefined,
      bcs: undefined,
    },
  };
}

function mockClient(events: unknown[]): SuiGrpcClient {
  return {
    getTransaction: vi.fn().mockResolvedValue({
      $kind: 'Transaction',
      Transaction: {
        events,
        digest: '0xDIGEST',
        signatures: [],
        epoch: '1',
        status: { success: true, error: null },
      },
    }),
  } as unknown as SuiGrpcClient;
}

function mockEmptyClient(): SuiGrpcClient {
  return {
    getTransaction: vi.fn().mockResolvedValue({
      $kind: 'Transaction',
      Transaction: {
        events: [],
        digest: '0xDIGEST',
        signatures: [],
        epoch: '1',
        status: { success: true, error: null },
      },
    }),
  } as unknown as SuiGrpcClient;
}

function mockFailedClient(events: unknown[]): SuiGrpcClient {
  return {
    getTransaction: vi.fn().mockResolvedValue({
      $kind: 'FailedTransaction',
      FailedTransaction: {
        events,
        digest: '0xDIGEST',
        signatures: [],
        epoch: '1',
        status: {
          success: false,
          error: {
            $kind: 'Unknown',
            Unknown: null,
            message: 'MoveAbort in settlement',
          },
        },
      },
    }),
  } as unknown as SuiGrpcClient;
}

function mockMissingEventsClient(): SuiGrpcClient {
  return {
    getTransaction: vi.fn().mockResolvedValue({
      $kind: 'Transaction',
      Transaction: {
        events: undefined,
        digest: '0xDIGEST',
        signatures: [],
        epoch: '1',
        status: { success: true, error: null },
      },
    }),
  } as unknown as SuiGrpcClient;
}

describe('decodeSettleEvent canonical BCS boundary', () => {
  it('rejects trailing bytes after the generated event schema', () => {
    const canonical = makeSettleEventBcs();
    const withTrailingByte = new Uint8Array(canonical.length + 1);
    withTrailingByte.set(canonical);

    expect(() => decodeSettleEvent(withTrailingByte)).toThrow(
      'SettleEvent BCS is not canonical for the generated schema',
    );
  });

  it('rejects a non-canonical ULEB length for the first vector field', () => {
    const canonical = makeSettleEventBcs();
    expect(canonical[0]).toBe(32);

    const nonCanonicalLength = Uint8Array.from([0xa0, 0x00, ...canonical.slice(1)]);
    expect(() => decodeSettleEvent(nonCanonicalLength)).toThrow(
      'SettleEvent BCS is not canonical for the generated schema',
    );
  });
});

describe('verifySettleEventInTransaction', () => {
  it('verifies a current successful result without fetching it again', () => {
    const result = successfulTransaction([makeEvent(makeSettleEventBcs())]);

    const verified = verifySettleEventInTransaction(result, '0xDIGEST', EXPECTED_BASE);

    expect(verified.receiptId).toBe(RECEIPT_ID_HEX);
    expect(verified.executionCostClaim).toBe('50000');
  });

  it('rejects a malformed discriminator and payload combination', () => {
    const success = successfulTransaction([makeEvent(makeSettleEventBcs())]);
    const malformed = {
      ...success,
      FailedTransaction: success.Transaction,
    } as unknown as SuiClientTypes.TransactionResult<{ events: true }>;

    expect(() => verifySettleEventInTransaction(malformed, '0xDIGEST', EXPECTED_BASE)).toThrow(
      'malformed or mismatched result',
    );
  });

  it('rejects a current failed result before consuming its matching event', () => {
    const result = failedTransaction([makeEvent(makeSettleEventBcs())]);

    expect(() => verifySettleEventInTransaction(result, '0xDIGEST', EXPECTED_BASE)).toThrow(
      /Transaction 0xDIGEST failed: MoveAbort in settlement/,
    );
  });

  it('rejects a result payload for a different digest', () => {
    const result = successfulTransaction([makeEvent(makeSettleEventBcs())], '0xOTHER');

    expect(() => verifySettleEventInTransaction(result, '0xDIGEST', EXPECTED_BASE)).toThrow(
      'malformed or mismatched result',
    );
  });

  it('rejects a successful payload whose requested events are not an array', () => {
    const result = successfulTransaction([makeEvent(makeSettleEventBcs())]);
    const malformed = {
      ...result,
      Transaction: { ...result.Transaction, events: undefined },
    } as unknown as SuiClientTypes.TransactionResult<{ events: true }>;

    expect(() => verifySettleEventInTransaction(malformed, '0xDIGEST', EXPECTED_BASE)).toThrow(
      'did not include requested events',
    );
  });
});

describe('verifySettleEventAgainstExpected', () => {
  it('returns verified fields on match', async () => {
    const client = mockClient([makeEvent(makeSettleEventBcs())]);
    const result = await verifySettleEventAgainstExpected(client, '0xDIGEST', EXPECTED_BASE);

    expect(result.receiptId).toBe(RECEIPT_ID_HEX);
    expect(result.user).toBe(USER_ADDR);
    expect(result.executionCostClaim).toBe('50000');
    expect(result.execTimestampMs).toBe('1700000000000');
    expect(client.getTransaction).toHaveBeenCalledTimes(1);
  });

  it('verifies orderId hash correctly', async () => {
    const client = mockClient([makeEvent(makeSettleEventBcs())]);
    const result = await verifySettleEventAgainstExpected(client, '0xDIGEST', {
      receiptId: RECEIPT_ID_HEX,
      orderIdHash: createHash('sha256').update(ORDER_ID).digest('hex'),
      user: USER_ADDR,
    });

    expect(result.orderIdHash).toBe(createHash('sha256').update(ORDER_ID).digest('hex'));
  });

  it('accepts an optional 0x prefix on exact 32-byte receipt and order hashes', async () => {
    const orderIdHash = createHash('sha256').update(ORDER_ID).digest('hex');
    const client = mockClient([makeEvent(makeSettleEventBcs())]);

    const result = await verifySettleEventAgainstExpected(client, '0xDIGEST', {
      receiptId: `0x${RECEIPT_ID_HEX}`,
      orderIdHash: `0x${orderIdHash}`,
      user: USER_ADDR,
    });

    expect(result.receiptId).toBe(RECEIPT_ID_HEX);
    expect(result.orderIdHash).toBe(orderIdHash);
  });

  it('treats undefined orderId as absent when orderIdHash is provided', async () => {
    const client = mockClient([makeEvent(makeSettleEventBcs())]);
    const result = await verifySettleEventAgainstExpected(client, '0xDIGEST', {
      receiptId: RECEIPT_ID_HEX,
      orderId: undefined,
      orderIdHash: createHash('sha256').update(ORDER_ID).digest('hex'),
      user: USER_ADDR,
    } as Parameters<typeof verifySettleEventAgainstExpected>[2]);

    expect(result.orderIdHash).toBe(createHash('sha256').update(ORDER_ID).digest('hex'));
  });

  it('throws when no events found', async () => {
    const client = mockEmptyClient();
    await expect(
      verifySettleEventAgainstExpected(client, '0xDIGEST', EXPECTED_BASE),
    ).rejects.toThrow('No events found');
  });

  it('rejects a FailedTransaction before consuming a matching event', async () => {
    const client = mockFailedClient([makeEvent(makeSettleEventBcs())]);

    await expect(
      verifySettleEventAgainstExpected(client, '0xDIGEST', EXPECTED_BASE),
    ).rejects.toThrow(/Transaction 0xDIGEST failed: MoveAbort in settlement/);
  });

  it('rejects a successful response that omitted requested events', async () => {
    const client = mockMissingEventsClient();

    await expect(
      verifySettleEventAgainstExpected(client, '0xDIGEST', EXPECTED_BASE),
    ).rejects.toThrow('did not include requested events');
  });

  it('throws when SettleEvent eventType not found', async () => {
    const client = mockClient([
      {
        packageId: '0xOTHER',
        module: 'other',
        sender: USER_ADDR,
        eventType: '0xOTHER::events::Other',
        bcs: new Uint8Array(0),
      },
    ]);
    await expect(
      verifySettleEventAgainstExpected(client, '0xDIGEST', EXPECTED_BASE),
    ).rejects.toThrow('SettleEvent not found');
  });

  it('throws on receiptId mismatch', async () => {
    const client = mockClient([makeEvent(makeSettleEventBcs())]);
    await expect(
      verifySettleEventAgainstExpected(client, '0xDIGEST', {
        ...EXPECTED_BASE,
        receiptId: 'ff'.repeat(32),
      }),
    ).rejects.toThrow('receiptId');
  });

  it('throws on orderId hash mismatch', async () => {
    const client = mockClient([makeEvent(makeSettleEventBcs())]);
    await expect(
      verifySettleEventAgainstExpected(client, '0xDIGEST', {
        receiptId: RECEIPT_ID_HEX,
        orderId: 'wrong_order',
        user: USER_ADDR,
      }),
    ).rejects.toThrow('orderIdHash');
  });

  it('throws on user mismatch', async () => {
    const client = mockClient([makeEvent(makeSettleEventBcs())]);
    await expect(
      verifySettleEventAgainstExpected(client, '0xDIGEST', {
        ...EXPECTED_BASE,
        user: '0x' + 'ab'.repeat(32),
      }),
    ).rejects.toThrow('user');
  });

  it('throws on executionCostClaim mismatch', async () => {
    const client = mockClient([makeEvent(makeSettleEventBcs())]);
    await expect(
      verifySettleEventAgainstExpected(client, '0xDIGEST', {
        ...EXPECTED_BASE,
        executionCostClaimMist: '99999',
      }),
    ).rejects.toThrow('executionCostClaimMist');
  });

  it('throws on quotedHostFeeMist mismatch', async () => {
    const client = mockClient([makeEvent(makeSettleEventBcs())]);
    await expect(
      verifySettleEventAgainstExpected(client, '0xDIGEST', {
        ...EXPECTED_BASE,
        quotedHostFeeMist: '99999',
      }),
    ).rejects.toThrow('quotedHostFeeMist');
  });

  it('throws on protocolFee mismatch', async () => {
    const client = mockClient([makeEvent(makeSettleEventBcs())]);
    await expect(
      verifySettleEventAgainstExpected(client, '0xDIGEST', {
        ...EXPECTED_BASE,
        protocolFeeMist: '99999',
      }),
    ).rejects.toThrow('protocolFeeMist');
  });

  it('reports multiple mismatches', async () => {
    const client = mockClient([makeEvent(makeSettleEventBcs())]);
    await expect(
      verifySettleEventAgainstExpected(client, '0xDIGEST', {
        orderId: ORDER_ID,
        receiptId: 'ff'.repeat(32),
        user: '0x' + 'ab'.repeat(32),
      }),
    ).rejects.toThrow(/receiptId.*user/s);
  });

  it('rejects before network fetch when expected fields are missing', async () => {
    const client = mockClient([makeEvent(makeSettleEventBcs())]);
    await expect(
      verifySettleEventAgainstExpected(
        client,
        '0xDIGEST',
        {} as Parameters<typeof verifySettleEventAgainstExpected>[2],
      ),
    ).rejects.toThrow('expected.receiptId is required');
    expect(client.getTransaction).not.toHaveBeenCalled();
  });

  it('rejects receipt and direct order hashes that are empty after removing 0x', async () => {
    const client = mockClient([makeEvent(makeSettleEventBcs())]);

    await expect(
      verifySettleEventAgainstExpected(client, '0xDIGEST', {
        ...EXPECTED_BASE,
        receiptId: '0x',
      }),
    ).rejects.toThrow('expected.receiptId must be a 32-byte hex string');

    await expect(
      verifySettleEventAgainstExpected(client, '0xDIGEST', {
        receiptId: RECEIPT_ID_HEX,
        orderIdHash: '0x',
        user: USER_ADDR,
      }),
    ).rejects.toThrow('expected.orderIdHash must be a 32-byte hex string');

    expect(client.getTransaction).not.toHaveBeenCalled();
  });

  it('rejects when neither orderId nor orderIdHash is provided', async () => {
    const client = mockClient([makeEvent(makeSettleEventBcs())]);
    await expect(
      verifySettleEventAgainstExpected(client, '0xDIGEST', {
        receiptId: RECEIPT_ID_HEX,
        user: USER_ADDR,
      } as unknown as Parameters<typeof verifySettleEventAgainstExpected>[2]),
    ).rejects.toThrow('exactly one of orderId or orderIdHash');
    expect(client.getTransaction).not.toHaveBeenCalled();
  });

  it('rejects when both orderId and orderIdHash are provided', async () => {
    const client = mockClient([makeEvent(makeSettleEventBcs())]);
    await expect(
      verifySettleEventAgainstExpected(client, '0xDIGEST', {
        receiptId: RECEIPT_ID_HEX,
        orderId: ORDER_ID,
        orderIdHash: createHash('sha256').update(ORDER_ID).digest('hex'),
        user: USER_ADDR,
      } as unknown as Parameters<typeof verifySettleEventAgainstExpected>[2]),
    ).rejects.toThrow('exactly one of orderId or orderIdHash');
    expect(client.getTransaction).not.toHaveBeenCalled();
  });

  it('matches canonical Sui addresses across padding and case', async () => {
    const client = mockClient([makeEvent(makeSettleEventBcs())]);
    const result = await verifySettleEventAgainstExpected(client, '0xDIGEST', {
      ...EXPECTED_BASE,
      user: '0x1234ABCD',
    });

    expect(result.user).toBe(USER_ADDR);
  });

  it('rejects duplicate canonical SettleEvents', async () => {
    const event = makeEvent(makeSettleEventBcs());
    const client = mockClient([event, event]);

    await expect(
      verifySettleEventAgainstExpected(client, '0xDIGEST', EXPECTED_BASE),
    ).rejects.toThrow('Expected exactly one SettleEvent');
  });

  it('rejects a SettleEvent emitted under the wrong package', async () => {
    const client = mockClient([
      makeEvent(makeSettleEventBcs(), `0x${'9'.repeat(64)}::events::SettleEvent`),
    ]);

    await expect(
      verifySettleEventAgainstExpected(client, '0xDIGEST', EXPECTED_BASE),
    ).rejects.toThrow('SettleEvent not found');
  });
});
