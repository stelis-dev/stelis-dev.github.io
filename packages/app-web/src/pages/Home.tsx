import { Link } from 'react-router-dom';
import { Mermaid } from '../components/Mermaid';
import { SyntaxHighlight } from '../components/SyntaxHighlight';

export function HomePage() {
  return (
    <>
      {/* ── Hero ── */}
      <section className="hero">
        <h1 className="hero-title">Stelis</h1>
        <p className="hero-desc" style={{ fontWeight: 500, marginBottom: 8 }}>
          Token-native payments, settled on Sui.
        </p>
        <p className="hero-desc" style={{ fontSize: 15, marginBottom: 12 }}>
          Pay with your token. Stelis handles settlement and execution.
        </p>
        <p className="hero-audience">
          For developers and agents who want to start with a deployed Host when the user has tokens
          but no SUI.
        </p>
        <div className="hero-actions">
          <Link to="/sandbox" className="btn btn-primary">
            Try the Sandbox →
          </Link>
          <Link to="/docs" className="btn btn-outline">
            Read the Docs
          </Link>
        </div>
      </section>

      {/* ── Core Properties ── */}
      <section style={{ background: 'var(--bg-secondary)', padding: '48px 24px' }}>
        <div style={{ maxWidth: 720, margin: '0 auto' }}>
          <h2 className="section-heading">Core Properties</h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
              <span style={{ fontSize: 20, lineHeight: 1 }}>🛡️</span>
              <div>
                <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 2 }}>
                  Non-loss policy
                </div>
                <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                  The Host refuses to sponsor if the claimed cost is not fully covered by dry-run
                  simulation + risk buffer.
                </div>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
              <span style={{ fontSize: 20, lineHeight: 1 }}>🔒</span>
              <div>
                <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 2 }}>
                  User-owned vault protection
                </div>
                <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                  Vault credit lives in a user-owned Sui object. Settlement-token funding can use
                  coin objects or address balance, and users can withdraw vault credit directly
                  anytime.
                </div>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
              <span style={{ fontSize: 20, lineHeight: 1 }}>📐</span>
              <div>
                <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 2 }}>
                  Structural revenue
                </div>
                <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                  Protocol fee is built into the contract. It starts at zero and scales with usage —
                  no off-chain billing needed.
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── How it Works — Sequence Diagram ── */}
      <section style={{ padding: '48px 24px' }}>
        <div style={{ maxWidth: 720, margin: '0 auto' }}>
          <h2 className="section-heading">How it Works</h2>
          <Mermaid
            className="seq-mermaid"
            chart={`sequenceDiagram
    participant U as User
    participant H as Host
    participant C as Chain

    Note over U: Query wallet & coins
    Note over U: Build PTB

    U->>H: POST /relay/prepare
    Note right of U: txKindBytes, senderAddress, settlementTokenType
    Note over H: Validate request, build transaction, dry-run cost
    H-->>U: txBytes, receiptId, nonce, cost

    Note over U: Sign TX (no SUI needed)

    U->>H: POST /relay/sponsor
    Note right of U: txBytes, userSignature, receiptId
    Note over H: Verify receipt, sponsor gas, submit final transaction
    H->>C: Submit sponsored TX
    Note over C: user action and settlement execute together
    H-->>U: digest, effects
`}
          />
        </div>
      </section>

      {/* ── Quick Start ── */}
      <section style={{ background: 'var(--bg-secondary)', padding: '48px 24px' }}>
        <div style={{ maxWidth: 720, margin: '0 auto' }}>
          <h2 className="section-heading">Quick Start</h2>
          <SyntaxHighlight
            code={`import { StelisSDK, DEEPBOOK_IDS } from '@stelis/sdk';
import { SuiGrpcClient } from '@mysten/sui/grpc';

// connect() auto-detects network from the Host.
const suiClient = new SuiGrpcClient({
  network: 'testnet',
  baseUrl: 'https://fullnode.testnet.sui.io:443',
});
const sdk = await StelisSDK.connect('https://relay.example.com/relay');

// sdk.network is resolved after connect ('testnet' | 'mainnet').
const result = await sdk.executeSponsored(tx, {
  client: suiClient,
  prepareAuthorizationSigner: async (messageBytes) => {
    const { signature } = await wallet.signPersonalMessage({ message: messageBytes });
    return signature;
  },
  signer: wallet.signTransaction,
  addr: userAddress,
  settlementToken: { type: DEEPBOOK_IDS[sdk.network]!.deepType },
});

console.log(result.digest);`}
            lang="ts"
            style={{ borderRadius: 10 }}
          />
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 12 }}>
            Five lines to sponsored. See the{' '}
            <Link to="/docs" style={{ color: '#6366f1', textDecoration: 'none', fontWeight: 600 }}>
              SDK Integration Guide
            </Link>{' '}
            for the full walkthrough.
          </p>
        </div>
      </section>

      {/* ── Footer ── */}
      <footer
        style={{
          borderTop: '1px solid var(--border)',
          padding: '32px 24px',
          textAlign: 'center',
          fontSize: 13,
          color: 'var(--text-muted)',
        }}
      >
        <div style={{ maxWidth: 720, margin: '0 auto' }}>
          Stelis — Gas abstraction infrastructure for Sui
        </div>
      </footer>
    </>
  );
}
export default HomePage;
