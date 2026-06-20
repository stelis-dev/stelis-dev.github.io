import { useCallback, useEffect, useState } from 'react';
import { useCurrentClient } from '@mysten/dapp-kit-react';
import { useSDK } from './useSDK';
import { getSelectedSettlementSwapPath } from '../constants';

export interface SettlementSwapPathStatus {
  midPrice: number | null;
  hasLiquidity: boolean;
  rateDisplay: string;
  loading: boolean;
  refresh: () => void;
}

export function useSettlementSwapPathStatus(settlementSwapPathIndex = 0): SettlementSwapPathStatus {
  const client = useCurrentClient();
  const { sdk, error } = useSDK();
  const [midPrice, setMidPrice] = useState<number | null>(null);
  const [hasLiquidity, setHasLiquidity] = useState(false);
  const [rateDisplay, setRateDisplay] = useState('loading...');
  const [loading, setLoading] = useState(true);

  const fetchPrice = useCallback(async () => {
    if (!sdk) {
      setMidPrice(null);
      setHasLiquidity(false);
      setRateDisplay(error ? 'unavailable' : 'loading...');
      setLoading(!error);
      return;
    }
    setLoading(true);
    try {
      const settlementSwapPath = getSelectedSettlementSwapPath(sdk, settlementSwapPathIndex);
      const result = await sdk.getExchangeRate(client, settlementSwapPath.settlementTokenType);
      setMidPrice(result.rate);
      setHasLiquidity(result.hasLiquidity);
      setRateDisplay(result.rateDisplay);
    } catch {
      setMidPrice(null);
      setHasLiquidity(false);
      setRateDisplay('unavailable');
    } finally {
      setLoading(false);
    }
  }, [client, error, sdk, settlementSwapPathIndex]);

  useEffect(() => {
    fetchPrice();
  }, [fetchPrice]);

  return { midPrice, hasLiquidity, rateDisplay, loading, refresh: fetchPrice };
}
