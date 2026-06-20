import { useSDK } from '../hooks/useSDK';

interface SettlementSwapPathSelectorProps {
  settlementSwapPathIndex: number;
  onSettlementSwapPathChange: (index: number) => void;
}

/**
 * Settlement swap path selector. It is only rendered when the connected host
 * supports multiple settlement token paths. Single-path hosts skip it entirely.
 */
export function SettlementSwapPathSelector({
  settlementSwapPathIndex,
  onSettlementSwapPathChange,
}: SettlementSwapPathSelectorProps) {
  const { sdk } = useSDK();
  const settlementSwapPaths = sdk?.supportedSettlementSwapPaths ?? [];

  if (settlementSwapPaths.length <= 1) return null;

  return (
    <div style={{ marginBottom: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
      <label htmlFor="settlement-swap-path-selector" style={{ fontSize: 13, fontWeight: 500 }}>
        Settlement Token:
      </label>
      <select
        id="settlement-swap-path-selector"
        value={settlementSwapPathIndex}
        onChange={(e) => {
          const next = e.target.value;
          if (!/^(?:0|[1-9]\d*)$/.test(next)) return;
          const parsed = Number(next);
          if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed >= settlementSwapPaths.length) {
            return;
          }
          onSettlementSwapPathChange(parsed);
        }}
        style={{ fontSize: 13, padding: '2px 6px' }}
      >
        {settlementSwapPaths.map((settlementSwapPath, i) => (
          <option key={settlementSwapPath.settlementTokenType} value={i}>
            {settlementSwapPath.settlementTokenSymbol}
          </option>
        ))}
      </select>
    </div>
  );
}
