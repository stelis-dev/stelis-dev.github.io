import { beforeEach, describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  verifySettleEventAgainstExpected,
  verifySettleEventResultAgainstExpected,
} from '../../src/server/verifySettleEventAgainstExpected.js';
import { decodeSettleEvent } from '../../src/server/settleEventDecoder.js';
import type { SuiGrpcClient } from '@mysten/sui/grpc';
import type { SuiTransactionWithEventsResult } from '@stelis/core-relay/browser';
import { STELIS_CONTRACT_IDS, SUI_CHAIN_IDENTIFIERS } from '@stelis/contracts';
import { serializeSettleEventBcs, type SettleEventBcsInput } from '../helpers/settleEventBcs.js';
import { withSuiClientIdentity } from '../helpers/suiClientIdentity.js';

const { getSuiTransactionEventsMock } = vi.hoisted(() => ({
  getSuiTransactionEventsMock: vi.fn(),
}));

vi.mock('@stelis/core-relay/browser', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@stelis/core-relay/browser')>();
  return { ...actual, getSuiTransactionEvents: getSuiTransactionEventsMock };
});

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

const RECEIPT_ID_HEX = '0x' + 'aabbccdd' + '00'.repeat(28);
const ORDER_ID = 'ord_001';
const USER_ADDR = '0x' + '0'.repeat(56) + '1234abcd'; // TEST_USER
const TREASURY_ADDR = '0x' + 'ff'.repeat(32);
const SETTLEMENT_PAYOUT_RECIPIENT_ADDR = '0x' + 'ee'.repeat(32);
const EXPECTED_BASE = {
  receiptId: RECEIPT_ID_HEX,
  orderId: ORDER_ID,
  user: USER_ADDR,
} as const;

type SuiEvent = Extract<SuiTransactionWithEventsResult, { outcome: 'success' }>['events'][number];

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

function makeEvent(bcsBytes: Uint8Array, overrides: Partial<Omit<SuiEvent, 'bcs'>> = {}): SuiEvent {
  return {
    packageId: PACKAGE_ID,
    module: 'settle',
    sender: USER_ADDR,
    eventType: `${PACKAGE_ID}::events::SettleEvent`,
    bcs: bcsBytes,
    ...overrides,
  };
}

function successfulTransaction(
  events: readonly SuiEvent[],
  digest = '0xDIGEST',
): SuiTransactionWithEventsResult {
  return {
    outcome: 'success',
    digest,
    effects: {
      version: 2,
      transactionDigest: digest,
      status: { success: true, error: null },
      gasUsed: {
        computationCost: '1',
        storageCost: '1',
        storageRebate: '0',
        nonRefundableStorageFee: '0',
      },
      eventsDigest: null,
    },
    events,
  };
}

function failedTransaction(events: readonly SuiEvent[]): SuiTransactionWithEventsResult {
  const error = { kind: 'MoveAbortRaw' as const };
  return {
    outcome: 'failure',
    digest: '0xDIGEST',
    effects: {
      version: 2,
      transactionDigest: '0xDIGEST',
      status: { success: false, error },
      gasUsed: {
        computationCost: '1',
        storageCost: '1',
        storageRebate: '0',
        nonRefundableStorageFee: '0',
      },
      eventsDigest: null,
    },
    events,
    error,
  };
}

function mockClient(
  result: SuiTransactionWithEventsResult,
  network: 'testnet' | 'mainnet' = 'testnet',
  chainIdentifier = SUI_CHAIN_IDENTIFIERS[network],
): SuiGrpcClient {
  const client = withSuiClientIdentity({}, network, chainIdentifier);
  getSuiTransactionEventsMock.mockReturnValue(result);
  return client;
}

function mockEmptyClient(): SuiGrpcClient {
  return mockClient(successfulTransaction([]));
}

function mockFailedClient(events: readonly SuiEvent[]): SuiGrpcClient {
  return mockClient(failedTransaction(events));
}

beforeEach(() => {
  getSuiTransactionEventsMock.mockReset();
});

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

