import { lazy, Suspense, useState, useCallback } from 'react';
import { useStudioSDK } from './hooks/useStudioSDK';
import { ConnectionPanel } from './components/ConnectionPanel';
import { DeveloperJwtPanel } from './components/DeveloperJwtPanel';
import { DebugPanel, type DebugEntry } from './components/DebugPanel';
import { WalletProvider } from '../sandbox/components/WalletProvider';

const StudioExecutionPanel = lazy(() =>
  import('./components/StudioExecutionPanel').then((m) => ({ default: m.StudioExecutionPanel })),
);

/**
 * PromotionPage — studio promotion-sponsored execution test page.
 *
 * NOT a marketing UI. Purpose: end-to-end verification of the
 * Developer JWT → `/studio/promotions/:id/prepare` → sign →
 * `/studio/promotions/:id/sponsor` flow. The page is
 * debug-oriented: every request/response is dumped into the
 * `DebugPanel` for manual inspection.
 */
export function PromotionPage() {
  const studio = useStudioSDK();
  const [developerJwt, setDeveloperJwt] = useState('');
  const [promotionId, setPromotionId] = useState('');
  const [debugEntries, setDebugEntries] = useState<DebugEntry[]>([]);

  const addDebugEntry = useCallback((entry: DebugEntry) => {
    setDebugEntries((prev) => [...prev, entry]);
  }, []);

  return (
    <div className="page">
      <h1 className="page-title">Studio Promotion</h1>
      <p className="page-subtitle">
        End-to-end test page for promotion-sponsored execution. Connect to a Host, configure your
        JWT and Promotion ID, and execute against its Studio routes.
      </p>

      <div className="promo-layout">
        {/* Left column: configuration */}
        <div className="promo-config-col">
          <ConnectionPanel
            endpoint={studio.endpoint}
            connected={!!studio.sdk}
            connecting={studio.connecting}
            error={studio.error}
            onConnect={studio.connect}
            onDisconnect={studio.disconnect}
          />

          <DeveloperJwtPanel jwt={developerJwt} onJwtChange={setDeveloperJwt} />

          {/* Promotion ID input */}
          <div className="promo-panel">
            <h3 className="promo-panel-title">🎯 Promotion ID</h3>
            <div className="promo-input-group">
              <label className="promo-label">promotionId (required)</label>
              <input
                type="text"
                className="promo-input"
                placeholder="Promotion ID returned by the Host"
                value={promotionId}
                onChange={(e) => setPromotionId(e.target.value)}
              />
            </div>
          </div>

          <WalletProvider>
            <Suspense
              fallback={
                <div
                  className="promo-panel"
                  style={{ padding: 24, color: 'var(--text-secondary)' }}
                >
                  Loading wallet components...
                </div>
              }
            >
              <StudioExecutionPanel
                sdk={studio.sdk}
                developerJwt={developerJwt}
                promotionId={promotionId}
                onDebugEntry={addDebugEntry}
              />
            </Suspense>
          </WalletProvider>
        </div>

        {/* Right column: debug log */}
        <div className="promo-debug-col">
          <DebugPanel entries={debugEntries} />
        </div>
      </div>
    </div>
  );
}

export default PromotionPage;
