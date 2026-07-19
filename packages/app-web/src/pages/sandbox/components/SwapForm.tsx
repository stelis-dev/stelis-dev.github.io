import { useState, useEffect } from 'react';
import { useCurrentAccount, useCurrentClient, useDAppKit } from '@mysten/dapp-kit-react';
import { Transaction } from '@mysten/sui/transactions';
import {
  buildSuiTransaction,
  createSuiEndpointSnapshot,
  simulateSuiTransaction,
  SUI_CLOCK_OBJECT_ID,
  suiExecutionErrorMessage,
} from '@stelis/core-relay/browser';
import { useSDK } from '../hooks/useSDK';
import { TransactionStatus } from './TransactionStatus';
import {
  getSelectedSettlementSwapPath,
  SUI_DECIMALS,
  swapDemoRejectReason,
  getSwapDemoRejectMessage,
} from '../constants';
import { findTestSwapPair, type SupportedNetwork } from '../testSwapPairs';
import {
  DIRECT_SWAP_SLIPPAGE_BPS,
  quoteDirectSwapOutput,
  type DirectSwapQuote,
} from '../deepbookDirectSwap';
import { useAppConfig } from '../../../AppConfigContext';
import { SANDBOX_CARD_STYLE } from './cardStyles';
import { signAndExecuteLocalTransaction } from '../localSuiExecution';
import {
  formatSmallestUnitDecimal,
  parseDecimalIntegerToBigInt,
  parseDecimalToSmallestUnit,
} from '../amount';

interface SwapFormProps {
  onTxSuccess?: () => void;
  settlementSwapPathIndex?: number;
}

type DirectSwapQuoteState =
  | { status: 'idle'; message: string }
  | { status: 'checking'; message: string }
  | {
      status: 'ready';
      expectedOutput: bigint;
      minOutput: bigint;
      expectedDisplay: string;
      minDisplay: string;
    }
  | { status: 'unavailable'; message: string };

/**
 * Sandbox helper: swap SUI → settlement token of the selected settlement swap path
 * via DeepBook.
 *
 * Uses a hardcoded testnet/mainnet DeepBook pair list (testSwapPairs.ts) keyed
 * by settlement token TYPE — independent of the Host's settlement registry.
 * The target token auto-tracks the selected settlement swap path.
 */
