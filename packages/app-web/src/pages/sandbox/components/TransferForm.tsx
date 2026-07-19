import { useState, useEffect } from 'react';
import { useCurrentAccount, useCurrentClient, useDAppKit } from '@mysten/dapp-kit-react';
import { Transaction } from '@mysten/sui/transactions';
import { useSDK } from '../hooks/useSDK';
import { TransactionStatus } from './TransactionStatus';
import type { SettlementSwapPathLiquidityStatus } from '@stelis/sdk';
import { getSelectedSettlementSwapPath } from '../constants';
import { SANDBOX_CARD_STYLE } from './cardStyles';
import { parseDecimalToSmallestUnit, parsePercentToBps } from '../amount';
import { createSuiEndpointSnapshot, readBoundedSuiCoins } from '@stelis/core-relay/browser';
import { selectTransferCoins } from '../transferCoinSelection';

interface TransferFormProps {
  onTxSuccess?: () => void;
  settlementSwapPathIndex?: number;
}

const DEFAULT_SLIPPAGE_BPS = 200;
const MAX_SLIPPAGE_BPS = 500;
const BPS_PER_PERCENT = 100;
const DEFAULT_SLIPPAGE_PERCENT = String(DEFAULT_SLIPPAGE_BPS / BPS_PER_PERCENT);
const MAX_SLIPPAGE_PERCENT = String(MAX_SLIPPAGE_BPS / BPS_PER_PERCENT);

