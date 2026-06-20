import { useCallback, useState } from 'react';
import { WalletProvider } from './WalletProvider';
import { ConnectCredit } from './ConnectCredit';
import { SwapForm } from './SwapForm';
import { TransferForm } from './TransferForm';
import { SettlementSwapPathSelector } from './SettlementSwapPathSelector';
import { CodePanel } from './CodePanel';
import type { SandboxStep } from '../types';
import { useAppConfig } from '../../../AppConfigContext';

interface ExecutionPanelProps {
  onStepChange: (step: SandboxStep) => void;
  activeStep: SandboxStep;
  settlementSwapPathIndex: number;
  onSettlementSwapPathIndexChange: (index: number) => void;
}

type CardId = 'connect' | 'swap' | 'transfer';

const CARD_COLORS: Record<CardId, string> = {
  connect: '#6366f1',
  swap: '#06b6d4',
  transfer: '#a855f7',
};

function ExecutionPanelInner({
  onStepChange,
  activeStep,
  settlementSwapPathIndex,
  onSettlementSwapPathIndexChange,
}: ExecutionPanelProps) {
  const [refreshKey, setRefreshKey] = useState(0);
  const onTxSuccess = useCallback(() => setRefreshKey((k) => k + 1), []);
  const { config } = useAppConfig();
  const isMainnet = config?.network === 'mainnet';
  // On mainnet, hide the Swap card — users acquire settlement tokens from DEXes directly.
  const cards: CardId[] = isMainnet ? ['connect', 'transfer'] : ['connect', 'swap', 'transfer'];

  return (
    <div>
      <SettlementSwapPathSelector
        settlementSwapPathIndex={settlementSwapPathIndex}
        onSettlementSwapPathChange={onSettlementSwapPathIndexChange}
      />
      {cards.map((card) => {
        const isActive = (activeStep as string) === card;
        return (
          <div
            key={card}
            onMouseEnter={() => {
              if (card !== 'swap') onStepChange(card);
            }}
            style={{
              ['--card-accent' as string]: isActive ? `${CARD_COLORS[card]}66` : undefined,
              ['--card-accent-bg' as string]: isActive ? `${CARD_COLORS[card]}0d` : undefined,
            }}
          >
            {card === 'connect' && (
              <ConnectCredit
                refreshKey={refreshKey}
                onTxSuccess={onTxSuccess}
                settlementSwapPathIndex={settlementSwapPathIndex}
              />
            )}
            {card === 'swap' && (
              <SwapForm
                onTxSuccess={onTxSuccess}
                settlementSwapPathIndex={settlementSwapPathIndex}
              />
            )}
            {card === 'transfer' && (
              <TransferForm
                onTxSuccess={onTxSuccess}
                settlementSwapPathIndex={settlementSwapPathIndex}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

export function ExecutionPanel({
  onStepChange,
  activeStep,
  settlementSwapPathIndex,
  onSettlementSwapPathIndexChange,
}: ExecutionPanelProps) {
  return (
    <WalletProvider>
      <ExecutionPanelInner
        onStepChange={onStepChange}
        activeStep={activeStep}
        settlementSwapPathIndex={settlementSwapPathIndex}
        onSettlementSwapPathIndexChange={onSettlementSwapPathIndexChange}
      />
    </WalletProvider>
  );
}

export { CodePanel };
