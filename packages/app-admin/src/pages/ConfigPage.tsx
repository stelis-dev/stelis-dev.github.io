/**
 * ConfigPage — Host and Studio configuration.
 *
 * Section order (by operator priority):
 * §1: Sponsor Operations — refill controls and thresholds
 * §2: Fee Config — host + on-chain fee parameters
 * §3: Studio Settings — developer-verification configuration
 * §4: Supported Settlement Swap Paths — settlement token settlement
 * §5: On-chain IDs — contract reference (rarely changes)
 *
 */
import { useEffect, useState } from 'react';
import { getSponsorOperations, getStudio } from '../api/client';
import type { AdminSponsorOperationsResponse, AdminStudioResponse } from '@stelis/contracts';
import { mistToSui, truncateId, CopyButton } from '../utils';

function SuiAmount({ mist }: { mist: string }) {
  return (
    <div style={{ fontFamily: 'monospace' }}>
      <div>{mistToSui(mist)} SUI</div>
      <div style={{ color: '#64748b', fontSize: 11 }}>{mist} MIST</div>
    </div>
  );
}

function formatBpsPercent(bps: number): string {
  if (!Number.isSafeInteger(bps) || bps < 0 || bps > 10_000) return 'invalid';
  const whole = Math.floor(bps / 100);
  const frac = String(bps % 100).padStart(2, '0');
  return `${whole}.${frac}%`;
}