export function TransferForm({ onTxSuccess, settlementSwapPathIndex = 0 }: TransferFormProps) {
  const account = useCurrentAccount();
  const client = useCurrentClient();
  const { sdk, error: sdkError } = useSDK();
  const dAppKit = useDAppKit();
  const selectedSettlementSwapPath = sdk
    ? getSelectedSettlementSwapPath(sdk, settlementSwapPathIndex)
    : null;
  const settlementTokenType = selectedSettlementSwapPath?.settlementTokenType ?? '';
  const SETTLEMENT_TOKEN_DECIMALS = selectedSettlementSwapPath?.settlementTokenDecimals ?? 6;

  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('1.0');
  const [slippagePercent, setSlippagePercent] = useState(DEFAULT_SLIPPAGE_PERCENT);
  const [status, setStatus] = useState<'idle' | 'building' | 'executing' | 'success' | 'error'>(
    'idle',
  );
  const [errorMsg, setErrorMsg] = useState('');
  const [logs, setLogs] = useState<string[]>([]);
  const [gasEstimate, setGasEstimate] = useState<{
    amountHuman: string;
    displayUnit: string;
    suiAmountHuman: string;
    canSkipLiquidity: boolean;
  } | null>(null);
  const [liquidity, setLiquidity] = useState<SettlementSwapPathLiquidityStatus | null>(null);

  const addLog = (msg: string) =>
    setLogs((prev) => [...prev, `[${new Date().toLocaleTimeString()}] ${msg}`]);
  const isBusy = status !== 'idle' && status !== 'error' && status !== 'success';

  const settlementSwapPath = selectedSettlementSwapPath;
  const SETTLEMENT_TOKEN_LABEL = settlementSwapPath?.settlementTokenSymbol ?? 'settlement token';

  useEffect(() => {
    if (!sdk || !client || !settlementSwapPath) return;
    let cancelled = false;
    sdk
      .checkSettlementSwapPathLiquidity(client, settlementSwapPath)
      .then((s: SettlementSwapPathLiquidityStatus) => {
        if (!cancelled) setLiquidity(s);
      })
      .catch(() => setLiquidity(null));
    return () => {
      cancelled = true;
    };
  }, [sdk, client, settlementSwapPath]);

  // Sponsored fee estimate — sdk.estimateGas() auto-selects profile via queryUserCredit internally
  useEffect(() => {
    if (!sdk || !account || !client || !settlementSwapPath) {
      setGasEstimate(null);
      return;
    }
    let cancelled = false;
    sdk
      .estimateGas(client, {
        addr: account.address,
        settlementToken: { type: settlementSwapPath.settlementTokenType },
      })
      .then((est) => {
        if (!cancelled && (est.hasLiquidity || est.canSkipLiquidity))
          setGasEstimate({
            amountHuman: est.amountHuman,
            displayUnit: est.displayUnit,
            suiAmountHuman: est.suiAmountHuman,
            canSkipLiquidity: est.canSkipLiquidity,
          });
        else if (!cancelled) setGasEstimate(null);
      })
      .catch(() => {
        /* best-effort */
      });
    return () => {
      cancelled = true;
    };
  }, [sdk, account, client, settlementSwapPath]);

  const handleTransfer = async () => {
    if (!account || !sdk || !settlementSwapPath) return;
    if (!/^0x[0-9a-fA-F]{64}$/.test(recipient)) {
      setErrorMsg('Invalid Sui address — must be 0x followed by 64 hex characters');
      return;
    }
    let parsedSlippageBps: number;
    try {
      parsedSlippageBps = parsePercentToBps(slippagePercent, MAX_SLIPPAGE_BPS, 'slippage');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Invalid slippage');
      return;
    }
    const parsedSlippagePercent = parsedSlippageBps / BPS_PER_PERCENT;

    let transferMist: bigint;
    try {
      transferMist = parseDecimalToSmallestUnit(
        amount,
        SETTLEMENT_TOKEN_DECIMALS,
        `${SETTLEMENT_TOKEN_LABEL} amount`,
      );
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Invalid transfer amount');
      return;
    }
    if (transferMist <= 0n) {
      setErrorMsg('Transfer amount must be greater than 0');
      return;
    }

    setStatus('building');
    setErrorMsg('');
    setLogs([]);

    try {
      // ── Pre-transfer settlement swap path health check: log per-hop status ──
      if (settlementSwapPath && sdk) {
        addLog('🔍 Checking settlement swap path status...');
        try {
          const settlementSwapPathCheck = await sdk.checkSettlementSwapPathLiquidity(
            client,
            settlementSwapPath,
          );
          for (const hop of settlementSwapPathCheck.hops) {
            const priceStr = hop.hasLiquidity
              ? `midRaw=${hop.midPriceRaw.toString()}`
              : '❌ NO LIQUIDITY';
            const dir = hop.swapDirection === 'baseForQuote' ? 'baseForQuote' : 'quoteForBase';
            addLog(`  ${hop.label} (${dir}) [${hop.poolId.slice(0, 10)}…] ${priceStr}`);
          }
          if (!settlementSwapPathCheck.hasLiquidity) {
            addLog('⚠️ One or more DeepBook pools have no liquidity — transfer may fail');
          } else if (settlementSwapPathCheck.priceDisplay != null) {
            addLog(
              `  Settlement path rate: 1 ${SETTLEMENT_TOKEN_LABEL} ≈ ${settlementSwapPathCheck.priceDisplay} SUI`,
            );
          }
        } catch {
          addLog('⚠️ Settlement swap path status check failed — proceeding anyway');
        }
      }

      addLog(`Preparing ${amount} ${SETTLEMENT_TOKEN_LABEL} transfer...`);

      const coinRead = await readBoundedSuiCoins(createSuiEndpointSnapshot([client]), {
        owner: account.address,
        coinType: settlementTokenType,
      });
      const selectedCoins = selectTransferCoins(coinRead, transferMist);

      // Use the same bounded, u64-safe subset selection as the Host.
      const tx = new Transaction();
      const primaryCoin = tx.object(selectedCoins.baseCoinId);
      if (selectedCoins.mergeCoinIds.length > 0) {
        tx.mergeCoins(
          primaryCoin,
          selectedCoins.mergeCoinIds.map((objectId) => tx.object(objectId)),
        );
      }

      const [transferCoin] = tx.splitCoins(primaryCoin, [tx.pure.u64(transferMist)]);
      tx.transferObjects([transferCoin], recipient);

      addLog(`Transferring ${amount} ${SETTLEMENT_TOKEN_LABEL} to ${recipient.slice(0, 10)}...`);
      addLog(`Slippage: ${parsedSlippagePercent}% (${parsedSlippageBps} bps)`);
      setStatus('executing');

      const result = await sdk.executeSponsored(tx, {
        client,
        prepareAuthorizationSigner: async (messageBytes: Uint8Array) => {
          const { signature } = await dAppKit.signPersonalMessage({ message: messageBytes });
          return signature;
        },
        signer: async (txBytes: string) => {
          const { signature } = await dAppKit.signTransaction({ transaction: txBytes });
          return signature;
        },
        addr: account.address,
        settlementToken: { type: settlementTokenType },
        slippageBps: parsedSlippageBps,
        onGasEstimate: (_, amountHuman, symbol) => {
          if (amountHuman !== '0') {
            addLog(`⛽ Gas: ${amountHuman} ${symbol}`);
            setGasEstimate((prev) =>
              prev
                ? {
                    amountHuman,
                    displayUnit: symbol,
                    suiAmountHuman: prev.suiAmountHuman,
                    canSkipLiquidity: prev.canSkipLiquidity,
                  }
                : prev,
            );
          }
        },
      });

      setStatus('success');
      addLog('✅ Transfer complete! Digest: ' + result.digest);
      onTxSuccess?.();
    } catch (e: unknown) {
      setStatus('error');
      const msg = e instanceof Error ? e.message : 'Unknown error';
      setErrorMsg(msg);
      addLog('❌ Error: ' + msg);
      // Show server-side detail if available (StelisSponsoredError wraps the API response)
      const cause = (e as { cause?: { message?: string; code?: string } })?.cause;
      if (cause?.message && cause.message !== msg) {
        addLog(`   Detail: [${cause.code ?? ''}] ${cause.message}`);
      }
    }
  };

  const inputStyle = {
    width: '100%',
    padding: '8px 10px',
    borderRadius: 6,
    border: '1px solid var(--border, #444)',
    background: 'rgba(255,255,255,0.06)',
    color: 'inherit',
    fontSize: 13,
    boxSizing: 'border-box' as const,
  };
  const labelStyle = {
    fontSize: 12,
    color: 'var(--text-secondary, #aaa)',
    marginBottom: 4,
    display: 'block',
  };

  return (
    <div style={SANDBOX_CARD_STYLE}>
      <h3 style={{ margin: '0 0 12px', fontSize: 15 }}>
        📤 Sponsored Transfer ({SETTLEMENT_TOKEN_LABEL})
      </h3>

      <div style={{ marginBottom: 12 }}>
        <label style={labelStyle}>Recipient Address</label>
        <input
          value={recipient}
          onChange={(e) => setRecipient(e.target.value)}
          placeholder="0x..."
          disabled={isBusy}
          style={inputStyle}
        />
      </div>
      <div style={{ marginBottom: 12 }}>
        <label style={labelStyle}>Amount ({SETTLEMENT_TOKEN_LABEL})</label>
        <input
          type="number"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          min="0"
          step="0.1"
          disabled={isBusy}
          style={inputStyle}
        />
      </div>
      <div style={{ marginBottom: 12 }}>
        <label style={labelStyle}>Slippage (% , 0-{MAX_SLIPPAGE_PERCENT})</label>
        <input
          type="number"
          value={slippagePercent}
          onChange={(e) => setSlippagePercent(e.target.value)}
          min="0"
          max={String(MAX_SLIPPAGE_PERCENT)}
          step="0.1"
          disabled={isBusy}
          style={inputStyle}
        />
      </div>

      <div style={{ fontSize: 13, color: 'var(--text-secondary, #aaa)', marginBottom: 12 }}>
        ⛽ Est. Gas:{' '}
        <strong>
          {gasEstimate
            ? `~${gasEstimate.amountHuman} ${gasEstimate.displayUnit}${gasEstimate.displayUnit !== 'SUI' ? ` (~${gasEstimate.suiAmountHuman} SUI)` : ''}`
            : sdk && account
              ? 'calculating...'
              : '—'}
        </strong>
      </div>

      {sdkError && (
        <div style={{ fontSize: 12, color: '#f44336', marginBottom: 8 }}>SDK Error: {sdkError}</div>
      )}
      {errorMsg && (
        <div style={{ fontSize: 12, color: '#f44336', marginBottom: 8 }}>{errorMsg}</div>
      )}

      <button
        onClick={handleTransfer}
        disabled={
          !account ||
          !sdk ||
          !settlementSwapPath ||
          isBusy ||
          !recipient ||
          (liquidity?.hasLiquidity === false && !gasEstimate?.canSkipLiquidity)
        }
        style={{
          width: '100%',
          padding: '10px',
          borderRadius: 8,
          border: 'none',
          background: '#6366f1',
          color: '#fff',
          fontWeight: 600,
          fontSize: 14,
          cursor:
            !account ||
            !sdk ||
            !settlementSwapPath ||
            isBusy ||
            !recipient ||
            (liquidity?.hasLiquidity === false && !gasEstimate?.canSkipLiquidity)
              ? 'not-allowed'
              : 'pointer',
          opacity:
            !account ||
            !sdk ||
            !settlementSwapPath ||
            isBusy ||
            !recipient ||
            (liquidity?.hasLiquidity === false && !gasEstimate?.canSkipLiquidity)
              ? 0.5
              : 1,
        }}
      >
        {isBusy ? status.toUpperCase() : `📤 Transfer ${amount} ${SETTLEMENT_TOKEN_LABEL}`}
      </button>

      <div style={{ marginTop: 12 }}>
        <TransactionStatus status={status} />
      </div>

      {logs.length > 0 && (
        <div
          style={{
            marginTop: 8,
            fontSize: 11,
            fontFamily: 'monospace',
            color: 'var(--text-secondary, #aaa)',
          }}
        >
          {logs.map((l, i) => (
            <div key={i}>{l}</div>
          ))}
        </div>
      )}
    </div>
  );
}
