import { useState } from 'react';
import { useCurrentAccount, useCurrentClient, useDAppKit } from '@mysten/dapp-kit-react';
import { Transaction } from '@mysten/sui/transactions';
import { StelisApiException } from '@stelis/sdk';
import type { StelisSDK } from '@stelis/sdk';
import type { DebugEntry } from './DebugPanel';
import { useAppConfig } from '../../../AppConfigContext';

/**
 * Minimal MoveCall targets used by the test TX.
 * Promotion prepare requires 1 to 16 MoveCall commands and rejects every
 * non-MoveCall command.
 *
 * We use a 2-step MoveCall pattern:
 *   1. coin::zero<SUI> — creates a zero-balance coin (returns Coin<SUI>)
 *   2. coin::destroy_zero<SUI> — consumes the zero-balance coin
 *
 * This is required because Coin<T> has `key, store` but NOT `drop`.
 * An unused Coin result triggers UNUSED_VALUE_WITHOUT_DROP at Sui runtime.
 * coin::destroy_zero is the standard way to dispose of zero-balance coins.
 */
export const STUDIO_TEST_MOVECALL_TARGETS = ['0x2::coin::zero', '0x2::coin::destroy_zero'] as const;
export const STUDIO_TEST_ALLOWED_TARGETS_CONFIG = STUDIO_TEST_MOVECALL_TARGETS.join(',');
const TEST_TYPE_ARG = '0x2::sui::SUI';

/** Build the exact transaction exercised by the Studio test page. */
export function buildStudioTestTransaction(): {
  tx: Transaction;
  moveCallTargets: readonly string[];
} {
  const tx = new Transaction();

  const [zeroCoin] = tx.moveCall({
    target: STUDIO_TEST_MOVECALL_TARGETS[0],
    typeArguments: [TEST_TYPE_ARG],
  });
  tx.moveCall({
    target: STUDIO_TEST_MOVECALL_TARGETS[1],
    typeArguments: [TEST_TYPE_ARG],
    arguments: [zeroCoin],
  });

  return { tx, moveCallTargets: STUDIO_TEST_MOVECALL_TARGETS };
}

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
 * Promotion prepare accepts 1 to 16 commands, all of them MoveCall.
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
   * Promotion prepare accepts 1 to 16 commands and rejects ALL non-MoveCall commands:
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
   * Both raw targets must be present in the Host's STUDIO_ALLOWED_TARGETS
   * boot configuration. The page and developer JWT do not modify that policy.
   */
  const handleExecute = async () => {
    if (!sdk || !account || !developerJwt || !promotionId.trim()) return;
    setStatus('preparing');
    setErrorMsg('');
    setDigest('');

    try {
      // ── Step 1: Build MoveCall-only test TX ───────────────────────
      const { tx, moveCallTargets } = buildStudioTestTransaction();

      onDebugEntry({
        label: 'TX Build',
        response: {
          moveCallTargets,
          note: 'Promotion path: 2-command MoveCall-only TX (allowed range: 1 to 16). No settlement token or settlement swap path needed — budget covers gas.',
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
        path needed — promotion budget covers gas. Builds a 2-command MoveCall-only TX within the
        allowed 1-to-16 range (<code>coin::zero&lt;SUI&gt;</code>).
      </p>

      {!account && <div className="promo-warning">⚠️ Connect your wallet first.</div>}
      {!developerJwt && <div className="promo-warning">⚠️ Provide a developer JWT above.</div>}
      {!sdk && <div className="promo-warning">⚠️ Connect to a studio endpoint first.</div>}
      {!promotionId.trim() && <div className="promo-warning">⚠️ Enter a Promotion ID above.</div>}
      <div className="promo-warning">
        Host prerequisite: include <code>{STUDIO_TEST_ALLOWED_TARGETS_CONFIG}</code> in{' '}
        <code>STUDIO_ALLOWED_TARGETS</code> before booting or restarting the Host. This page and the
        developer JWT cannot change the Host target policy.
      </div>

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
