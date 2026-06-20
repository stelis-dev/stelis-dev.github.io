/**
 * Tests for extractSettleEvents.
 *
 * Uses mock SuiGrpcClient to check batch extraction behavior.
 */

import { describe, it, expect, vi } from 'vitest';
import { extractSettleEvents } from '../../src/server/extractSettleEvents.js';
import { SettleEventBcs } from '../../src/server/settleEventDecoder.js';

// ─────────────────────────────────────────────
// Mock data
// ─────────────────────────────────────────────

const PACKAGE_ID = '0xabc123';
const SETTLE_EVENT_TYPE = `${PACKAGE_ID}::events::SettleEvent`;

/** Create a valid SettleEvent BCS payload for testing. */
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
    quote_timestamp_ms: BigInt(1000),
    exec_timestamp_ms: overrides.execTimestampMs ?? BigInt(2000),
    sim_gas_reported: BigInt(100),
    gas_variance_fixed_mist: BigInt(10),
    slippage_buffer_mist: BigInt(5),
    execution_cost_claim_mist: BigInt(50),
    quoted_host_fee_mist: BigInt(60),
    protocol_fee: BigInt(20),
    protocol_treasury: '0x' + '00'.repeat(32),
    payout: BigInt(900),
    total_in: BigInt(1000),
    surplus_credited: BigInt(0),
    config_version: BigInt(1),
    user: overrides.user ?? '0x' + 'ab'.repeat(32),
    settlement_payout_recipient: '0x' + 'cc'.repeat(32),
    order_id_hash: overrides.orderIdHash ?? Array.from({ length: 32 }, () => 0xff),
  }).toBytes();
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

// ─────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────

describe('extractSettleEvents', () => {
  it('B-1: extracts SettleEvent from TX with events', async () => {
    const bcsBytes = createMockSettleEventBcs();
    const client = createMockClient({
      digest1: {
        Transaction: {
          events: [{ eventType: SETTLE_EVENT_TYPE, bcs: bcsBytes }],
        },
      },
    });

    const results = await extractSettleEvents(client, ['digest1'], {
      packageId: PACKAGE_ID,
    });

    expect(results).toHaveLength(1);
    expect(results[0].digest).toBe('digest1');
    expect(results[0].receiptId).toMatch(/^[0-9a-f]+$/);
    expect(results[0].user).toBeTruthy();
    expect(results[0].timestampMs).toBe('2000');
  });

  it('B-2: returns empty for TX without SettleEvent', async () => {
    const client = createMockClient({
      digest2: {
        Transaction: {
          events: [{ eventType: `${PACKAGE_ID}::events::OtherEvent`, bcs: new Uint8Array() }],
        },
      },
    });

    const results = await extractSettleEvents(client, ['digest2'], {
      packageId: PACKAGE_ID,
    });

    expect(results).toHaveLength(0);
  });

  it('B-3: batch processing — 3 digests, 2 with SettleEvent', async () => {
    const bcs1 = createMockSettleEventBcs({ execTimestampMs: BigInt(1000) });
    const bcs2 = createMockSettleEventBcs({ execTimestampMs: BigInt(3000) });
    const client = createMockClient({
      d1: { Transaction: { events: [{ eventType: SETTLE_EVENT_TYPE, bcs: bcs1 }] } },
      d2: { Transaction: { events: [] } },
      d3: { Transaction: { events: [{ eventType: SETTLE_EVENT_TYPE, bcs: bcs2 }] } },
    });

    const results = await extractSettleEvents(client, ['d1', 'd2', 'd3'], {
      packageId: PACKAGE_ID,
    });

    expect(results).toHaveLength(2);
    expect(results[0].digest).toBe('d1');
    expect(results[0].timestampMs).toBe('1000');
    expect(results[1].digest).toBe('d3');
    expect(results[1].timestampMs).toBe('3000');
  });

  it('B-4: skips failed digest, processes rest normally', async () => {
    const bcsOk = createMockSettleEventBcs();
    const logger = vi.fn();
    const client = createMockClient({
      good: { Transaction: { events: [{ eventType: SETTLE_EVENT_TYPE, bcs: bcsOk }] } },
      bad: new Error('network timeout'),
    });

    const results = await extractSettleEvents(client, ['bad', 'good'], {
      packageId: PACKAGE_ID,
      logger,
    });

    expect(results).toHaveLength(1);
    expect(results[0].digest).toBe('good');
    expect(logger).toHaveBeenCalledWith(expect.stringContaining('network timeout'));
  });
});
