import { Link } from 'react-router-dom';
import { SyntaxHighlight } from '../components/SyntaxHighlight';
import { Mermaid } from '../components/Mermaid';

const rawRepoDocsBaseUrl = (import.meta.env.VITE_REPO_DOCS_BASE_URL || '').trim();
const REPO_DOCS_BASE_URL = rawRepoDocsBaseUrl ? rawRepoDocsBaseUrl.replace(/\/$/, '') : null;

const API_DOC_URL = REPO_DOCS_BASE_URL ? `${REPO_DOCS_BASE_URL}/docs/api.md` : null;
const INTEGRATION_DOC_URL = REPO_DOCS_BASE_URL ? `${REPO_DOCS_BASE_URL}/docs/integration.md` : null;
const SDK_README_URL = REPO_DOCS_BASE_URL ? `${REPO_DOCS_BASE_URL}/packages/sdk/README.md` : null;
const PAYMENT_PLATFORM_DOC_URL = REPO_DOCS_BASE_URL
  ? `${REPO_DOCS_BASE_URL}/docs/payment-platform.md#product-family-terms`
  : null;

interface EndpointOverview {
  method: 'GET' | 'POST';
  path: string;
  desc: string;
  detail: string;
  highlights: string[];
  docHref: string | null;
}

interface DocsBoundary {
  title: string;
  desc: string;
  links: Array<{ label: string; href: string | null }>;
}

const endpoints: EndpointOverview[] = [
  {
    method: 'GET',
    path: '/relay/status',
    desc: 'Health check',
    detail:
      'Use this to verify that the relay host is responsive before attempting integration or sandbox flows.',
    highlights: [
      'Minimal success payload: { ok: true }',
      'Good first probe for CI smoke checks and operational dashboards',
    ],
    docHref: `${API_DOC_URL}#get-relay-status`,
  },
  {
    method: 'GET',
    path: '/relay/config',
    desc: 'Network config and supported settlement swap paths',
    detail:
      'The SDK calls this during connect() to fetch network metadata, settlement swap path support, and integrity-handshake fields.',
    highlights: [
      'Returns packageId, settlementPayoutRecipient payout address, supportedSettlementSwapPaths, quoted fee fields, and integrityPolicyVersion',
      'Use this before constructing production client assumptions',
    ],
    docHref: `${API_DOC_URL}#get-relay-config`,
  },
  {
    method: 'POST',
    path: '/relay/prepare',
    desc: 'Build sponsored txBytes and quote cost',
    detail:
      'Prepare performs dry-run pricing, issues a one-time receiptId and monotonic nonce, and returns the txBytes that the user must sign.',
    highlights: [
      'Required body: txKindBytes, senderAddress, settlementTokenType',
      'Optional body: slippageBps, gasMarginBps, orderId',
      'Dry-run rejections return 422 domain codes such as DRY_RUN_FAILED and DRY_RUN_NO_GAS',
    ],
    docHref: `${API_DOC_URL}#post-relay-prepare`,
  },
  {
    method: 'POST',
    path: '/relay/sponsor',
    desc: 'Validate, sponsor-sign, and submit',
    detail:
      'Sponsor consumes the prepared receipt, hash-binds txBytes, re-validates the transaction, adds the sponsor signature, and submits it on-chain.',
    highlights: [
      'Required body: txBytes, userSignature, receiptId',
      'Post-consume drift returns REPREPARE_REQUIRED instead of exposing generic L2_* codes',
    ],
    docHref: `${API_DOC_URL}#post-relay-sponsor`,
  },
];

const docsBoundaries: DocsBoundary[] = [
  {
    title: 'API Route Reference',
    desc: 'The exact request, response, and error definitions live in docs/api.md. This page is a routing page, not a duplicate reference.',
    links: [
      { label: 'Open docs/api.md', href: API_DOC_URL },
      { label: 'Open docs/integration.md', href: INTEGRATION_DOC_URL },
    ],
  },
  {
    title: 'SDK Consumer Path',
    desc: 'If you only consume an existing relay, start in the SDK README and then move into integration.md before touching raw endpoints.',
    links: [{ label: 'Open packages/sdk/README.md', href: SDK_README_URL }],
  },
];

