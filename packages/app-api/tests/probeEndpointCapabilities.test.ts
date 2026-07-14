/**
 * probeEndpointCapabilities — boot-time RPC capability probe tests.
 *
 * Locks the invariant that endpoints are rejected when:
 *   - getObject cannot find the Stelis Config (probe 1 fail)
 *   - DEEP CoinMetadata is not indexed (probe 2 fail)
 *   - simulateTransaction throws (probe 3 fail, e.g. "rest index store is disabled")
 *
 * This prevents endpoints without transaction-simulation capability from
 * becoming the failover primary and blocking settlement swap path registry initialization
 * (see docs/operations.md#rpc-fleet-configuration).
 */
import { describe, it, expect, vi } from 'vitest';
import { probeEndpointCapabilities } from '../src/sui/probeEndpointCapabilities.js';
import type { SuiGrpcClient } from '@mysten/sui/grpc';
import { TransactionDataBuilder } from '@mysten/sui/transactions';

const CONFIG_ID = '0x' + '1'.repeat(64);
const DEEP_TYPE = '0x' + 'de'.repeat(32) + '::deep::DEEP';
const PROBE_POOL_ID = '0x' + '4'.repeat(64);

const OPTS = {
  stelisConfigId: CONFIG_ID,
  deepCoinType: DEEP_TYPE,
  simulateProbePoolId: PROBE_POOL_ID,
};

/** Stub probe-tx bytes (not a real transaction — tests only inspect the simulate call shape). */
const FAKE_PROBE_TX_BYTES = new Uint8Array([1, 2, 3, 4]);
const FAKE_PROBE_DIGEST = TransactionDataBuilder.getDigestFromBytes(FAKE_PROBE_TX_BYTES);

function successfulProbeResult(digest = FAKE_PROBE_DIGEST) {
  return {
    $kind: 'Transaction' as const,
    Transaction: {
      digest,
      status: { success: true as const, error: null },
      effects: {
        transactionDigest: digest,
        status: { success: true as const, error: null },
      },
    },
  };
}

function makeClient(overrides: {
  getObject?: ReturnType<typeof vi.fn>;
  getCoinMetadata?: ReturnType<typeof vi.fn>;
  simulateTransaction?: ReturnType<typeof vi.fn>;
}): SuiGrpcClient {
  return {
    getObject: overrides.getObject ?? vi.fn().mockResolvedValue({ object: { id: CONFIG_ID } }),
    getCoinMetadata:
      overrides.getCoinMetadata ?? vi.fn().mockResolvedValue({ coinMetadata: { symbol: 'DEEP' } }),
    simulateTransaction:
      overrides.simulateTransaction ?? vi.fn().mockResolvedValue(successfulProbeResult()),
  } as unknown as SuiGrpcClient;
}

/** Inject a fake probe-tx builder so tests can exercise probe 3 without the real Transaction build. */
const fakeBuilder = vi.fn(async (_client: SuiGrpcClient, _poolId: string) => FAKE_PROBE_TX_BYTES);

const OPTS_WITH_BUILDER = { ...OPTS, buildProbeTxBytes: fakeBuilder };