describe('verifySettleEventAgainstExpected', () => {
  it('verifies an already-loaded exact result without a second event read', () => {
    const terminal = successfulTransaction([makeEvent(makeSettleEventBcs())]);

    const result = verifySettleEventResultAgainstExpected(terminal, '0xDIGEST', EXPECTED_BASE);

    expect(result.receiptId).toBe(RECEIPT_ID_HEX);
    expect(getSuiTransactionEventsMock).not.toHaveBeenCalled();
  });

  it('returns verified fields on match', async () => {
    const client = mockClient(successfulTransaction([makeEvent(makeSettleEventBcs())]));
    const result = await verifySettleEventAgainstExpected(client, '0xDIGEST', EXPECTED_BASE);

    expect(result.receiptId).toBe(RECEIPT_ID_HEX);
    expect(result.user).toBe(USER_ADDR);
    expect(result.executionCostClaim).toBe('50000');
    expect(result.execTimestampMs).toBe('1700000000000');
    expect(getSuiTransactionEventsMock).toHaveBeenCalledTimes(1);
  });

  it('rejects a client declared for another network before reading events', async () => {
    const client = mockClient(successfulTransaction([makeEvent(makeSettleEventBcs())]), 'mainnet');

    await expect(
      verifySettleEventAgainstExpected(client, '0xDIGEST', EXPECTED_BASE),
    ).rejects.toThrow('Sui operation request was invalid');
    expect(getSuiTransactionEventsMock).not.toHaveBeenCalled();
  });

  it('rejects a live chain identifier that disagrees with the settlement network', async () => {
    const client = mockClient(
      successfulTransaction([makeEvent(makeSettleEventBcs())]),
      'testnet',
      SUI_CHAIN_IDENTIFIERS.mainnet,
    );

    await expect(
      verifySettleEventAgainstExpected(client, '0xDIGEST', EXPECTED_BASE),
    ).rejects.toThrow('Sui operation returned a malformed response');
    expect(getSuiTransactionEventsMock).not.toHaveBeenCalled();
  });

  it('verifies orderId hash correctly', async () => {
    const client = mockClient(successfulTransaction([makeEvent(makeSettleEventBcs())]));
    const result = await verifySettleEventAgainstExpected(client, '0xDIGEST', {
      receiptId: RECEIPT_ID_HEX,
      orderIdHash: createHash('sha256').update(ORDER_ID).digest('hex'),
      user: USER_ADDR,
    });

    expect(result.orderIdHash).toBe(createHash('sha256').update(ORDER_ID).digest('hex'));
  });

  it('accepts an optional 0x prefix on the exact 32-byte order hash', async () => {
    const orderIdHash = createHash('sha256').update(ORDER_ID).digest('hex');
    const client = mockClient(successfulTransaction([makeEvent(makeSettleEventBcs())]));

    const result = await verifySettleEventAgainstExpected(client, '0xDIGEST', {
      receiptId: RECEIPT_ID_HEX,
      orderIdHash: `0x${orderIdHash}`,
      user: USER_ADDR,
    });

    expect(result.receiptId).toBe(RECEIPT_ID_HEX);
    expect(result.orderIdHash).toBe(orderIdHash);
  });

  it('treats undefined orderId as absent when orderIdHash is provided', async () => {
    const client = mockClient(successfulTransaction([makeEvent(makeSettleEventBcs())]));
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

  it('rejects a normalized failed transaction before consuming a matching event', async () => {
    const client = mockFailedClient([makeEvent(makeSettleEventBcs())]);

    await expect(
      verifySettleEventAgainstExpected(client, '0xDIGEST', EXPECTED_BASE),
    ).rejects.toThrow(/Transaction 0xDIGEST failed: Sui execution failed \(MoveAbortRaw\)/);
  });

  it('rejects a gateway result for a different digest', async () => {
    const client = mockClient(successfulTransaction([makeEvent(makeSettleEventBcs())], '0xOTHER'));

    await expect(
      verifySettleEventAgainstExpected(client, '0xDIGEST', EXPECTED_BASE),
    ).rejects.toThrow('returned a mismatched result');
  });

  it('throws when SettleEvent eventType not found', async () => {
    const client = mockClient(
      successfulTransaction([
        makeEvent(new Uint8Array(0), {
          eventType: `0x${'9'.repeat(64)}::events::Other`,
        }),
      ]),
    );
    await expect(
      verifySettleEventAgainstExpected(client, '0xDIGEST', EXPECTED_BASE),
    ).rejects.toThrow('SettleEvent not found');
  });

  it('throws on receiptId mismatch', async () => {
    const client = mockClient(successfulTransaction([makeEvent(makeSettleEventBcs())]));
    await expect(
      verifySettleEventAgainstExpected(client, '0xDIGEST', {
        ...EXPECTED_BASE,
        receiptId: `0x${'ff'.repeat(32)}`,
      }),
    ).rejects.toThrow('receiptId');
  });

  it('throws on orderId hash mismatch', async () => {
    const client = mockClient(successfulTransaction([makeEvent(makeSettleEventBcs())]));
    await expect(
      verifySettleEventAgainstExpected(client, '0xDIGEST', {
        receiptId: RECEIPT_ID_HEX,
        orderId: 'wrong_order',
        user: USER_ADDR,
      }),
    ).rejects.toThrow('orderIdHash');
  });

  it('throws on user mismatch', async () => {
    const client = mockClient(successfulTransaction([makeEvent(makeSettleEventBcs())]));
    await expect(
      verifySettleEventAgainstExpected(client, '0xDIGEST', {
        ...EXPECTED_BASE,
        user: '0x' + 'ab'.repeat(32),
      }),
    ).rejects.toThrow('user');
  });

  it('throws on executionCostClaim mismatch', async () => {
    const client = mockClient(successfulTransaction([makeEvent(makeSettleEventBcs())]));
    await expect(
      verifySettleEventAgainstExpected(client, '0xDIGEST', {
        ...EXPECTED_BASE,
        executionCostClaimMist: '99999',
      }),
    ).rejects.toThrow('executionCostClaimMist');
  });

  it('throws on quotedHostFeeMist mismatch', async () => {
    const client = mockClient(successfulTransaction([makeEvent(makeSettleEventBcs())]));
    await expect(
      verifySettleEventAgainstExpected(client, '0xDIGEST', {
        ...EXPECTED_BASE,
        quotedHostFeeMist: '99999',
      }),
    ).rejects.toThrow('quotedHostFeeMist');
  });

  it('throws on protocolFee mismatch', async () => {
    const client = mockClient(successfulTransaction([makeEvent(makeSettleEventBcs())]));
    await expect(
      verifySettleEventAgainstExpected(client, '0xDIGEST', {
        ...EXPECTED_BASE,
        protocolFeeMist: '99999',
      }),
    ).rejects.toThrow('protocolFeeMist');
  });

  it('reports multiple mismatches', async () => {
    const client = mockClient(successfulTransaction([makeEvent(makeSettleEventBcs())]));
    await expect(
      verifySettleEventAgainstExpected(client, '0xDIGEST', {
        orderId: ORDER_ID,
        receiptId: `0x${'ff'.repeat(32)}`,
        user: '0x' + 'ab'.repeat(32),
      }),
    ).rejects.toThrow(/receiptId.*user/s);
  });

  it('rejects before network fetch when expected fields are missing', async () => {
    const client = mockClient(successfulTransaction([makeEvent(makeSettleEventBcs())]));
    await expect(
      verifySettleEventAgainstExpected(
        client,
        '0xDIGEST',
        {} as Parameters<typeof verifySettleEventAgainstExpected>[2],
      ),
    ).rejects.toThrow('expected.receiptId is required');
    expect(getSuiTransactionEventsMock).not.toHaveBeenCalled();
  });

  it('rejects receipt and direct order hashes that are empty after removing 0x', async () => {
    const client = mockClient(successfulTransaction([makeEvent(makeSettleEventBcs())]));

    await expect(
      verifySettleEventAgainstExpected(client, '0xDIGEST', {
        ...EXPECTED_BASE,
        receiptId: '0x',
      }),
    ).rejects.toThrow('expected.receiptId must be 0x followed by 64 lowercase hex digits');

    await expect(
      verifySettleEventAgainstExpected(client, '0xDIGEST', {
        receiptId: RECEIPT_ID_HEX,
        orderIdHash: '0x',
        user: USER_ADDR,
      }),
    ).rejects.toThrow('expected.orderIdHash must be a 32-byte hex string');

    expect(getSuiTransactionEventsMock).not.toHaveBeenCalled();
  });

  it('rejects when neither orderId nor orderIdHash is provided', async () => {
    const client = mockClient(successfulTransaction([makeEvent(makeSettleEventBcs())]));
    await expect(
      verifySettleEventAgainstExpected(client, '0xDIGEST', {
        receiptId: RECEIPT_ID_HEX,
        user: USER_ADDR,
      } as unknown as Parameters<typeof verifySettleEventAgainstExpected>[2]),
    ).rejects.toThrow('exactly one of orderId or orderIdHash');
    expect(getSuiTransactionEventsMock).not.toHaveBeenCalled();
  });

  it('rejects when both orderId and orderIdHash are provided', async () => {
    const client = mockClient(successfulTransaction([makeEvent(makeSettleEventBcs())]));
    await expect(
      verifySettleEventAgainstExpected(client, '0xDIGEST', {
        receiptId: RECEIPT_ID_HEX,
        orderId: ORDER_ID,
        orderIdHash: createHash('sha256').update(ORDER_ID).digest('hex'),
        user: USER_ADDR,
      } as unknown as Parameters<typeof verifySettleEventAgainstExpected>[2]),
    ).rejects.toThrow('exactly one of orderId or orderIdHash');
    expect(getSuiTransactionEventsMock).not.toHaveBeenCalled();
  });

  it('matches canonical Sui addresses across padding and case', async () => {
    const client = mockClient(successfulTransaction([makeEvent(makeSettleEventBcs())]));
    const result = await verifySettleEventAgainstExpected(client, '0xDIGEST', {
      ...EXPECTED_BASE,
      user: '0x1234ABCD',
    });

    expect(result.user).toBe(USER_ADDR);
  });

  it('rejects duplicate canonical SettleEvents', async () => {
    const event = makeEvent(makeSettleEventBcs());
    const client = mockClient(successfulTransaction([event, event]));

    await expect(
      verifySettleEventAgainstExpected(client, '0xDIGEST', EXPECTED_BASE),
    ).rejects.toThrow('Expected exactly one SettleEvent');
  });

  it('rejects a SettleEvent emitted under the wrong package', async () => {
    const client = mockClient(
      successfulTransaction([
        makeEvent(makeSettleEventBcs(), {
          eventType: `0x${'9'.repeat(64)}::events::SettleEvent`,
        }),
      ]),
    );

    await expect(
      verifySettleEventAgainstExpected(client, '0xDIGEST', EXPECTED_BASE),
    ).rejects.toThrow('SettleEvent not found');
  });

  it.each([
    ['package', { packageId: `0x${'9'.repeat(64)}` }],
    ['module', { module: 'not_settle' }],
  ] as const)(
    'rejects a canonical eventType whose top-level %s identity conflicts',
    async (_field, overrides) => {
      const client = mockClient(
        successfulTransaction([makeEvent(makeSettleEventBcs(), overrides)]),
      );

      await expect(
        verifySettleEventAgainstExpected(client, '0xDIGEST', EXPECTED_BASE),
      ).rejects.toThrow('envelope identity');
    },
  );

  it('rejects a canonical event whose sender conflicts with the decoded user', async () => {
    const client = mockClient(
      successfulTransaction([makeEvent(makeSettleEventBcs(), { sender: `0x${'dd'.repeat(32)}` })]),
    );

    await expect(
      verifySettleEventAgainstExpected(client, '0xDIGEST', EXPECTED_BASE),
    ).rejects.toThrow('sender does not match');
  });
});