const integrationSteps = [
  {
    title: '1. Install the SDK',
    code: `npm install @stelis/sdk`,
    desc: 'The SDK handles config resolution, sponsored PTB construction, and the full prepare/sponsor flow.',
  },
  {
    title: '2. Connect to the relay host',
    code: `import { StelisSDK } from '@stelis/sdk';

// connect() auto-detects network from the relay host.
const sdk = await StelisSDK.connect('https://your-relayer/relay');

// sdk.network exposes 'testnet' | 'mainnet'.
console.log(sdk.network);`,
    desc: 'connect() probes /relay/status and /relay/config, then resolves the network automatically.',
  },
  {
    title: '3. Build your intent PTB',
    code: `import { Transaction } from '@mysten/sui/transactions';

const tx = new Transaction();
// Add only your business logic Move calls here.
// The SDK appends the settlement step and runs the relay flow.`,
    desc: 'Keep the PTB focused on business intent. Gas abstraction and sponsor flow stay in the SDK layer.',
  },
  {
    title: '4. Execute through the sponsored relay',
    code: `const result = await sdk.executeSponsored(tx, {
  client,
  addr: userAddress,
  settlementToken: { type: DEEPBOOK_IDS[sdk.network]!.deepType },
  prepareAuthorizationSigner: async (messageBytes) => {
    const { signature } = await wallet.signPersonalMessage({ message: messageBytes });
    return signature;
  },
  signer: async (txBytes) => {
    const { signature } = await wallet.signTransaction({ transaction: txBytes });
    return signature;
  },
  onGasEstimate: (amount, amountHuman, symbol) => {
    console.log('Gas cost:', amount, amountHuman, symbol);
  },
});

console.log(result.digest);`,
    desc: 'executeSponsored() wraps prepare -> sign -> sponsor. Dry-run failures come back as 422 domain codes, not generic 500s.',
  },
];