export function SwapForm({ onTxSuccess, settlementSwapPathIndex = 0 }: SwapFormProps) {
  const account = useCurrentAccount();
  const client = useCurrentClient();
  const { sdk, error: sdkError } = useSDK();
  const dAppKit = useDAppKit();
  const { config } = useAppConfig();
  const network = config!.network as SupportedNetwork;

  const selectedSettlementSwapPath = sdk
    ? getSelectedSettlementSwapPath(sdk, settlementSwapPathIndex)
    : null;
  const settlementTokenType = selectedSettlementSwapPath?.settlementTokenType ?? '';
  const settlementTokenLabel =
    selectedSettlementSwapPath?.settlementTokenSymbol ?? 'settlement token';
  const testPair = settlementTokenType ? findTestSwapPair(network, settlementTokenType) : null;
  // Direct-swap demo scope gate (unsupported_hop_count / fee_bearing). See
  // sandbox/constants.ts. Fee-bearing paths require additional DeepBook input
  // fee handling beyond the positive-output/min-output guard implemented here.
  const demoRejectReason = selectedSettlementSwapPath
    ? swapDemoRejectReason(selectedSettlementSwapPath)
    : null;
  const demoRejectMessage = selectedSettlementSwapPath
    ? getSwapDemoRejectMessage(selectedSettlementSwapPath)
    : null;

  const [suiAmount, setSuiAmount] = useState('0.1');
  const [status, setStatus] = useState<'idle' | 'building' | 'executing' | 'success' | 'error'>(
    'idle',
  );
  const [errorMsg, setErrorMsg] = useState('');
  const [digest, setDigest] = useState('');
  const [logs, setLogs] = useState<string[]>([]);
  const [gasEstimate, setGasEstimate] = useState<string | null>(null);
  const [directSwapQuote, setDirectSwapQuote] = useState<DirectSwapQuoteState>({
    status: 'idle',
    message: 'Enter a SUI amount to quote the direct swap.',
  });

  const addLog = (msg: string) =>
    setLogs((prev) => [...prev, `[${new Date().toLocaleTimeString()}] ${msg}`]);
  const isBusy = status !== 'idle' && status !== 'error' && status !== 'success';

  const parseSuiAmountMist = () =>
    parseDecimalToSmallestUnit(suiAmount, SUI_DECIMALS, 'SUI amount');

  const buildSwapTx = (suiMist: bigint, quote: DirectSwapQuote) => {
    if (!account || !sdk) throw new Error('Not ready');
    if (!testPair) {
      throw new Error(
        `No hardcoded DeepBook pair registered for ${settlementTokenLabel} on ${network}`,
      );
    }
    if (suiMist <= 0n) throw new Error('SUI amount must be greater than 0');
    const tx = new Transaction();
    const [suiCoin] = tx.splitCoins(tx.gas, [tx.pure.u64(suiMist)]);
    const deepFeeCoin = tx.moveCall({
      target: '0x2::coin::zero',
      typeArguments: [sdk.deepType],
    });
    const swapResult = tx.moveCall({
      target: `${sdk.deepbookPackageId}::pool::${testPair.swapDirection}`,
      typeArguments: [testPair.baseType, testPair.quoteType],
      arguments: [
        tx.object(testPair.poolId),
        suiCoin,
        deepFeeCoin,
        tx.pure.u64(quote.minOutputSmallest),
        tx.object(SUI_CLOCK_OBJECT_ID),
      ],
    });
    tx.transferObjects([swapResult[0], swapResult[1], swapResult[2]], account.address);
    return tx;
  };

  useEffect(() => {
    if (
      !sdk ||
      !client ||
      !account ||
      !selectedSettlementSwapPath ||
      !testPair ||
      demoRejectReason !== null
    ) {
      setDirectSwapQuote({
        status: 'idle',
        message: 'Direct swap quote is unavailable for the selected settlement swap path.',
      });
      return;
    }

    let cancelled = false;
    setDirectSwapQuote({ status: 'checking', message: 'Checking direct DeepBook output...' });

    (async () => {
      try {
        const suiMist = parseSuiAmountMist();
        const quote = await quoteDirectSwapOutput({
          client,
          deepbookPackageId: sdk.deepbookPackageId,
          testPair,
          inputAmountSmallest: suiMist,
          slippageBps: DIRECT_SWAP_SLIPPAGE_BPS,
        });
        if (cancelled) return;
        const decimals = selectedSettlementSwapPath.settlementTokenDecimals;
        const fractionDigits = Math.min(4, decimals);
        setDirectSwapQuote({
          status: 'ready',
          expectedOutput: quote.expectedOutputSmallest,
          minOutput: quote.minOutputSmallest,
          expectedDisplay: formatSmallestUnitDecimal(
            quote.expectedOutputSmallest,
            decimals,
            fractionDigits,
          ),
          minDisplay: formatSmallestUnitDecimal(quote.minOutputSmallest, decimals, fractionDigits),
        });
      } catch (err) {
        if (cancelled) return;
        setDirectSwapQuote({
          status: 'unavailable',
          message: err instanceof Error ? err.message : 'Direct DeepBook quote is unavailable',
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [sdk, client, account, selectedSettlementSwapPath, testPair, demoRejectReason, suiAmount]);

  useEffect(() => {
    if (
      !sdk ||
      !client ||
      !account ||
      !testPair ||
      demoRejectReason !== null ||
      directSwapQuote.status !== 'ready'
    ) {
      setGasEstimate(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const tx = buildSwapTx(parseSuiAmountMist(), {
          expectedOutputSmallest: directSwapQuote.expectedOutput,
          minOutputSmallest: directSwapQuote.minOutput,
        });
        tx.setSender(account.address);
        const endpoints = createSuiEndpointSnapshot([client]);
        const txBytes = await buildSuiTransaction(endpoints, { transaction: tx });
        const simResult = await simulateSuiTransaction(endpoints, {
          transaction: txBytes,
        });
        if (cancelled) return;
        if (simResult.outcome !== 'success') {
          throw new Error(`Gas simulation failed: ${suiExecutionErrorMessage(simResult.error)}`);
        }
        const costs = simResult.effects.gasUsed;
        const net =
          parseDecimalIntegerToBigInt(costs.computationCost, 'computationCost') +
          parseDecimalIntegerToBigInt(costs.storageCost, 'storageCost') -
          parseDecimalIntegerToBigInt(costs.storageRebate, 'storageRebate');
        setGasEstimate(formatSmallestUnitDecimal(net > 0n ? net : 0n, SUI_DECIMALS, 5));
      } catch {
        // best-effort — user may not have enough SUI for simulation
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sdk, client, account, testPair, demoRejectReason, suiAmount, directSwapQuote]);

  const handleSwap = async () => {
    if (
      !account ||
      !sdk ||
      !client ||
      !selectedSettlementSwapPath ||
      !testPair ||
      demoRejectReason !== null
    ) {
      return;
    }
    setStatus('building');
    setErrorMsg('');
    setDigest('');
    setLogs([]);
    addLog(`Swapping ${suiAmount} SUI → ${settlementTokenLabel}...`);

    try {
      const suiMist = parseSuiAmountMist();
      const freshQuote = await quoteDirectSwapOutput({
        client,
        deepbookPackageId: sdk.deepbookPackageId,
        testPair,
        inputAmountSmallest: suiMist,
        slippageBps: DIRECT_SWAP_SLIPPAGE_BPS,
      });
      const decimals = selectedSettlementSwapPath.settlementTokenDecimals;
      const fractionDigits = Math.min(4, decimals);
      addLog(
        `Expected output: ${formatSmallestUnitDecimal(
          freshQuote.expectedOutputSmallest,
          decimals,
          fractionDigits,
        )} ${settlementTokenLabel}`,
      );
      addLog(
        `Minimum accepted: ${formatSmallestUnitDecimal(
          freshQuote.minOutputSmallest,
          decimals,
          fractionDigits,
        )} ${settlementTokenLabel}`,
      );
      const tx = buildSwapTx(suiMist, freshQuote);
      setStatus('executing');
      addLog('Signing with wallet and submitting with SUI gas...');
      const { digest: transactionDigest } = await signAndExecuteLocalTransaction({
        transaction: tx,
        client,
        signer: dAppKit,
        senderAddress: account.address,
      });

      setStatus('success');
      setDigest(transactionDigest);
      addLog(`✅ Swap complete! Digest: ${transactionDigest}`);
      onTxSuccess?.();
    } catch (e: unknown) {
      setStatus('error');
      const msg = e instanceof Error ? e.message : 'Unknown error';
      setErrorMsg(msg);
      addLog('❌ ' + msg);
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

  const swapDisabled =
    !account ||
    !sdk ||
    !selectedSettlementSwapPath ||
    isBusy ||
    !testPair ||
    demoRejectReason !== null;
  const swapQuoteUnavailable =
    demoRejectReason === null && Boolean(testPair) && directSwapQuote.status !== 'ready';
  const swapDisabledWithQuote = swapDisabled || swapQuoteUnavailable;

  return (
    <div style={SANDBOX_CARD_STYLE}>
      <h3 style={{ margin: '0 0 14px 0', fontSize: 15 }}>🔄 Swap SUI → {settlementTokenLabel}</h3>

      {demoRejectMessage && (
        <div
          style={{
            fontSize: 12,
            color: '#f59e0b',
            marginBottom: 12,
            padding: '8px 10px',
            background: 'rgba(245,158,11,0.08)',
            borderRadius: 6,
            border: '1px solid rgba(245,158,11,0.2)',
          }}
        >
          {demoRejectMessage}
        </div>
      )}

      {demoRejectReason === null && !testPair && selectedSettlementSwapPath && (
        <div
          style={{
            fontSize: 12,
            color: '#f59e0b',
            marginBottom: 12,
            padding: '8px 10px',
            background: 'rgba(245,158,11,0.08)',
            borderRadius: 6,
            border: '1px solid rgba(245,158,11,0.2)',
          }}
        >
          No hardcoded DeepBook pair is registered for {settlementTokenLabel} on {network}. Add one
          in
          <code style={{ margin: '0 4px' }}>testSwapPairs.ts</code>to enable direct acquisition.
        </div>
      )}

      <div
        style={{
          fontSize: 12,
          color: 'var(--text-secondary, #aaa)',
          marginBottom: 12,
          padding: '6px 10px',
          background: 'rgba(255,255,255,0.03)',
          borderRadius: 6,
        }}
      >
        ⚡ Direct DeepBook swap: pay gas in SUI. Use this to acquire {settlementTokenLabel} tokens
        for testing. The swap is disabled when DeepBook cannot quote a positive output.
      </div>

      {testPair && demoRejectReason === null && (
        <div
          style={{
            fontSize: 12,
            color:
              directSwapQuote.status === 'ready'
                ? 'var(--success, #22c55e)'
                : directSwapQuote.status === 'checking'
                  ? 'var(--text-secondary, #aaa)'
                  : '#f44336',
            marginBottom: 12,
            padding: '6px 10px',
            background: 'rgba(255,255,255,0.03)',
            borderRadius: 6,
          }}
        >
          {directSwapQuote.status === 'ready'
            ? `Estimated received: ${directSwapQuote.expectedDisplay} ${settlementTokenLabel} (minimum ${directSwapQuote.minDisplay})`
            : directSwapQuote.message}
        </div>
      )}

      <div style={{ marginBottom: 12 }}>
        <label style={labelStyle}>SUI Amount</label>
        <input
          type="number"
          value={suiAmount}
          onChange={(e) => setSuiAmount(e.target.value)}
          min="0"
          step="0.01"
          disabled={isBusy}
          style={inputStyle}
        />
      </div>

      <div style={{ fontSize: 13, color: 'var(--text-secondary, #aaa)', marginBottom: 12 }}>
        ⛽ Est. Gas:{' '}
        <strong>
          {gasEstimate
            ? `~${gasEstimate} SUI`
            : sdk && account && testPair && directSwapQuote.status === 'ready'
              ? 'calculating...'
              : '—'}
        </strong>
      </div>

      <button
        onClick={handleSwap}
        disabled={swapDisabledWithQuote}
        style={{
          width: '100%',
          padding: '10px',
          borderRadius: 8,
          border: 'none',
          background: '#0ea5e9',
          color: '#fff',
          fontWeight: 600,
          fontSize: 14,
          cursor: swapDisabledWithQuote ? 'not-allowed' : 'pointer',
          opacity: swapDisabledWithQuote ? 0.5 : 1,
        }}
      >
        {isBusy ? status.toUpperCase() : `⚡ Swap ${suiAmount} SUI → ${settlementTokenLabel}`}
      </button>

      {sdkError && (
        <div style={{ marginTop: 8, fontSize: 12, color: '#f44336' }}>SDK: {sdkError}</div>
      )}
      {errorMsg && <div style={{ marginTop: 8, fontSize: 12, color: '#f44336' }}>{errorMsg}</div>}

      {digest && (
        <div style={{ marginTop: 8 }}>
          <a
            href={`https://suiscan.xyz/${network}/tx/${digest}`}
            target="_blank"
            rel="noreferrer"
            style={{ fontSize: 12, color: '#6366f1' }}
          >
            View Transaction ↗
          </a>
        </div>
      )}

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
