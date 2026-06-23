/**
 * WalletProvider — wraps @mysten/dapp-kit-react for the app.
 *
 * Network is resolved from AppConfigContext (API fetch).
 * createDAppKit() is called lazily once per network after network is available.
 */
import { createDAppKit, DAppKitProvider } from '@mysten/dapp-kit-react';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { createAgentQSuiBrowserProvider } from '@stelis/agent-q-provider-sui/browser';
import { createAgentQSuiWalletInitializer } from '@stelis/agent-q-provider-sui/wallet-standard';
import { type ReactNode, useMemo } from 'react';
import { useAppConfig, type AppWebNetwork } from '../../../AppConfigContext';
import { getSuiRpcUrl } from '../../../suiRpc';

const agentQProvider = createAgentQSuiBrowserProvider({ clientName: 'Stelis app-web' });
const dAppKitByNetwork = new Map<AppWebNetwork, ReturnType<typeof createAppWebDAppKit>>();

function createAppWebDAppKit(network: AppWebNetwork) {
  return createDAppKit({
    networks: [network] as const,
    createClient: (n) =>
      new SuiGrpcClient({
        network: n,
        baseUrl: getSuiRpcUrl(n),
      }),
    walletInitializers: [
      createAgentQSuiWalletInitializer({
        provider: agentQProvider,
        purpose: 'stelis-app-web',
      }),
    ],
  });
}

function buildDAppKit(network: AppWebNetwork) {
  const cached = dAppKitByNetwork.get(network);
  if (cached) {
    return cached;
  }
  const dAppKit = createAppWebDAppKit(network);
  dAppKitByNetwork.set(network, dAppKit);
  return dAppKit;
}

// Register types for hook type inference
declare module '@mysten/dapp-kit-react' {
  interface Register {
    dAppKit: ReturnType<typeof buildDAppKit>;
  }
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const { config } = useAppConfig();

  // config is guaranteed non-null here because App.tsx gates rendering.
  const dAppKit = useMemo(() => buildDAppKit(config!.network), [config]);

  return <DAppKitProvider dAppKit={dAppKit}>{children}</DAppKitProvider>;
}
