import { useState, useCallback, useRef } from 'react';
import { StelisSDK, STELIS_CONTRACT_IDS } from '@stelis/sdk';
import { useAppConfig } from '../../../AppConfigContext';

/**
 * useStudioSDK — dynamic studio-endpoint SDK connection hook.
 *
 * Unlike sandbox's useSDK (singleton against RELAY_API_BASE), this hook:
 *   - Accepts a user-provided endpoint URL
 *   - Passes studioEndpoint: true to SDK.connect()
 *   - Re-connects when endpoint changes
 *
 * Reference: StelisSDK.connect() with { studioEndpoint: true }
 */

export interface StudioSDKState {
  sdk: StelisSDK | null;
  error: string | null;
  connecting: boolean;
  endpoint: string;
}

export function useStudioSDK() {
  const { config } = useAppConfig();
  const [state, setState] = useState<StudioSDKState>({
    sdk: null,
    error: null,
    connecting: false,
    endpoint: '',
  });
  const abortRef = useRef(0);

  const connect = useCallback(
    async (rawEndpoint: string) => {
      const id = ++abortRef.current;
      // Normalize: strip trailing slashes — matches StelisClient constructor (client.ts L39)
      const endpoint = rawEndpoint.replace(/\/+$/, '');
      setState((s) => ({ ...s, sdk: null, error: null, connecting: true, endpoint }));

      const pinnedPackageId = config ? STELIS_CONTRACT_IDS[config.network]?.packageId : undefined;

      try {
        const sdk = await StelisSDK.connect(endpoint, {
          studioEndpoint: true,
          pinnedPackageId,
        });
        if (abortRef.current !== id) return; // stale
        setState({ sdk, error: null, connecting: false, endpoint });
      } catch (err) {
        if (abortRef.current !== id) return;
        setState({
          sdk: null,
          error: err instanceof Error ? err.message : 'Connection failed',
          connecting: false,
          endpoint,
        });
      }
    },
    [config],
  );

  const disconnect = useCallback(() => {
    abortRef.current++;
    setState({ sdk: null, error: null, connecting: false, endpoint: '' });
  }, []);

  return { ...state, connect, disconnect };
}
