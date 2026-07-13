/**
 * Tests for extractSettleEvents.
 *
 * Uses realistic Sui transaction-result discriminants while keeping the
 * network client local and deterministic.
 */

import { describe, it, expect, vi } from 'vitest';
import { extractSettleEvents } from '../../src/server/extractSettleEvents.js';
import { SettleEventBcs } from '../../src/server/settleEventDecoder.js';
import { STELIS_CONTRACT_IDS } from '@stelis/contracts';

const PACKAGE_ID = STELIS_CONTRACT_IDS.testnet!.packageId;
const SETTLE_EVENT_TYPE = `${PACKAGE_ID}::events::SettleEvent`;
const USER = `0x${'ab'.repeat(32)}`;

function createMockSettleEventBcs(
  overrides: {
    receiptId?: number[];
    user?: string;
    orderIdHash?: number[];
    execTimestampMs?: bigint;
  } = {},
): Uint8Array {
  return SettleEventBcs.serialize({
    receipt_id: overrides.receiptId ?? Array.from({ length: 32 }, (_, i) => i),
    nonce: 1n,
    policy_hash: Array.from({ length: 32 }, () => 0),
    quote_timestamp_ms: 1000n,
    exec_timestamp_ms: overrides.execTimestampMs ?? 2000n,
    sim_gas_reported: 100n,
    gas_variance_fixed_mist: 10n,
    slippage_buffer_mist: 5n,
    execution_cost_claim_mist: 50n,
    quoted_host_fee_mist: 60n,
    protocol_fee: 20n,
    protocol_treasury: `0x${'00'.repeat(32)}`,
    payout: 900n,
    total_in: 1000n,
    surplus_credited: 0n,
    config_version: 1n,
    user: overrides.user ?? USER,
    settlement_payout_recipient: `0x${'cc'.repeat(32)}`,
    order_id_hash: overrides.orderIdHash ?? Array.from({ length: 32 }, () => 0xff),
  }).toBytes();
}

function createEvent(bcs: Uint8Array, eventType = SETTLE_EVENT_TYPE) {
  return {
    packageId: PACKAGE_ID,
    module: 'events',
    sender: USER,
    eventType,
    bcs,
    json: null,
  };
}

function successfulTransaction(events: unknown[] | undefined, digest = 'digest') {
  return {
    $kind: 'Transaction',
    Transaction: {
      digest,
      signatures: [],
      epoch: '1',
      status: { success: true, error: null },
      events,
    },
  };
}

function failedTransaction(events: unknown[], message: string, digest = 'failed') {
  return {
    $kind: 'FailedTransaction',
    FailedTransaction: {
      digest,
      signatures: [],
      epoch: '1',
      status: {
        success: false,
        error: { $kind: 'Unknown', Unknown: null, message },
      },
      events,
    },
  };
}

function createMockClient(responses: Record<string, unknown>) {
  return {
    getTransaction: vi.fn(async ({ digest }: { digest: string }) => {
      const response = responses[digest];
      if (response instanceof Error) throw response;
      return response;
    }),
  } as unknown as import('@mysten/sui/grpc').SuiGrpcClient;
}

describe('extractSettleEvents', () => {
  it('extracts the canonical SettleEvent from a successful transaction', async () => {
    const logger = vi.fn();
    const client = createMockClient({
      digest1: successfulTransaction([createEvent(createMockSettleEventBcs())], 'digest1'),
    });

    const results = await extractSettleEvents(client, ['digest1'], logger);

    expect(results).toEqual([
      expect.objectContaining({ digest: 'digest1', user: USER, timestampMs: '2000' }),
    ]);
    expect(logger).not.toHaveBeenCalled();
  });

  it('normally skips a successful transaction with no canonical SettleEvent', async () => {
    const logger = vi.fn();
    const client = createMockClient({
      digest2: successfulTransaction([
        createEvent(new Uint8Array(), `${PACKAGE_ID}::events::OtherEvent`),
      ]),
    });

    const results = await extractSettleEvents(client, ['digest2'], logger);

    expect(results).toEqual([]);
    expect(logger).not.toHaveBeenCalled();
  });

  it('continues after a fetch failure and reports the failed digest', async () => {
    const logger = vi.fn();
    const client = createMockClient({
      bad: new Error('network timeout'),
      good: successfulTransaction([createEvent(createMockSettleEventBcs())], 'good'),
    });

    const results = await extractSettleEvents(client, ['bad', 'good'], logger);

    expect(results).toEqual([expect.objectContaining({ digest: 'good' })]);
    expect(logger).toHaveBeenCalledWith(expect.stringContaining('network timeout'));
  });

  it('skips a FailedTransaction even when it carries a matching event', async () => {
    const logger = vi.fn();
    const event = createEvent(createMockSettleEventBcs());
    const client = createMockClient({
      failed: failedTransaction([event], 'MoveAbort in settlement', 'failed'),
    });

    const results = await extractSettleEvents(client, ['failed'], logger);

    expect(results).toEqual([]);
    expect(logger).toHaveBeenCalledWith(expect.stringContaining('execution failed'));
    expect(logger).toHaveBeenCalledWith(expect.stringContaining('MoveAbort in settlement'));
  });

  it('reports and skips a successful response missing requested events', async () => {
    const logger = vi.fn();
    const client = createMockClient({ missing: successfulTransaction(undefined, 'missing') });

    const results = await extractSettleEvents(client, ['missing'], logger);

    expect(results).toEqual([]);
    expect(logger).toHaveBeenCalledWith(expect.stringContaining('requested events were missing'));
  });

  it('skips duplicate SettleEvents and reports the count boundary', async () => {
    const logger = vi.fn();
    const event = createEvent(createMockSettleEventBcs());
    const client = createMockClient({ duplicate: successfulTransaction([event, event]) });

    const results = await extractSettleEvents(client, ['duplicate'], logger);

    expect(results).toEqual([]);
    expect(logger).toHaveBeenCalledWith(expect.stringContaining('expected one SettleEvent'));
  });

  it('skips non-canonical event BCS and reports the rejected boundary', async () => {
    const canonical = createMockSettleEventBcs();
    const withTrailingByte = new Uint8Array(canonical.length + 1);
    withTrailingByte.set(canonical);
    const logger = vi.fn();
    const client = createMockClient({
      malformed: successfulTransaction([createEvent(withTrailingByte)]),
    });

    const results = await extractSettleEvents(client, ['malformed'], logger);

    expect(results).toEqual([]);
    expect(logger).toHaveBeenCalledWith(expect.stringContaining('invalid SettleEvent BCS'));
    expect(logger).toHaveBeenCalledWith(expect.stringContaining('not canonical'));
  });
});