describe('probeEndpointCapabilities', () => {
  it('passes when all three probes succeed', async () => {
    const client = makeClient({});
    const result = await probeEndpointCapabilities(client, OPTS_WITH_BUILDER);
    expect(result).toEqual({ ok: true, reason: null });
  });

  it('rejects when Stelis Config is missing (probe 1)', async () => {
    const client = makeClient({
      getObject: vi.fn().mockResolvedValue({ object: undefined }),
    });
    const result = await probeEndpointCapabilities(client, OPTS_WITH_BUILDER);
    expect(result).toEqual({ ok: false, reason: 'Stelis Config not found' });
  });

  it('rejects when DEEP CoinMetadata is missing (probe 2)', async () => {
    const client = makeClient({
      getCoinMetadata: vi.fn().mockResolvedValue({ coinMetadata: undefined }),
    });
    const result = await probeEndpointCapabilities(client, OPTS_WITH_BUILDER);
    expect(result).toEqual({ ok: false, reason: 'DEEP CoinMetadata not indexed' });
  });

  it('rejects when simulateTransaction throws "rest index store is disabled" (probe 3)', async () => {
    // This is the exact production failure mode observed on endpoints without
    // the transaction-simulation subsystem (e.g. rpc-testnet.suiscan.xyz).
    const client = makeClient({
      simulateTransaction: vi
        .fn()
        .mockRejectedValue(
          new Error(
            'Error { inner: Inner { kind: Custom, source: Some("rest index store is disabled") } }',
          ),
        ),
    });
    const result = await probeEndpointCapabilities(client, OPTS_WITH_BUILDER);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('rest index store is disabled');
    }
  });

  it('rejects when simulateTransaction throws a generic error (probe 3)', async () => {
    const client = makeClient({
      simulateTransaction: vi.fn().mockRejectedValue(new Error('protocol error')),
    });
    const result = await probeEndpointCapabilities(client, OPTS_WITH_BUILDER);
    expect(result).toEqual({ ok: false, reason: 'protocol error' });
  });

  it('rejects an internally valid simulation result for a different transaction', async () => {
    const client = makeClient({
      simulateTransaction: vi.fn().mockResolvedValue(successfulProbeResult('other-digest')),
    });
    const result = await probeEndpointCapabilities(client, OPTS_WITH_BUILDER);
    expect(result).toEqual({
      ok: false,
      reason: 'simulateTransaction returned a malformed or mismatched result',
    });
  });

  it('rejects a bound failed simulation instead of treating RPC availability as capability', async () => {
    const client = makeClient({
      simulateTransaction: vi.fn().mockResolvedValue({
        $kind: 'FailedTransaction',
        FailedTransaction: {
          digest: FAKE_PROBE_DIGEST,
          status: {
            success: false,
            error: { $kind: 'Unknown', message: 'probe transaction failed', Unknown: null },
          },
        },
      }),
    });
    const result = await probeEndpointCapabilities(client, OPTS_WITH_BUILDER);
    expect(result).toEqual({
      ok: false,
      reason: 'simulateTransaction failed: probe transaction failed',
    });
  });

  it('rejects a successful terminal that omits the requested effects capability', async () => {
    const client = makeClient({
      simulateTransaction: vi.fn().mockResolvedValue({
        $kind: 'Transaction',
        Transaction: {
          digest: FAKE_PROBE_DIGEST,
          status: { success: true, error: null },
        },
      }),
    });
    const result = await probeEndpointCapabilities(client, OPTS_WITH_BUILDER);
    expect(result).toEqual({
      ok: false,
      reason: 'simulateTransaction returned no requested effects',
    });
  });

  it('stops at probe 1 when getObject throws (does not run later probes)', async () => {
    const simulateSpy = vi.fn().mockResolvedValue({ Transaction: {} });
    const client = makeClient({
      getObject: vi.fn().mockRejectedValue(new Error('endpoint unreachable')),
      simulateTransaction: simulateSpy,
    });
    const result = await probeEndpointCapabilities(client, OPTS_WITH_BUILDER);
    expect(result).toEqual({ ok: false, reason: 'endpoint unreachable' });
    expect(simulateSpy).not.toHaveBeenCalled();
  });

  it('passes simulateProbePoolId through to the probe-tx builder', async () => {
    // The probe must reference the pool ID caller provided, so the built tx
    // exercises the endpoint on an object the settlement swap path registry
    // will immediately need.
    const localBuilder = vi.fn(
      async (_client: SuiGrpcClient, _poolId: string) => FAKE_PROBE_TX_BYTES,
    );
    const client = makeClient({});
    await probeEndpointCapabilities(client, { ...OPTS, buildProbeTxBytes: localBuilder });
    expect(localBuilder).toHaveBeenCalledTimes(1);
    const [calledClient, calledPoolId] = localBuilder.mock.calls[0]!;
    expect(calledClient).toBe(client);
    expect(calledPoolId).toBe(PROBE_POOL_ID);
  });
});
