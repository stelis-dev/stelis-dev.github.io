import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { verifySettleEventAgainstExpected } from '../../src/server/verifySettleEventAgainstExpected.js';
import { SettleEventBcs } from '../../src/server/settleEventDecoder.js';
import type { SuiGrpcClient } from '@mysten/sui/grpc';

const PACKAGE_ID = '0xPACKAGE';

function hex2bytes(hex: string): number[] {
  const clean = hex.replace(/^0x/, '');
  const bytes: number[] = [];
  for (let i = 0; i < clean.length; i += 2) {
    bytes.push(parseInt(clean.slice(i, i + 2), 16));
  }
  return bytes;
}

function sha256Bytes(input: string): number[] {
  const buf = createHash('sha256').update(input).digest();
  return Array.from(buf);
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

function makeSettleEventBcs(overrides?: Record<string, unknown>) {
  const data = {
    receipt_id: hex2bytes(RECEIPT_ID_HEX),
    nonce: 1n,
    policy_hash: Array.from({ length: 32 }, () => 0),
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
    ...overrides,
  };
  return SettleEventBcs.serialize(data).toBytes();
}

function makeEvent(bcsBytes: Uint8Array) {
  return {
    packageId: PACKAGE_ID,
    module: 'events',
    sender: USER_ADDR,
    eventType: `${PACKAGE_ID}::events::SettleEvent`,
    bcs: bcsBytes,
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
        status: { success: true },
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
        status: { success: true },
      },
    }),
  } as unknown as SuiGrpcClient;
}

