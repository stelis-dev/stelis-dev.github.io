import { useState } from 'react';

interface ConnectionPanelProps {
  endpoint: string;
  connected: boolean;
  connecting: boolean;
  error: string | null;
  onConnect: (endpoint: string) => void;
  onDisconnect: () => void;
}

export function ConnectionPanel({
  endpoint,
  connected,
  connecting,
  error,
  onConnect,
  onDisconnect,
}: ConnectionPanelProps) {
  const [inputUrl, setInputUrl] = useState(endpoint || '');

  return (
    <div className="promo-panel">
      <h3 className="promo-panel-title">🔗 Studio Endpoint</h3>
      <p className="promo-panel-desc">
        Connect to a Studio-enabled Host. The SDK will use <code>studioEndpoint: true</code> for
        developer JWT support.
      </p>

      <div className="promo-input-group">
        <label className="promo-label">Host Relay API URL</label>
        <input
          type="url"
          value={inputUrl}
          onChange={(e) => setInputUrl(e.target.value)}
          placeholder="http://localhost:3200/relay"
          disabled={connecting || connected}
          className="promo-input"
        />
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        {!connected ? (
          <button
            onClick={() => onConnect(inputUrl.trim())}
            disabled={!inputUrl.trim() || connecting}
            className="promo-btn promo-btn-primary"
          >
            {connecting ? '⏳ Connecting...' : '🔌 Connect'}
          </button>
        ) : (
          <button onClick={onDisconnect} className="promo-btn promo-btn-outline">
            ✕ Disconnect
          </button>
        )}
      </div>

      {connected && <div className="promo-status promo-status-ok">✅ Connected to {endpoint}</div>}
      {error && <div className="promo-status promo-status-error">❌ {error}</div>}
    </div>
  );
}
