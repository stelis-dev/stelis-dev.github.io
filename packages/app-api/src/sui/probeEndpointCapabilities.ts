/**
 * Boot-time endpoint capability probes.
 *
 * Verifies that each RPC endpoint can serve the APIs Stelis depends on:
 *   1. getObject — read Stelis Config object
 *   2. getCoinMetadata — DEEP metadata (required by settlement swap path derivation)
 *   3. simulateTransaction — required by settlement swap path whitelisted() queries
 *      AND runtime dry-run in handlePrepare/handleSponsor
 *
 * Endpoints exposing only read-indexer APIs without transaction simulation
 * (e.g. "rest index store is disabled") are rejected at probe 3, preventing
 * them from becoming the failover primary and blocking settlement swap path registry init.
 */
import type { SuiGrpcClient } from '@mysten/sui/grpc';
import { Transaction } from '@mysten/sui/transactions';
import { bindCurrentSuiResultToBytes, SUI_ZERO_ADDRESS } from '@stelis/core-relay';

export type EndpointProbeResult = { ok: true; reason: null } | { ok: false; reason: string };

/**
 * Build a zero-sender trivial transaction referencing the simulate-probe pool.
 * Exported separately so probe 3 can be unit-tested with fake probe-tx bytes
 * (tx.build() requires a full SuiGrpcClient for shared-object resolution,
 * which is impractical to mock in unit tests).
 */
export async function buildProbeTxBytes(
  client: SuiGrpcClient,
  simulateProbePoolId: string,
): Promise<Uint8Array> {
  const probeTx = new Transaction();
  probeTx.setSender(SUI_ZERO_ADDRESS);
  probeTx.object(simulateProbePoolId);
  return probeTx.build({ client });
}

/**
 * Run the three-step capability probe against a single endpoint client.
 *
 * @param client — SuiGrpcClient bound to the endpoint under probe
 * @param opts.stelisConfigId — Stelis `Config` object ID (probe 1)
 * @param opts.deepCoinType — DEEP coin type (probe 2)
 * @param opts.simulateProbePoolId — DeepBook pool ID to reference in the
 *   simulate probe (probe 3); should be a pool the settlement swap path registry will need
 * @param opts.buildProbeTxBytes — optional override for the probe tx builder
 *   (injection point for unit tests; default uses the real Transaction.build)
 */
export async function probeEndpointCapabilities(
  client: SuiGrpcClient,
  opts: {
    stelisConfigId: string;
    deepCoinType: string;
    simulateProbePoolId: string;
    buildProbeTxBytes?: (client: SuiGrpcClient, poolId: string) => Promise<Uint8Array>;
  },
): Promise<EndpointProbeResult> {
  try {
    // Probe 1: Stelis Config object
    const configObj = await client.getObject({ objectId: opts.stelisConfigId, include: {} });
    if (!configObj.object) return { ok: false, reason: 'Stelis Config not found' };

    // Probe 2: DEEP CoinMetadata
    const coinMeta = await client.getCoinMetadata({ coinType: opts.deepCoinType });
    if (!coinMeta.coinMetadata) return { ok: false, reason: 'DEEP CoinMetadata not indexed' };

    // Probe 3: simulateTransaction capability.
    // Zero-sender trivial tx referencing the simulate-probe pool, enough to
    // exercise the simulate subsystem on an object the settlement swap path
    // registry will immediately need.
    const buildFn = opts.buildProbeTxBytes ?? buildProbeTxBytes;
    const probeTxBytes = await buildFn(client, opts.simulateProbePoolId);
    const simulation = await client.simulateTransaction({
      transaction: probeTxBytes,
      include: { effects: true },
    });
    const bound = bindCurrentSuiResultToBytes(simulation, probeTxBytes);
    if (!bound) throw new Error('simulateTransaction returned a malformed or mismatched result');
    if (bound.outcome === 'failure') {
      throw new Error(`simulateTransaction failed: ${bound.errorMessage}`);
    }
    if (bound.transaction.effects === undefined) {
      throw new Error('simulateTransaction returned no requested effects');
    }

    return { ok: true, reason: null };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