describe('verifySettleEventAgainstExpected', () => {
  it('returns verified fields on match', async () => {
    const client = mockClient([makeEvent(makeSettleEventBcs())]);
    const result = await verifySettleEventAgainstExpected(
      client,
      '0xDIGEST',
      PACKAGE_ID,
      EXPECTED_BASE,
    );

    expect(result.receiptId).toBe(RECEIPT_ID_HEX);
    expect(result.user).toBe(USER_ADDR);
    expect(result.executionCostClaim).toBe('50000');
    expect(result.execTimestampMs).toBe('1700000000000');
  });

  it('verifies orderId hash correctly', async () => {
    const client = mockClient([makeEvent(makeSettleEventBcs())]);
    const result = await verifySettleEventAgainstExpected(client, '0xDIGEST', PACKAGE_ID, {
      receiptId: RECEIPT_ID_HEX,
      orderIdHash: createHash('sha256').update(ORDER_ID).digest('hex'),
      user: USER_ADDR,
    });

    expect(result.orderIdHash).toBe(createHash('sha256').update(ORDER_ID).digest('hex'));
  });

  it('treats undefined orderId as absent when orderIdHash is provided', async () => {
    const client = mockClient([makeEvent(makeSettleEventBcs())]);
    const result = await verifySettleEventAgainstExpected(client, '0xDIGEST', PACKAGE_ID, {
      receiptId: RECEIPT_ID_HEX,
      orderId: undefined,
      orderIdHash: createHash('sha256').update(ORDER_ID).digest('hex'),
      user: USER_ADDR,
    } as Parameters<typeof verifySettleEventAgainstExpected>[3]);

    expect(result.orderIdHash).toBe(createHash('sha256').update(ORDER_ID).digest('hex'));
  });

  it('throws when no events found', async () => {
    const client = mockEmptyClient();
    await expect(
      verifySettleEventAgainstExpected(client, '0xDIGEST', PACKAGE_ID, EXPECTED_BASE),
    ).rejects.toThrow('No events found');
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
      verifySettleEventAgainstExpected(client, '0xDIGEST', PACKAGE_ID, EXPECTED_BASE),
    ).rejects.toThrow('SettleEvent not found');
  });

  it('throws on receiptId mismatch', async () => {
    const client = mockClient([makeEvent(makeSettleEventBcs())]);
    await expect(
      verifySettleEventAgainstExpected(client, '0xDIGEST', PACKAGE_ID, {
        ...EXPECTED_BASE,
        receiptId: 'ff'.repeat(32),
      }),
    ).rejects.toThrow('receiptId');
  });

  it('throws on orderId hash mismatch', async () => {
    const client = mockClient([makeEvent(makeSettleEventBcs())]);
    await expect(
      verifySettleEventAgainstExpected(client, '0xDIGEST', PACKAGE_ID, {
        receiptId: RECEIPT_ID_HEX,
        orderId: 'wrong_order',
        user: USER_ADDR,
      }),
    ).rejects.toThrow('orderIdHash');
  });

  it('throws on user mismatch', async () => {
    const client = mockClient([makeEvent(makeSettleEventBcs())]);
    await expect(
      verifySettleEventAgainstExpected(client, '0xDIGEST', PACKAGE_ID, {
        ...EXPECTED_BASE,
        user: '0x' + 'ab'.repeat(32),
      }),
    ).rejects.toThrow('user');
  });

  it('throws on executionCostClaim mismatch', async () => {
    const client = mockClient([makeEvent(makeSettleEventBcs())]);
    await expect(
      verifySettleEventAgainstExpected(client, '0xDIGEST', PACKAGE_ID, {
        ...EXPECTED_BASE,
        executionCostClaimMist: '99999',
      }),
    ).rejects.toThrow('executionCostClaimMist');
  });

  it('throws on quotedHostFeeMist mismatch', async () => {
    const client = mockClient([makeEvent(makeSettleEventBcs())]);
    await expect(
      verifySettleEventAgainstExpected(client, '0xDIGEST', PACKAGE_ID, {
        ...EXPECTED_BASE,
        quotedHostFeeMist: '99999',
      }),
    ).rejects.toThrow('quotedHostFeeMist');
  });

  it('throws on protocolFee mismatch', async () => {
    const client = mockClient([makeEvent(makeSettleEventBcs())]);
    await expect(
      verifySettleEventAgainstExpected(client, '0xDIGEST', PACKAGE_ID, {
        ...EXPECTED_BASE,
        protocolFeeMist: '99999',
      }),
    ).rejects.toThrow('protocolFeeMist');
  });

  it('reports multiple mismatches', async () => {
    const client = mockClient([makeEvent(makeSettleEventBcs())]);
    await expect(
      verifySettleEventAgainstExpected(client, '0xDIGEST', PACKAGE_ID, {
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
        PACKAGE_ID,
        {} as Parameters<typeof verifySettleEventAgainstExpected>[3],
      ),
    ).rejects.toThrow('expected.receiptId is required');
    expect(client.getTransaction).not.toHaveBeenCalled();
  });

  it('rejects when neither orderId nor orderIdHash is provided', async () => {
    const client = mockClient([makeEvent(makeSettleEventBcs())]);
    await expect(
      verifySettleEventAgainstExpected(client, '0xDIGEST', PACKAGE_ID, {
        receiptId: RECEIPT_ID_HEX,
        user: USER_ADDR,
      } as Parameters<typeof verifySettleEventAgainstExpected>[3]),
    ).rejects.toThrow('exactly one of orderId or orderIdHash');
    expect(client.getTransaction).not.toHaveBeenCalled();
  });

  it('rejects when both orderId and orderIdHash are provided', async () => {
    const client = mockClient([makeEvent(makeSettleEventBcs())]);
    await expect(
      verifySettleEventAgainstExpected(client, '0xDIGEST', PACKAGE_ID, {
        receiptId: RECEIPT_ID_HEX,
        orderId: ORDER_ID,
        orderIdHash: createHash('sha256').update(ORDER_ID).digest('hex'),
        user: USER_ADDR,
      } as Parameters<typeof verifySettleEventAgainstExpected>[3]),
    ).rejects.toThrow('exactly one of orderId or orderIdHash');
    expect(client.getTransaction).not.toHaveBeenCalled();
  });
});
