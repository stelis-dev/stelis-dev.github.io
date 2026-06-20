import { useCurrentAccount, useCurrentClient, useDAppKit } from '@mysten/dapp-kit-react';
import { Transaction } from '@mysten/sui/transactions';
import type { CreditResult } from '@stelis/sdk';
import { useCallback, useEffect, useState } from 'react';
import { useSettlementSwapPathStatus } from '../hooks/useSettlementSwapPathStatus';
import { useSDK } from '../hooks/useSDK';
import { queryUserCredit } from '@stelis/sdk';
import { getSelectedSettlementSwapPath, SUI_DECIMALS } from '../constants';
import { WalletButton } from './WalletButton';
import { SANDBOX_CARD_STYLE } from './cardStyles';
import { formatSmallestUnitDecimal, parseDecimalIntegerToBigInt } from '../amount';

interface ConnectCreditProps {
  refreshKey?: number;
  onTxSuccess?: () => void;
  settlementSwapPathIndex?: number;
}

export function ConnectCredit({
  refreshKey = 0,
  onTxSuccess,
  settlementSwapPathIndex = 0,
}: ConnectCreditProps) {
  const account = useCurrentAccount();
  const client = useCurrentClient();
  const settlementSwapPathStatus = useSettlementSwapPathStatus(settlementSwapPathIndex);
  const { sdk, error: sdkError } = useSDK();
  const dAppKit = useDAppKit();
  const selectedSettlementSwapPath = sdk
    ? getSelectedSettlementSwapPath(sdk, settlementSwapPathIndex)
    : null;
  const settlementTokenType = selectedSettlementSwapPath?.settlementTokenType ?? '';
  const settlementTokenDecimals = selectedSettlementSwapPath?.settlementTokenDecimals ?? 6;
  const settlementTokenSymbol =
    selectedSettlementSwapPath?.settlementTokenSymbol ?? 'Settlement Token';
  const [creditRes, setCreditRes] = useState<CreditResult | null>(null);
  const [creditError, setCreditError] = useState<string | null>(null);
  const [withdrawing, setWithdrawing] = useState(false);
  const [suiBalance, setSuiBalance] = useState<string | null>(null);
  const [settlementTokenBalance, setSettlementTokenBalance] = useState<string | null>(null);

  useEffect(() => {
    if (!account || !client || !settlementTokenType) return;
    let cancelled = false;
    (async () => {
      // ── SUI balance ──────────────────────────────────────────────
      try {
        const bal = await client.getBalance({ owner: account.address });
        if (!cancelled) setSuiBalance(bal.balance.balance);
      } catch {
        // SUI balance fetch failed — non-critical for sandbox display
      }

      // ── Settlement token balance (coin objects + address balance) ─
      try {
        const bal = await client.getBalance({
          owner: account.address,
          coinType: settlementTokenType,
        });
        if (!cancelled) setSettlementTokenBalance(bal.balance.balance);
      } catch {
        // Settlement token balance fetch failed — non-critical for sandbox display
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [account, client, refreshKey, settlementTokenType]);

  const fetchCredit = useCallback(async () => {
    if (!account || !client || !sdk) return;
    try {
      const res = await queryUserCredit(client, sdk.config.vaultRegistryId, account.address);
      setCreditRes(res);
      setCreditError(null);
    } catch (err) {
      setCreditError(err instanceof Error ? err.message : 'Failed to fetch vault credit');
    }
  }, [account, client, sdk]);

  useEffect(() => {
    fetchCredit();
  }, [fetchCredit, refreshKey]);

  const vaultCreditMist = creditRes?.credit
    ? parseDecimalIntegerToBigInt(creditRes.credit, 'vault credit')
    : 0n;
  const showWithdrawBtn = !!(creditRes?.vaultObjectId && vaultCreditMist > 0n && sdk);
  const canWithdraw = showWithdrawBtn && !withdrawing;

  const handleWithdraw = async () => {
    if (!sdk || !creditRes?.vaultObjectId || !account) return;
    setWithdrawing(true);
    setCreditError(null);
    try {
      const tx = new Transaction();
      sdk.buildWithdrawPtb(tx, {
        vaultId: creditRes.vaultObjectId,
        recipientAddress: account.address,
      });
      tx.setSender(account.address);
      const txBytes = await tx.build({ client });
      const b64 = btoa(String.fromCharCode(...txBytes));
      const { signature } = await dAppKit.signTransaction({ transaction: b64 });
      const result = await client.executeTransaction({
        transaction: txBytes,
        signatures: [signature],
      });
      const digest = result.Transaction?.digest;
      if (!digest) {
        throw new Error('Withdraw execution returned an empty digest');
      }
      await client.waitForTransaction({ digest });
      await fetchCredit();
      onTxSuccess?.();
    } catch (err) {
      setCreditError(err instanceof Error ? err.message : 'Withdraw failed');
    } finally {
      setWithdrawing(false);
    }
  };

  return (
    <div style={SANDBOX_CARD_STYLE}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 16,
        }}
      >
        <h2 style={{ margin: 0, fontSize: 16 }}>💳 Wallet &amp; Credit</h2>
        <WalletButton />
      </div>

      {/* Settlement Swap Path Status */}
      <div style={{ fontSize: 13, color: 'var(--text-secondary, #aaa)', marginBottom: 8 }}>
        {sdkError && (
          <div style={{ color: '#f44336', marginBottom: 6 }}>SDK: {sdkError}</div>
        )}
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
          <span>{settlementTokenSymbol}/SUI Rate:</span>
          <strong style={{ color: settlementSwapPathStatus.hasLiquidity ? '#4caf50' : '#f44336' }}>
            {settlementSwapPathStatus.loading ? '...' : settlementSwapPathStatus.rateDisplay}
          </strong>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span>Settlement Path Liquidity:</span>
          <strong style={{ color: settlementSwapPathStatus.hasLiquidity ? '#4caf50' : '#f44336' }}>
            {settlementSwapPathStatus.loading
              ? '...'
              : settlementSwapPathStatus.hasLiquidity
                ? '✅ Active'
                : '❌ No orders'}
          </strong>
        </div>
      </div>

      {account && (
        <div style={{ fontSize: 13, marginTop: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
            <span>SUI:</span>
            <strong>
              {suiBalance
                ? formatSmallestUnitDecimal(
                    parseDecimalIntegerToBigInt(suiBalance, 'SUI balance'),
                    SUI_DECIMALS,
                    4,
                  )
                : '...'}
            </strong>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
            <span>{settlementTokenSymbol}:</span>
            <strong>
              {settlementTokenBalance
                ? formatSmallestUnitDecimal(
                    parseDecimalIntegerToBigInt(
                      settlementTokenBalance,
                      `${settlementTokenSymbol} balance`,
                    ),
                    settlementTokenDecimals,
                    Math.min(2, settlementTokenDecimals),
                  )
                : '0.00'}
            </strong>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
            <span>Vault Credit:</span>
            <strong>
              {creditError
                ? `⚠️ ${creditError}`
                : creditRes?.needsCreate
                  ? '(no vault — auto-created on first swap)'
                  : creditRes
                    ? `${formatSmallestUnitDecimal(vaultCreditMist, SUI_DECIMALS, 4)} SUI`
                    : '...'}
            </strong>
          </div>
          {canWithdraw && (
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 4 }}>
              <button
                onClick={handleWithdraw}
                disabled={withdrawing}
                style={{
                  padding: '3px 12px',
                  borderRadius: 5,
                  border: '1px solid var(--border, #444)',
                  background: 'transparent',
                  color: 'inherit',
                  cursor: 'pointer',
                  fontSize: 11,
                }}
              >
                {withdrawing ? '...' : '💰 Withdraw'}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
