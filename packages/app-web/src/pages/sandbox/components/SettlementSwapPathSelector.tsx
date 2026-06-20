import { useSDK } from '../hooks/useSDK';

interface SettlementSwapPathSelectorProps {
  settlementSwapPathIndex: number;
  onSettlementSwapPathChange: (index: number) => void;
}

/**
 * Settlement swap path selector. Single-path hosts still render a disabled
 * selector so the active settlement token stays visible.
 */
export function SettlementSwapPathSelector({
  settlementSwapPathIndex,
  onSettlementSwapPathChange,
}: SettlementSwapPathSelectorProps) {
  const { sdk, error } = useSDK();
  const settlementSwapPaths = sdk?.supportedSettlementSwapPaths ?? [];
  const selectedValue =
    settlementSwapPaths.length === 0
      ? ''
      : String(Math.min(settlementSwapPathIndex, settlementSwapPaths.length - 1));

  return (
    <div
      style={{
        marginBottom: 12,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        flexWrap: 'wrap',
      }}
    >
      <label htmlFor="settlement-swap-path-selector" style={{ fontSize: 13, fontWeight: 500 }}>
        Settlement Token:
      </label>
      <select
        id="settlement-swap-path-selector"
        value={selectedValue}
        onChange={(e) => {
          const next = e.target.value;
          if (!/^(?:0|[1-9]\d*)$/.test(next)) return;
          const parsed = Number(next);
          if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed >= settlementSwapPaths.length) {
            return;
          }
          onSettlementSwapPathChange(parsed);
        }}
        disabled={settlementSwapPaths.length <= 1}
        style={{ fontSize: 13, padding: '2px 6px' }}
      >
        {settlementSwapPaths.length === 0 && (
          <option value="">
            {error ? 'Settlement tokens unavailable' : 'Loading settlement tokens...'}
          </option>
        )}
        {settlementSwapPaths.map((settlementSwapPath, i) => (
          <option key={settlementSwapPath.settlementTokenType} value={i}>
            {settlementSwapPath.settlementTokenSymbol}
          </option>
        ))}
      </select>
      {error && <span style={{ fontSize: 12, color: '#f44336' }}>SDK: {error}</span>}
    </div>
  );
}