export function DocsPage() {
  return (
    <div className="page">
      <section style={{ maxWidth: 960, margin: '0 auto', padding: '0 24px 32px' }}>
        <h2 style={{ fontSize: 18, marginBottom: 12, color: 'var(--text-primary)' }}>
          Flow Overview
        </h2>
        <p
          style={{
            color: 'var(--text-secondary)',
            fontSize: 14,
            lineHeight: 1.7,
            marginBottom: 20,
          }}
        >
          This page provides a quick route through the relay API endpoints. The API route reference
          lives in <code>docs/api.md</code>; use this page for flow orientation, representative
          examples, and links into the exact route reference.
        </p>
        <p
          style={{
            color: 'var(--text-secondary)',
            fontSize: 14,
            lineHeight: 1.7,
            marginBottom: 20,
          }}
        >
          Definitions of <code>Hosted relay</code>, <code>Studio</code>, <code>Host</code>,{' '}
          <code>relay host</code>, and <code>relayer</code> live in{' '}
          {PAYMENT_PLATFORM_DOC_URL ? (
            <a href={PAYMENT_PLATFORM_DOC_URL} target="_blank" rel="noreferrer">
              docs/payment-platform.md → Product Family Terms
            </a>
          ) : (
            <code>docs/payment-platform.md</code>
          )}
          .
        </p>

        <h3 style={{ fontSize: 14, marginBottom: 8, color: 'var(--text-secondary)' }}>
          SDK Integration
        </h3>
        <Mermaid
          className="seq-mermaid"
          chart={`sequenceDiagram
    participant W as Wallet
    participant App
    participant SDK
    participant R as Relayer

    App->>SDK: connect(endpoint)
    SDK->>R: /relay/status -> /relay/config
    App->>App: Build PTB
    App->>SDK: executeSponsored()
    SDK->>R: POST /relay/prepare
    R-->>SDK: txBytes, receiptId, nonce, cost
    SDK->>App: request signature
    App->>W: Sign txBytes
    W-->>App: signature
    App-->>SDK: signature
    SDK->>R: POST /relay/sponsor
    Note over R: consume/hash-bind + fresh L1/L2 + gasOwner + new-user vault check + L4/L3 + sponsor-sign
    R-->>SDK: digest, effects
`}
        />

        <h3 style={{ fontSize: 14, margin: '24px 0 8px', color: 'var(--text-secondary)' }}>
          Cost Breakdown
        </h3>
        <Mermaid
          className="seq-mermaid"
          chart={`flowchart LR
    A[computation + storage - rebate] --> B[simGas]
    C[GAS_VARIANCE_FIXED_MIST] --> D[gasVarianceFixedMist]
    E[measured slippage buffer] --> F[slippageBufferMist]
    B --> G[executionCostClaim]
    D --> G
    F --> G
    G --> H[relayer_payout]
    I[quotedHostFeeMist] --> H
    H --> J[total_deduction]
    K[protocol_fee] --> J
`}
        />
        <p
          style={{
            color: 'var(--text-secondary)',
            fontSize: 13,
            lineHeight: 1.7,
            marginTop: 12,
          }}
        >
          The claim ceiling itself comes from on-chain <code>Config.max_claim_mist</code>. The Move
          package initializes that field from <code>INITIAL_MAX_CLAIM_MIST</code> and allows admin
          updates up to <code>MAX_CLAIM_MIST</code>. The exact live value depends on the deployed
          host&apos;s on-chain config, and the symbol values are owned by{' '}
          <code>docs/parameters.md</code>.
        </p>
      </section>

      <section style={{ maxWidth: 960, margin: '0 auto', padding: '0 24px 8px' }}>
        <h2 style={{ fontSize: 20, fontWeight: 700, marginBottom: 12 }}>Reference Links</h2>
        <div style={{ display: 'grid', gap: 16 }}>
          {docsBoundaries.map((item) => (
            <div
              key={item.title}
              style={{
                border: '1px solid var(--border)',
                borderRadius: 12,
                padding: '16px 18px',
                background: 'rgba(255,255,255,0.03)',
              }}
            >
              <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 8 }}>{item.title}</div>
              <p
                style={{ color: 'var(--text-secondary)', fontSize: 13, lineHeight: 1.7, margin: 0 }}
              >
                {item.desc}
              </p>
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 12 }}>
                {item.links
                  .filter((link): link is { label: string; href: string } => link.href !== null)
                  .map((link) => (
                    <a
                      key={link.href}
                      href={link.href}
                      target="_blank"
                      rel="noreferrer"
                      style={{
                        color: '#6366f1',
                        textDecoration: 'none',
                        fontWeight: 600,
                        fontSize: 13,
                      }}
                    >
                      {link.label}
                    </a>
                  ))}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section style={{ maxWidth: 960, margin: '0 auto', padding: '24px 24px 0' }}>
        <h2 style={{ fontSize: 20, fontWeight: 700, marginBottom: 16 }}>Endpoint Overview</h2>
        <div className="endpoint-list">
          {endpoints.map((ep) => (
            <details key={ep.path} className="endpoint-card">
              <summary className="endpoint-header">
                <span className={`method-badge ${ep.method.toLowerCase()}`}>{ep.method}</span>
                <span className="endpoint-path">{ep.path}</span>
                <span className="endpoint-desc">{ep.desc}</span>
                <span className="endpoint-toggle">▼</span>
              </summary>
              <div className="endpoint-body">
                <p
                  style={{
                    fontSize: 13,
                    color: 'var(--text-secondary)',
                    marginBottom: 16,
                    lineHeight: 1.7,
                  }}
                >
                  {ep.detail}
                </p>
                <ul
                  style={{
                    margin: '0 0 16px 18px',
                    color: 'var(--text-secondary)',
                    lineHeight: 1.8,
                  }}
                >
                  {ep.highlights.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
                <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                  {ep.docHref && (
                    <a
                      href={ep.docHref}
                      target="_blank"
                      rel="noreferrer"
                      style={{
                        color: '#6366f1',
                        textDecoration: 'none',
                        fontWeight: 600,
                        fontSize: 13,
                      }}
                    >
                      Open route reference
                    </a>
                  )}
                  {ep.path.startsWith('/relay/') && (
                    <Link
                      to="/playground"
                      style={{
                        color: 'var(--text-secondary)',
                        textDecoration: 'none',
                        fontWeight: 600,
                        fontSize: 13,
                      }}
                    >
                      Try in Playground
                    </Link>
                  )}
                </div>
              </div>
            </details>
          ))}
        </div>
      </section>

      <div className="docs-callout" style={{ marginTop: 32 }}>
        <strong>Common error shape</strong>
        <code className="docs-callout-code">
          {'{ "error": "<message>", "code": "<ERROR_CODE>" }'}
        </code>
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          All relay endpoints use this shape. See <code>docs/api.md</code> for the full error code
          reference.
        </span>
      </div>

      <div style={{ marginTop: 48 }}>
        <h2 style={{ fontSize: 20, fontWeight: 700, marginBottom: 8 }}>SDK Integration Guide</h2>
        <p
          style={{
            color: 'var(--text-secondary)',
            fontSize: 14,
            marginBottom: 24,
            lineHeight: 1.7,
          }}
        >
          <code>@stelis/sdk</code> wraps the raw API calls into a single execution interface. Start
          here for the happy path, then verify the exact contract in <code>docs/api.md</code> before
          shipping.
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          {integrationSteps.map((step) => (
            <div
              key={step.title}
              style={{ border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden' }}
            >
              <div
                style={{
                  padding: '12px 16px',
                  background: 'rgba(255,255,255,0.04)',
                  borderBottom: '1px solid var(--border)',
                  fontWeight: 600,
                  fontSize: 14,
                }}
              >
                {step.title}
              </div>
              <SyntaxHighlight
                code={step.code}
                lang={step.title.startsWith('1.') ? 'sh' : 'ts'}
                style={{ background: 'rgba(0,0,0,0.35)', borderRadius: '0 0 8px 8px' }}
              />
              <div style={{ padding: '10px 16px', fontSize: 13, color: 'var(--text-secondary)' }}>
                {step.desc}
              </div>
            </div>
          ))}
        </div>

        <div
          style={{
            marginTop: 24,
            padding: '14px 18px',
            background: 'rgba(99,102,241,0.08)',
            border: '1px solid rgba(99,102,241,0.3)',
            borderRadius: 10,
            fontSize: 13,
            color: 'var(--text-secondary)',
            lineHeight: 1.7,
          }}
        >
          Continue with the{' '}
          <Link to="/sandbox" style={{ color: '#6366f1', textDecoration: 'none', fontWeight: 600 }}>
            Sandbox
          </Link>{' '}
          for the full wallet flow or{' '}
          <Link
            to="/playground"
            style={{ color: '#6366f1', textDecoration: 'none', fontWeight: 600 }}
          >
            Playground
          </Link>{' '}
          for direct endpoint testing.
          {API_DOC_URL && (
            <>
              {' '}
              For exact field and error semantics, open{' '}
              <a
                href={API_DOC_URL ?? undefined}
                target="_blank"
                rel="noreferrer"
                style={{ color: '#6366f1', textDecoration: 'none', fontWeight: 600 }}
              >
                docs/api.md
              </a>
              .
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default DocsPage;
