import type { SandboxStep } from '../types';
import { SyntaxHighlight } from '../../../components/SyntaxHighlight';
import { useSDK } from '../hooks/useSDK';
import { getSelectedSettlementSwapPath } from '../constants';

interface CodePanelProps {
  activeStep: SandboxStep;
  onStepChange: (step: SandboxStep) => void;
  settlementSwapPathIndex?: number;
}

function makeSnippets(
  tokenSymbol: string,
  settlementSwapPathIndex: number,
): Record<SandboxStep, { title: string; code: string }> {
  return {
    install: {
      title: 'Step 1: Install Dependencies',
      code: `# Core SDK — gas abstraction + Relay API client
npm install @stelis/sdk

# Sui blockchain client
npm install @mysten/sui

# Wallet connector (React)
npm install @mysten/dapp-kit-react

# Then connect — SDK auto-detects network from the Host:
import { StelisSDK } from '@stelis/sdk';
const sdk = await StelisSDK.connect('https://your-host/relay');
// sdk.network exposes 'testnet' | 'mainnet'.`,
    },
    connect: {
      title: 'Step 2: Connect to Host',
      code: `import { StelisSDK } from '@stelis/sdk';

// connect() auto-detects network from the Host.
const sdk = await StelisSDK.connect('https://your-host/relay');

console.log(sdk.network);              // 'testnet' | 'mainnet'
console.log(sdk.settlementPayoutRecipient);     // '0x...'`,
    },
    transfer: {
      title: `Step 3: Sponsored Transfer (${tokenSymbol})`,
      code: `import { Transaction } from '@mysten/sui/transactions';

const tx = new Transaction();

// Pick a coin, merge others into it, split the transfer amount.
// The Host handles R-9 collision avoidance and address-balance
// accounting server-side — no need to reserve an untouched coin.
const primaryCoin = tx.object(coinId);
if (otherCoinIds.length > 0) {
  tx.mergeCoins(primaryCoin, otherCoinIds.map(id => tx.object(id)));
}
const [transferCoin] = tx.splitCoins(primaryCoin, [tx.pure.u64(transferMist)]);
tx.transferObjects([transferCoin], recipientAddress);

// No SUI needed — gas is paid in ${tokenSymbol}.
const result = await sdk.executeSponsored(tx, {
  client,              // SuiGrpcClient
  prepareAuthorizationSigner: async (messageBytes) => {
    const { signature } = await wallet.signPersonalMessage({ message: messageBytes });
    return signature;
  },
  signer: async (txBytes) => {
    const { signature } = await wallet.signTransaction({ transaction: txBytes });
    return signature;
  },
  addr: senderAddress,
  settlementToken: { type: sdk.supportedSettlementSwapPaths[${settlementSwapPathIndex}].settlementTokenType },
});

console.log(result.digest);        // on-chain TX digest
console.log(result.totalCostSui);  // total cost in SUI`,
    },
  };
}

const stepOrder: SandboxStep[] = ['install', 'connect', 'transfer'];

export function CodePanel({
  activeStep,
  onStepChange,
  settlementSwapPathIndex = 0,
}: CodePanelProps) {
  const { sdk } = useSDK();
  const selectedSettlementSwapPath = sdk
    ? getSelectedSettlementSwapPath(sdk, settlementSwapPathIndex)
    : null;
  const tokenSymbol = selectedSettlementSwapPath?.settlementTokenSymbol ?? 'settlement token';
  const snippets = makeSnippets(tokenSymbol, settlementSwapPathIndex);
  const { title, code } = snippets[activeStep];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
      {/* Step indicators */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        {stepOrder.map((step, i) => (
          <div
            key={step}
            onMouseEnter={() => onStepChange(step)}
            style={{
              padding: '4px 10px',
              borderRadius: 99,
              fontSize: 11,
              fontWeight: 600,
              cursor: 'pointer',
              border: `1px solid ${activeStep === step ? '#6366f1' : 'var(--border, #333)'}`,
              color: activeStep === step ? '#6366f1' : 'var(--text-secondary, #888)',
              background: activeStep === step ? 'rgba(99,102,241,0.12)' : 'transparent',
              transition: 'all 0.2s',
            }}
          >
            {i + 1}. {step.charAt(0).toUpperCase() + step.slice(1)}
          </div>
        ))}
      </div>

      {/* Code block */}
      <div
        style={{
          background: 'rgba(0,0,0,0.4)',
          border: '1px solid var(--border, #333)',
          borderRadius: 10,
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            padding: '10px 16px',
            borderBottom: '1px solid var(--border, #333)',
            fontSize: 12,
            color: '#6366f1',
            fontWeight: 600,
          }}
        >
          {title}
        </div>
        <SyntaxHighlight code={code} lang={activeStep === 'install' ? 'sh' : 'ts'} />
      </div>

      <p
        style={{
          fontSize: 12,
          color: 'var(--text-secondary, #888)',
          marginTop: 12,
          lineHeight: 1.5,
        }}
      >
        The code panel shows a reference implementation for each step. The sandbox execution panel
        on the left demonstrates the live flow.
      </p>
    </div>
  );
}
