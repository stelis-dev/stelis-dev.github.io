/**
 * LoginPage — wallet connect + signature authentication.
 *
 * Network is fetched from /relay/config at runtime, matching app-web.
 * dAppKit is created only after the configured public endpoint proves the
 * same live chain identity.
 */
import { useEffect, useRef, useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { buildApiUrl, issueAdminAuthChallenge, verifyAdminAuth } from '../api/client';
import {
  createDAppKit,
  DAppKitProvider,
  useCurrentAccount,
  ConnectModal,
} from '@mysten/dapp-kit-react';
import type { SuiGrpcClient } from '@mysten/sui/grpc';
import { parseRelayConfigResponse, type SuiNetwork } from '@stelis/contracts';
import { getWallets } from '@mysten/wallet-standard';
import { createVerifiedAdminSuiClient } from '../suiRpc';

import type { SuiSignPersonalMessageFeature } from '../types';

type LoginState = 'idle' | 'signing' | 'verifying' | 'error';

// ── Network fetch ─────────────────────────────────────────────────────────

interface VerifiedAdminSuiClient {
  readonly network: SuiNetwork;
  readonly client: SuiGrpcClient;
}

/** Fetch the exact Host config, then prove the app-admin Sui client against it. */
async function fetchVerifiedAdminSuiClient(): Promise<VerifiedAdminSuiClient> {
  const res = await fetch(buildApiUrl('/relay/config'), {
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`/relay/config returned ${res.status}`);
  const config = parseRelayConfigResponse(await res.json());
  const client = await createVerifiedAdminSuiClient(config.network);
  return { network: config.network, client };
}

// ── Login form ─────────────────────────────────────────────────────────────

function AdminLoginForm({ network }: { network: SuiNetwork }) {
  const navigate = useNavigate();
  const account = useCurrentAccount();
  const [modalOpen, setModalOpen] = useState(false);
  const [state, setState] = useState<LoginState>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const signingRef = useRef(false);

  // Auto-sign when wallet connects
  useEffect(() => {
    if (!account) return;
    if (signingRef.current) return;
    signingRef.current = true;

    setModalOpen(false);
    setState('signing');
    setErrorMsg('');

    (async () => {
      try {
        const { nonce } = await issueAdminAuthChallenge();

        const wallets = getWallets().get();
        const suiWallet = wallets.find(
          (w) =>
            'sui:signPersonalMessage' in w.features &&
            w.accounts.some((a) => a.address === account.address),
        );
        if (!suiWallet) throw new Error('Could not find a connected wallet that supports signing');

        const signFeature = suiWallet.features[
          'sui:signPersonalMessage'
        ] as SuiSignPersonalMessageFeature;
        const suiAccount = suiWallet.accounts.find((a) => a.address === account.address)!;

        const { signature } = await signFeature.signPersonalMessage({
          message: new TextEncoder().encode(nonce),
          account: suiAccount,
        });

        setState('verifying');
        await verifyAdminAuth({ nonce, signature, address: account.address });

        navigate('/dashboard', { replace: true });
      } catch (err) {
        signingRef.current = false;
        setState('error');
        setErrorMsg(err instanceof Error ? err.message : 'Unknown error');
      }
    })();
  }, [account, navigate]);

  const isBusy = state === 'signing' || state === 'verifying';
  const statusLabel =
    state === 'signing'
      ? 'Signing…'
      : state === 'verifying'
        ? 'Verifying…'
        : state === 'error'
          ? 'Try again'
          : 'Connect Wallet';

  return (
    <div className="login-page">
      <div className="login-card">
        <h1 className="login-title">Stelis Admin</h1>
        <p className="login-subtitle">Sign with your admin wallet to continue</p>
        <p style={{ fontSize: 11, color: '#64748b', margin: '-4px 0 12px', textAlign: 'center' }}>
          Network:{' '}
          <span style={{ color: network === 'mainnet' ? '#22c55e' : '#f59e0b', fontWeight: 600 }}>
            {network}
          </span>
        </p>

        <ConnectModal
          open={modalOpen}
          ref={(el: unknown) => {
            const node = el as EventTarget | null;
            if (!node) return;
            node.addEventListener('close', () => setModalOpen(false), { once: false });
          }}
        />

        <button
          id="admin-connect-btn"
          className={`login-btn ${state === 'error' ? 'login-btn-error' : ''}`}
          onClick={() => {
            if (state === 'error') {
              signingRef.current = false;
              setState('idle');
              setErrorMsg('');
            }
            if (!account) setModalOpen(true);
          }}
          disabled={isBusy}
        >
          {isBusy && <span className="login-spinner" />}
          {statusLabel}
        </button>

        {state === 'error' && errorMsg && (
          <p className="login-error" role="alert">
            {errorMsg}
          </p>
        )}
        <p className="login-hint">
          Only the configured <code>ADMIN_ADDRESS</code> can log in.
        </p>
      </div>
    </div>
  );
}

// ── Page export ────────────────────────────────────────────────────────────

export function LoginPage() {
  const [verified, setVerified] = useState<VerifiedAdminSuiClient | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchVerifiedAdminSuiClient()
      .then(setVerified)
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to fetch config'));
  }, []);

  const dAppKit = useMemo(() => {
    if (!verified) return null;
    return createDAppKit({
      networks: [verified.network] as const,
      createClient: (network) => {
        if (network !== verified.network) {
          throw new TypeError('app-admin requested an unverified Sui network');
        }
        return verified.client;
      },
    });
  }, [verified]);

  if (error) {
    return (
      <div className="login-page">
        <div className="login-card">
          <h1 className="login-title">Stelis Admin</h1>
          <p style={{ color: '#f87171', fontSize: 13, textAlign: 'center' }}>{error}</p>
          <button
            className="login-btn"
            onClick={() => {
              setError(null);
              fetchVerifiedAdminSuiClient()
                .then(setVerified)
                .catch((e) => setError(e instanceof Error ? e.message : 'Failed'));
            }}
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (!dAppKit || !verified) {
    return (
      <div className="login-page">
        <div className="login-card">
          <h1 className="login-title">Stelis Admin</h1>
          <p className="login-subtitle" style={{ opacity: 0.6 }}>
            Loading configuration…
          </p>
        </div>
      </div>
    );
  }

  return (
    <DAppKitProvider dAppKit={dAppKit}>
      <AdminLoginForm network={verified.network} />
    </DAppKitProvider>
  );
}
