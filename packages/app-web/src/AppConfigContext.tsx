/**
 * AppConfigContext — fetches runtime config from the API at startup.
 *
 * Resolves `network` from GET /relay/config. No build-time env dependency.
 * All components that need `network` must use `useAppConfig()`.
 *
 * Reference: GET /relay/config response shape — see app-api relay.ts config route.
 */
import { createContext, useContext, useState, useEffect, useMemo, type ReactNode } from 'react';
import { RELAY_API_BASE } from './relayApiEndpoint';

export type AppWebNetwork = 'testnet' | 'mainnet';

interface AppConfig {
  network: AppWebNetwork;
}

interface AppConfigContextValue {
  config: AppConfig | null;
  loading: boolean;
  error: string | null;
}

const AppConfigContext = createContext<AppConfigContextValue>({
  config: null,
  loading: true,
  error: null,
});

const VALID_NETWORKS: readonly string[] = ['testnet', 'mainnet'];

function isValidNetwork(value: unknown): value is AppWebNetwork {
  return typeof value === 'string' && VALID_NETWORKS.includes(value);
}

export function AppConfigProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AppConfigContextValue>({
    config: null,
    loading: true,
    error: null,
  });

  useEffect(() => {
    let cancelled = false;

    fetch(`${RELAY_API_BASE}/config`, { signal: AbortSignal.timeout(10_000) })
      .then((res) => {
        if (!res.ok) throw new Error(`/relay/config returned ${res.status}`);
        return res.json();
      })
      .then((data: { network?: string }) => {
        if (cancelled) return;
        if (!isValidNetwork(data.network)) {
          throw new Error(
            `API returned invalid network: "${data.network}". Expected: testnet | mainnet.`,
          );
        }
        setState({ config: { network: data.network }, loading: false, error: null });
      })
      .catch((err) => {
        if (cancelled) return;
        setState({
          config: null,
          loading: false,
          error: err instanceof Error ? err.message : 'Failed to load config from API',
        });
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const value = useMemo(() => state, [state]);

  return <AppConfigContext.Provider value={value}>{children}</AppConfigContext.Provider>;
}

/**
 * Access the runtime app config.
 * Must be used inside <AppConfigProvider>.
 *
 * `config` is null while loading or on error.
 * Components that require `config.network` should only render
 * after confirming `config !== null` (enforced by App.tsx gate).
 */
export function useAppConfig(): AppConfigContextValue {
  return useContext(AppConfigContext);
}