export function ConfigPage() {
  const [data, setData] = useState<AdminSponsorOperationsResponse | null>(null);
  const [studioStatus, setStudioStatus] = useState<AdminStudioResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  async function poll() {
    try {
      const [sponsorOperationsJson, studioJson] = await Promise.all([
        getSponsorOperations(),
        getStudio(),
      ]);
      setData(sponsorOperationsJson);
      setStudioStatus(studioJson);
      setLastUpdated(new Date());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load config');
    }
  }

  useEffect(() => {
    void poll();
  }, []);

  return (
    <div className="admin-page">
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 4 }}>
        <h1 className="admin-page-title" style={{ marginBottom: 0 }}>
          Config
        </h1>
        <button
          className="admin-btn admin-btn-primary"
          style={{ marginLeft: 'auto' }}
          onClick={() => void poll()}
        >
          Refresh
        </button>
      </div>
      <p className="admin-page-sub">
        {lastUpdated ? `Last updated: ${lastUpdated.toLocaleTimeString()}` : 'Loading…'}
        {data && (
          <span style={{ marginLeft: 12 }}>
            <span
              style={{
                display: 'inline-block',
                padding: '2px 8px',
                borderRadius: 6,
                fontSize: 11,
                fontWeight: 600,
                background: 'rgba(99,102,241,0.15)',
                color: '#818cf8',
              }}
            >
              {data.network}
            </span>
          </span>
        )}
      </p>

      {error && <p style={{ color: '#f87171' }}>{error}</p>}

      {/* ═══════════════ §1: Sponsor Operations ═══════════════ */}
      {data && (
        <div className="admin-card">
          <div className="admin-card-title">Sponsor Operations</div>
          <table className="admin-table">
            <tbody>
              <tr>
                <td
                  style={{ cursor: 'help' }}
                  title="Sponsor Refill Account automatically sends SUI to sponsor slots when balance drops below threshold (env: SPONSOR_OPERATIONS_REFILL_ENABLED)"
                >
                  Refill
                </td>
                <td style={{ textAlign: 'right' }}>
                  <span
                    style={{ color: data.refillEnabled ? '#22c55e' : '#64748b', fontWeight: 600 }}
                  >
                    {data.refillEnabled ? 'Enabled' : 'Disabled'}
                  </span>
                </td>
              </tr>
              <tr>
                <td
                  style={{ cursor: 'help' }}
                  title="Sponsor addresses with a fresh balance observation below this value are classified `low_balance` when SponsorOperations status is calculated and become refill candidates (env: SPONSOR_BALANCE_WARN_MIST)"
                >
                  Low-balance Threshold
                </td>
                <td style={{ textAlign: 'right' }}>
                  <SuiAmount mist={data.sponsorBalanceWarnMist} />
                </td>
              </tr>
              <tr>
                <td
                  style={{ cursor: 'help' }}
                  title="Target balance for refill — shortfall = target - current balance (env: SPONSOR_BALANCE_REFILL_TARGET_MIST)"
                >
                  Refill Target
                </td>
                <td style={{ textAlign: 'right' }}>
                  {data.sponsorBalanceRefillTargetMist === null ? (
                    <span style={{ color: '#64748b' }}>Not configured</span>
                  ) : (
                    <SuiAmount mist={data.sponsorBalanceRefillTargetMist} />
                  )}
                </td>
              </tr>
              <tr>
                <td
                  style={{ cursor: 'help' }}
                  title="Minimum Sponsor Refill Account balance retained per configured sponsor address after a refill or withdrawal"
                >
                  Minimum Balance per Sponsor
                </td>
                <td style={{ textAlign: 'right' }}>
                  <SuiAmount mist={data.sponsorRefillAccountRunwayTargetMist} />
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      )}

      {/* ═══════════════ §2: Fee Config ═══════════════ */}
      {data?.feeConfig && (
        <div className="admin-card">
          <div className="admin-card-title">Fee Config</div>
          <table className="admin-table">
            <tbody>
              <tr>
                <td
                  colSpan={2}
                  style={{
                    fontSize: 11,
                    fontWeight: 600,
                    color: '#64748b',
                    textTransform: 'uppercase',
                    letterSpacing: '0.05em',
                  }}
                >
                  Host Fee Settings
                </td>
              </tr>
              <tr>
                <td
                  style={{ cursor: 'help' }}
                  title="Fee charged by the Host per sponsored transaction. Added to user's settlement token cost (env: HOST_FEE_MIST)"
                >
                  Host Fee
                </td>
                <td style={{ textAlign: 'right' }}>
                  <SuiAmount mist={data.quotedHostFeeMist} />
                </td>
              </tr>
              <tr>
                <td
                  colSpan={2}
                  style={{
                    fontSize: 11,
                    fontWeight: 600,
                    color: '#64748b',
                    paddingTop: 16,
                    textTransform: 'uppercase',
                    letterSpacing: '0.05em',
                  }}
                >
                  On-chain Limits
                </td>
              </tr>
              <tr>
                <td
                  style={{ cursor: 'help' }}
                  title="On-chain maximum host fee. Transactions exceeding this cap are rejected by the contract"
                >
                  Host Fee Cap
                </td>
                <td style={{ textAlign: 'right' }}>
                  <SuiAmount mist={data.feeConfig.maxHostFeeMist} />
                </td>
              </tr>
              <tr>
                <td
                  style={{ cursor: 'help' }}
                  title="Fixed protocol fee deducted on-chain per transaction. Revenue for the protocol treasury"
                >
                  Protocol Flat Fee
                </td>
                <td style={{ textAlign: 'right' }}>
                  <SuiAmount mist={data.feeConfig.protocolFlatFeeMist} />
                </td>
              </tr>
              <tr>
                <td
                  style={{ cursor: 'help' }}
                  title="Maximum execution-cost claim that one settlement transaction may recover"
                >
                  Max Claim
                </td>
                <td style={{ textAlign: 'right' }}>
                  <SuiAmount mist={data.feeConfig.maxClaimMist} />
                </td>
              </tr>
              <tr>
                <td
                  style={{ cursor: 'help' }}
                  title="Minimum SUI input for token-funded settlement; credit-only settlement is exempt"
                >
                  Min Settle
                </td>
                <td style={{ textAlign: 'right' }}>
                  <SuiAmount mist={data.feeConfig.minSettleMist} />
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      )}

      {/* ═══════════════ §3: Studio Settings ═══════════════ */}
      {studioStatus && (
        <>
          <div
            style={{
              marginTop: 32,
              marginBottom: 16,
              display: 'flex',
              alignItems: 'center',
              gap: 10,
            }}
          >
            <span
              style={{
                display: 'inline-block',
                width: 10,
                height: 10,
                borderRadius: '50%',
                background: '#a78bfa',
                boxShadow: '0 0 8px rgba(167,139,250,0.5)',
              }}
            />
            <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: '#a78bfa' }}>
              Studio Settings
            </h2>
          </div>

          <div className="admin-card">
            <div className="admin-card-title">Studio Config</div>
            <table className="admin-table">
              <tbody>
                <tr>
                  <td
                    style={{ cursor: 'help' }}
                    title="STUDIO_DEVELOPER_JWT_VERIFY_URL env status. Optional callback for additional developer JWT verification"
                  >
                    Verify URL
                  </td>
                  <td>
                    <span
                      style={{
                        color: studioStatus.config.developerJwtVerifyUrlConfigured
                          ? '#22c55e'
                          : '#64748b',
                        fontWeight: 600,
                      }}
                    >
                      {studioStatus.config.developerJwtVerifyUrlConfigured
                        ? '● Configured'
                        : '○ Not set (optional)'}
                    </span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* ═══════════════ §4: Supported Settlement Swap Paths ═══════════════ */}
      {data?.supportedSettlementSwapPaths && data.supportedSettlementSwapPaths.length > 0 && (
        <div className="admin-card">
          <div className="admin-card-title">Supported Settlement Swap Paths</div>
          <table className="admin-table">
            <thead>
              <tr>
                <th title="Settlement token symbol">Token</th>
                <th title="Settlement swap path through DeepBook pools to convert to SUI">Path</th>
                <th title="Stelis input-fee basis for DeepBook execution. 0% = whitelisted pool (no fee)">
                  DeepBook Fee
                </th>
                <th style={{ textAlign: 'right' }} title="Full Sui Move coin type identifier">
                  Coin Type
                </th>
              </tr>
            </thead>
            <tbody>
              {data.supportedSettlementSwapPaths.map((p) => {
                const symbol = p.settlementTokenSymbol;
                const hopCount = p.hops.length;
                const midSymbol =
                  hopCount >= 2
                    ? ((p.hops[0].swapDirection === 'quoteForBase'
                        ? p.hops[0].baseType
                        : p.hops[0].quoteType
                      )
                        .split('::')
                        .pop() ?? '?')
                    : null;
                const swapPath =
                  hopCount === 1 ? `${symbol} → SUI` : `${symbol} → ${midSymbol} → SUI`;
                return (
                  <tr key={p.settlementTokenType}>
                    <td style={{ fontWeight: 600 }}>{symbol}</td>
                    <td style={{ color: '#94a3b8' }}>{swapPath}</td>
                    <td
                      style={{
                        color: p.effectiveFeeRateBps === 0 ? '#22c55e' : '#f59e0b',
                        fontWeight: 600,
                      }}
                    >
                      {p.effectiveFeeRateBps === 0
                        ? '0% (whitelisted)'
                        : `${formatBpsPercent(p.effectiveFeeRateBps)} input-fee`}
                    </td>
                    <td
                      style={{
                        fontFamily: 'monospace',
                        fontSize: 11,
                        color: '#64748b',
                        textAlign: 'right',
                      }}
                      title={p.settlementTokenType}
                    >
                      {(() => {
                        const parts = p.settlementTokenType.split('::');
                        if (parts.length >= 3) {
                          const pkg = parts[0];
                          return `${pkg.length > 14 ? `${pkg.slice(0, 8)}…${pkg.slice(-4)}` : pkg}::${parts.slice(1).join('::')}`;
                        }
                        return p.settlementTokenType;
                      })()}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* ═══════════════ §5: On-chain IDs ═══════════════ */}
      {data && (
        <div className="admin-card">
          <div className="admin-card-title">On-chain IDs</div>
          <table className="admin-table">
            <tbody>
              {[
                [
                  'STELIS_PACKAGE_ID',
                  data.onChainIds.packageId,
                  'Published Move package ID for Stelis contracts',
                ] as const,
                [
                  'STELIS_CONFIG_ID',
                  data.onChainIds.configId,
                  'Shared Config object — fee params, protocol state',
                ] as const,
                [
                  'STELIS_VAULT_REGISTRY_ID',
                  data.onChainIds.vaultRegistryId,
                  'Vault registry for sponsor claim/settle operations',
                ] as const,
                [
                  'DEEPBOOK_PACKAGE_ID',
                  data.onChainIds.deepbookPackageId,
                  'DeepBook v3 package ID for settlement swap execution',
                ] as const,
              ].map(([label, value, tooltip]) => (
                <tr key={label}>
                  <td
                    style={{ fontSize: 12, color: '#94a3b8', width: 240, cursor: 'help' }}
                    title={tooltip}
                  >
                    {label}
                  </td>
                  <td
                    style={{ fontFamily: 'monospace', fontSize: 12, textAlign: 'right' }}
                    title={value ?? undefined}
                  >
                    {truncateId(value)} {value && <CopyButton value={value} />}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
