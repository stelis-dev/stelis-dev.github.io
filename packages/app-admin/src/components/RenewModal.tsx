/**
 * RenewModal — session renewal modal with wallet signing.
 */
import { useEffect, useRef, useState, useCallback } from 'react';
import { getWallets } from '@mysten/wallet-standard';
import type { SuiSignPersonalMessageFeature } from '../types';
import { issueAdminAuthChallenge, renewAdminSession } from '../api/client';

type RenewState = 'idle' | 'signing' | 'verifying' | 'error';

interface RenewModalProps {
  expAt: number;
  address: string;
  onSuccess: () => void;
  onDismiss: () => void;
  onRenewStart: () => void;
  onRenewEnd: () => void;
}

function formatCountdown(seconds: number): string {
  if (seconds <= 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function RenewModal({
  expAt,
  address,
  onSuccess,
  onDismiss,
  onRenewStart,
  onRenewEnd,
}: RenewModalProps) {
  const [state, setState] = useState<RenewState>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const [countdown, setCountdown] = useState('');
  const signingRef = useRef(false);
  const modalRef = useRef<HTMLDivElement>(null);

  // Countdown timer
  useEffect(() => {
    const tick = () => {
      const left = expAt - Math.floor(Date.now() / 1000);
      setCountdown(formatCountdown(Math.max(0, left)));
    };
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [expAt]);

  // Body scroll lock
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  // Focus trap
  useEffect(() => {
    modalRef.current?.focus();
  }, []);

  // Esc key
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onDismiss();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onDismiss]);

  const handleRenew = useCallback(async () => {
    if (signingRef.current) return;
    signingRef.current = true;
    setState('signing');
    setErrorMsg('');
    onRenewStart();

    try {
      const walletApi = getWallets();
      let suiWallet = walletApi
        .get()
        .find(
          (w) =>
            'sui:signPersonalMessage' in w.features &&
            w.accounts.some((a) => a.address === address),
        );

      // Reconnect attempt
      if (!suiWallet) {
        for (const w of walletApi.get()) {
          if (!('standard:connect' in w.features) || !('sui:signPersonalMessage' in w.features))
            continue;
          try {
            const connectFeature = w.features['standard:connect'] as {
              connect(): Promise<{ accounts: ReadonlyArray<{ address: string }> }>;
            };
            const result = await connectFeature.connect();
            if (result.accounts.some((a) => a.address === address)) {
              suiWallet = w;
              break;
            }
          } catch {
            /* wallet refused reconnect */
          }
        }
      }

      if (!suiWallet) throw new Error('Wallet not connected. Please go to login page.');

      const signFeature = suiWallet.features[
        'sui:signPersonalMessage'
      ] as SuiSignPersonalMessageFeature;
      const suiAccount = suiWallet.accounts.find((a) => a.address === address);
      if (!suiAccount) throw new Error('Admin account not found in connected wallet.');

      const { nonce } = await issueAdminAuthChallenge();

      // Sign
      const { signature } = await signFeature.signPersonalMessage({
        message: new TextEncoder().encode(nonce),
        account: suiAccount,
      });

      // Renew
      setState('verifying');
      await renewAdminSession({ nonce, signature, address });

      onSuccess();
    } catch (err) {
      setState('error');
      setErrorMsg(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      signingRef.current = false;
      onRenewEnd();
    }
  }, [address, onSuccess, onRenewStart, onRenewEnd]);

  const isBusy = state === 'signing' || state === 'verifying';
  const btnLabel =
    state === 'signing'
      ? 'Signing…'
      : state === 'verifying'
        ? 'Verifying…'
        : state === 'error'
          ? 'Try Again'
          : 'Extend Session';

  return (
    <div className="renew-overlay" onClick={(e) => e.stopPropagation()}>
      <div
        className="renew-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Session expiring"
        ref={modalRef}
        tabIndex={-1}
      >
        <div className="renew-countdown">{countdown}</div>
        <p className="renew-status">
          Your session is about to expire.
          <br />
          Sign to extend your session.
        </p>
        <button
          id="renew-extend-btn"
          className={`renew-btn ${state === 'error' ? 'renew-btn-error' : ''}`}
          onClick={() => void handleRenew()}
          disabled={isBusy}
        >
          {isBusy && <span className="login-spinner" />}
          {btnLabel}
        </button>
        {state === 'error' && errorMsg && (
          <p className="renew-error" role="alert">
            {errorMsg}
          </p>
        )}
      </div>
    </div>
  );
}
