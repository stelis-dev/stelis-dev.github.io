import { useState } from 'react';
import { useCurrentAccount, useCurrentClient, useDAppKit } from '@mysten/dapp-kit-react';
import { Transaction } from '@mysten/sui/transactions';
import { StelisApiException } from '@stelis/sdk';
import type { StelisSDK } from '@stelis/sdk';
import type { DebugEntry } from './DebugPanel';
import { useAppConfig } from '../../../AppConfigContext';

/**
 * Minimal MoveCall targets used by the test TX.
 * Promotion prepare rejects any non-MoveCall command (FORBIDDEN_COMMAND, 403).
 *
 * We use a 2-step MoveCall pattern:
 *   1. coin::zero<SUI> — creates a zero-balance coin (returns Coin<SUI>)
 *   2. coin::destroy_zero<SUI> — consumes the zero-balance coin
 *
 * This is required because Coin<T> has `key, store` but NOT `drop`.
 * An unused Coin result triggers UNUSED_VALUE_WITHOUT_DROP at Sui runtime.
 * coin::destroy_zero is the standard way to dispose of zero-balance coins.
 */
const TEST_MOVECALL_ZERO = '0x2::coin::zero';
const TEST_MOVECALL_DESTROY = '0x2::coin::destroy_zero';
const TEST_TYPE_ARG = '0x2::sui::SUI';

interface StudioExecutionPanelProps {
  sdk: StelisSDK | null;
  developerJwt: string;
  /** Promotion ID to execute against. */
  promotionId: string;
  onDebugEntry: (entry: DebugEntry) => void;
}

/**
 * StudioExecutionPanel — promotion-sponsored execution test panel.
 *
 * Architecture:
 *   1. sdk.preparePromotionSponsored() — POST /studio/promotions/:id/prepare
 *   2. Wallet sign
 *   3. sdk.sponsorPromotionSponsored() — POST /studio/promotions/:id/sponsor
 *
 * This uses the promotion-specific endpoints, not the generic Relay API path.
 * No settlement token or settlement swap path is needed — promotion budget covers gas.
 *
 * The TX builds a 2-step MoveCall-only PTB:
 *   1. coin::zero<SUI> — creates zero-balance Coin<SUI>
 *   2. coin::destroy_zero<SUI> — consumes it (Coin has no `drop` ability)
 * Promotion prepare rejects non-MoveCall commands (SplitCoins, TransferObjects, etc.)
 * so only MoveCall commands are allowed in the transaction.
 */
