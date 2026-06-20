import { useState, useEffect } from 'react';
import { StelisSDK, STELIS_CONTRACT_IDS } from '@stelis/sdk';
import { RELAY_API_BASE } from '../../../relayApiEndpoint';
import { useAppConfig, type AppWebNetwork } from '../../../AppConfigContext';

/**
 * useSDK — singleton SDK connection hook.
 *
 * Restores the original dedup/singleton pattern: one StelisSDK.connect()
 * per network, shared across all callers (ConnectCredit, SwapForm,
 * TransferForm, useSettlementSwapPathStatus).
 *
 * pinnedPackageId is resolved from the API-fetched network.
 */

/** Module-level singleton cache keyed by network. */
const sdkCache = new Map<string, Promise<StelisSDK>>();

function getSDKPromise(network: AppWebNetwork): Promise<StelisSDK> {
  const existing = sdkCache.get(network);
  if (existing) return existing;

  const pinnedPackageId = STELIS_CONTRACT_IDS[network]?.packageId;
  const promise = StelisSDK.connect(RELAY_API_BASE, { pinnedPackageId }).catch((err) => {
    sdkCache.delete(network); // allow retry on failure
    throw err;
  });

  sdkCache.set(network, promise);
  return promise;
}

export function useSDK(): { sdk: StelisSDK | null; error: string | null } {
  const { config } = useAppConfig();
  const [sdk, setSDK] = useState<StelisSDK | null>(null);
  const [error, setError] = useState<string | null>(null);

  const network = config?.network ?? null;

  useEffect(() => {
    if (!network) return;

    let cancelled = false;

    getSDKPromise(network)
      .then((s) => {
        if (!cancelled) {
          setSDK(s);
          setError(null);
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'SDK connection failed');
      });

    return () => {
      cancelled = true;
    };
  }, [network]);

  return { sdk, error };
}
