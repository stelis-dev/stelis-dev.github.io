/**
 * LoginPage — wallet connect + signature authentication.
 *
 * Network is fetched from /relay/config at runtime, matching app-web.
 * dAppKit is created only after the configured public endpoint proves the
 * same live chain identity.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ApiError,
  buildApiUrl,
  issueAdminAuthChallenge,
  verifyAdminAuth,
} from '../api/client';
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
import { truncateAddress } from '../utils';

import type { SuiSignPersonalMessageFeature } from '../types';

type LoginState = 'idle' | 'signing' | 'verifying' | 'error';

// ── Network fetch ─────────────────────────────────────────────────────────

interface VerifiedAdminSuiClient {
  readonly network: SuiNetwork;
  readonly client: SuiGrpcClient;
}

function createVerifiedAdminDAppKit({ network, client }: VerifiedAdminSuiClient) {
  return {
    network,
    instance: createDAppKit({
      networks: [network] as const,
      createClient: (requestedNetwork) => {
        if (requestedNetwork !== network) {
          throw new TypeError('app-admin requested an unverified Sui network');
        }
        return client;
      },
    }),
  };
}

type VerifiedAdminDAppKit = ReturnType<typeof createVerifiedAdminDAppKit>;

/** One load task per explicit attempt; React effect replay joins that task. */
export function createAdminDAppKitLoadOwner<T>(
  load: () => Promise<T>,
): { load(attempt: number): Promise<T> } {
  let activeAttempt: number | null = null;
  let activeTask: Promise<T> | null = null;
  return Object.freeze({
    load(attempt: number) {
      if (!Number.isSafeInteger(attempt) || attempt < 0) {
        throw new TypeError('Admin dAppKit load attempt must be a non-negative safe integer');
      }
      if (activeTask === null || activeAttempt !== attempt) {
        activeAttempt = attempt;
        activeTask = load();
      }
      return activeTask;
    },
  });
}

const adminDAppKitLoadOwner = createAdminDAppKitLoadOwner(async () =>
  createVerifiedAdminDAppKit(await fetchVerifiedAdminSuiClient()),
);

function retryDelayLabel(retryAfterMs: number | undefined): string {
  if (retryAfterMs === undefined || !Number.isFinite(retryAfterMs) || retryAfterMs <= 0) {
    return 'after the current login window expires';
  }
  const minutes = Math.max(1, Math.ceil(retryAfterMs / 60_000));
  return `in ${minutes} minute${minutes === 1 ? '' : 's'}`;
}

export function adminLoginErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'RATE_LIMITED') {
      return `Too many login attempts. Try again ${retryDelayLabel(error.meta.retryAfterMs)}.`;
    }
    if (error.code === 'ADMIN_UNAUTHORIZED') {
      return 'Login was not authorized. Check the connected administrator wallet and try again.';
    }
    if (error.code === 'INTERNAL_ERROR') {
      return 'Admin login is temporarily unavailable. Try again.';
    }
  }
  return error instanceof Error ? error.message : 'Admin login failed';
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
  const [loginAttempt, setLoginAttempt] = useState(0);
  const signingRef = useRef(false);
  const [modalElement, setModalElement] = useState<EventTarget | null>(null);
  const setModalElementRef = useCallback((element: unknown) => {
    setModalElement(element instanceof EventTarget ? element : null);
  }, []);

  useEffect(() => {
    if (modalElement === null) return;
    const handleClose = () => setModalOpen(false);
    modalElement.addEventListener('close', handleClose);
    return () => modalElement.removeEventListener('close', handleClose);
  }, [modalElement]);

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
        setErrorMsg(adminLoginErrorMessage(err));
      }
    })();
  }, [account, loginAttempt, navigate]);

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
          ref={setModalElementRef}
        />

        <button
          id="admin-connect-btn"
          className={`login-btn ${state === 'error' ? 'login-btn-error' : ''}`}
          onClick={() => {
            if (state === 'error') {
              signingRef.current = false;
              setState('idle');
              setErrorMsg('');
              if (account) setLoginAttempt((current) => current + 1);
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
        {state !== 'error' && (
          <p className="login-hint">
            {state === 'signing' && account
              ? `Confirm the login message for ${truncateAddress(account.address)} in your wallet.`
              : state === 'verifying' && account
                ? `Verifying administrator access for ${truncateAddress(account.address)}.`
                : 'Connect the administrator wallet for this Host.'}
          </p>
        )}
      </div>
    </div>
  );
}

// ── Page export ────────────────────────────────────────────────────────────

export function LoginPage() {
  const [verified, setVerified] = useState<VerifiedAdminDAppKit | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    adminDAppKitLoadOwner
      .load(loadAttempt)
      .then((result) => {
        if (active) setVerified(result);
      })
      .catch((loadError) => {
        if (active) {
          setError(loadError instanceof Error ? loadError.message : 'Failed to fetch config');
        }
      });
    return () => {
      active = false;
    };
  }, [loadAttempt]);

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
              setVerified(null);
              setLoadAttempt((current) => current + 1);
            }}
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (!verified) {
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
    <DAppKitProvider dAppKit={verified.instance}>
      <AdminLoginForm network={verified.network} />
    </DAppKitProvider>
  );
}