export function StudioExecutionPanel({
  sdk,
  developerJwt,
  promotionId,
  onDebugEntry,
}: StudioExecutionPanelProps) {
  const account = useCurrentAccount();
  const client = useCurrentClient();
  const dAppKit = useDAppKit();

  const [status, setStatus] = useState<
    'idle' | 'preparing' | 'signing' | 'sponsoring' | 'success' | 'error'
  >('idle');
  const [digest, setDigest] = useState('');
  const [errorMsg, setErrorMsg] = useState('');

  const { config } = useAppConfig();
  const network = config!.network;
  const isBusy = status !== 'idle' && status !== 'success' && status !== 'error';

  const canExecute = !!sdk && !!account && !!developerJwt && !!promotionId.trim() && !isBusy;

  /**
   * Build a minimal MoveCall-only test TX.
   *
   * Promotion prepare handler (Step 5) rejects ALL non-MoveCall commands:
   * SplitCoins, MergeCoins, TransferObjects, MakeMoveVec, Publish, Upgrade
   * are all FORBIDDEN_COMMAND (403).
   *
   * We use a 2-step pure-MoveCall pattern:
   *   1. coin::zero<SUI> → creates a zero-balance Coin<SUI>
   *   2. coin::destroy_zero<SUI> → consumes that coin
   *
   * This is required because Coin<T> has `key, store` but NOT `drop`.
   * An unused Coin result would trigger UNUSED_VALUE_WITHOUT_DROP at runtime.
   *
   * Both targets must be in the JWT's allowedTargets. Use the
   * AllowedTargetsBuilder auto-fill to generate correct hashes.
   */
  const buildTestTx = (): { tx: Transaction; moveCallTargets: string[] } => {
    const tx = new Transaction();
    const moveCallTargets: string[] = [];

    // Step 1: coin::zero<SUI> — creates a zero-balance coin
    const [zeroCoin] = tx.moveCall({
      target: TEST_MOVECALL_ZERO,
      typeArguments: [TEST_TYPE_ARG],
    });
    moveCallTargets.push(TEST_MOVECALL_ZERO);

    // Step 2: coin::destroy_zero<SUI> — consumes the coin (no return value)
    tx.moveCall({
      target: TEST_MOVECALL_DESTROY,
      typeArguments: [TEST_TYPE_ARG],
      arguments: [zeroCoin],
    });
    moveCallTargets.push(TEST_MOVECALL_DESTROY);

    return { tx, moveCallTargets };
  };

  const handleExecute = async () => {
    if (!sdk || !account || !developerJwt || !promotionId.trim()) return;
    setStatus('preparing');
    setErrorMsg('');
    setDigest('');

    try {
      // ── Step 1: Build MoveCall-only test TX ───────────────────────
      const { tx, moveCallTargets } = buildTestTx();

      onDebugEntry({
        label: 'TX Build',
        response: {
          moveCallTargets,
          note: 'Promotion path: MoveCall-only TX. No settlement token or settlement swap path needed — budget covers gas.',
        },
        timestamp: Date.now(),
      });

      // ── Step 2: sdk.preparePromotionSponsored() ──────────────────
      onDebugEntry({
        label: 'Prepare Request',
        request: {
          promotionId,
          senderAddress: account.address,
          developerJwt: '(Bearer header)',
        },
        timestamp: Date.now(),
      });

      const prepared = await sdk.preparePromotionSponsored(tx, {
        client,
        promotionId,
        addr: account.address,
        developerJwt,
      });

      onDebugEntry({
        label: 'Prepare Response',
        response: {
          receiptId: prepared.receiptId,
          estimatedGasMist: prepared.estimatedGasMist,
        },
        timestamp: Date.now(),
      });

      // ── Step 3: User sign ───────────────────────────────────────────
      setStatus('signing');
      const { signature: userSignature } = await dAppKit.signTransaction({
        transaction: prepared.txBytes,
      });

      onDebugEntry({
        label: 'User Signed',
        response: { signaturePrefix: userSignature.slice(0, 20) + '...' },
        timestamp: Date.now(),
      });

      // ── Step 4: sdk.sponsorPromotionSponsored() ─────────────────
      setStatus('sponsoring');

      onDebugEntry({
        label: 'Sponsor Request',
        request: { receiptId: prepared.receiptId, txBytesLength: prepared.txBytes.length },
        timestamp: Date.now(),
      });

      const sponsored = await sdk.sponsorPromotionSponsored({
        promotionId,
        receiptId: prepared.receiptId,
        txBytes: prepared.txBytes,
        userSignature,
        developerJwt,
      });

      setStatus('success');
      setDigest(sponsored.digest);

      onDebugEntry({
        label: 'Sponsor Response',
        response: {
          digest: sponsored.digest,
          actualGasMist: sponsored.actualGasMist,
        },
        timestamp: Date.now(),
      });
    } catch (err) {
      setStatus('error');
      const msg = err instanceof Error ? err.message : 'Execution failed';
      setErrorMsg(msg);

      if (err instanceof StelisApiException) {
        onDebugEntry({
          label: 'API Error',
          error: msg,
          response: {
            code: err.code,
            status: err.status,
            ...(err.meta && Object.keys(err.meta).length > 0 ? { meta: err.meta } : {}),
          },
          timestamp: Date.now(),
        });
      } else {
        onDebugEntry({
          label: 'Execution Error',
          error: msg,
          timestamp: Date.now(),
        });
      }
    }
  };

  return (
    <div className="promo-panel">
      <h3 className="promo-panel-title">🚀 Promotion Sponsored Execution</h3>
      <p className="promo-panel-desc">
        Execute a promotion-sponsored transaction. Uses <code>sdk.preparePromotionSponsored()</code>{' '}
        and <code>sdk.sponsorPromotionSponsored()</code>. No settlement token or settlement swap
        path needed — promotion budget covers gas. Builds a MoveCall-only TX (
        <code>coin::zero&lt;SUI&gt;</code>).
      </p>

      {!account && <div className="promo-warning">⚠️ Connect your wallet first.</div>}
      {!developerJwt && <div className="promo-warning">⚠️ Provide a developer JWT above.</div>}
      {!sdk && <div className="promo-warning">⚠️ Connect to a studio endpoint first.</div>}
      {!promotionId.trim() && <div className="promo-warning">⚠️ Enter a Promotion ID above.</div>}

      <button
        onClick={handleExecute}
        disabled={!canExecute}
        className="promo-btn promo-btn-primary"
        style={{ marginTop: 8 }}
      >
        {isBusy
          ? status === 'preparing'
            ? '⏳ Preparing...'
            : status === 'signing'
              ? '⏳ Signing...'
              : '⏳ Sponsoring...'
          : '🚀 Execute Promotion Sponsored'}
      </button>

      {status === 'success' && digest && (
        <div className="promo-status promo-status-ok">
          ✅ Success!{' '}
          <a
            href={`https://suiscan.xyz/${network}/tx/${digest}`}
            target="_blank"
            rel="noreferrer"
            style={{ color: 'var(--accent-blue)' }}
          >
            View on Suiscan ↗
          </a>
        </div>
      )}

      {errorMsg && <div className="promo-status promo-status-error">❌ {errorMsg}</div>}
    </div>
  );
}
