import { lazy, Suspense } from 'react';
import { Routes, Route } from 'react-router-dom';
import { NavBar } from './components/NavBar';
import { NetworkBadge } from './components/NetworkBadge';
import { useAppConfig } from './AppConfigContext';
import { APP_WEB_ENVIRONMENT } from './runtimeEnv';

const Home = lazy(() => import('./pages/Home'));
const Status = lazy(() => import('./pages/Status'));
const Docs = lazy(() => import('./pages/Docs'));
const Playground = lazy(() => import('./pages/Playground'));
const Sandbox = lazy(() => import('./pages/sandbox'));
const Promotion = lazy(() => import('./pages/promotion'));

/**
 * UI mode gate: 'studio' enables /promotion route + nav entry.
 * Default: 'relay' (public relay pages only — fail-closed).
 */
const isStudioMode = APP_WEB_ENVIRONMENT.uiMode === 'studio';

const BASE_LINKS = [
  { href: '/status', label: 'Status' },
  { href: '/docs', label: 'Docs' },
  { href: '/playground', label: 'Playground' },
  { href: '/sandbox', label: 'Sandbox' },
];

const NAV_LINKS = isStudioMode
  ? [...BASE_LINKS, { href: '/promotion', label: 'Promotion' }]
  : BASE_LINKS;

const spinnerStyle = {
  width: 32,
  height: 32,
  border: '3px solid rgba(99,102,241,0.15)',
  borderTopColor: '#6366f1',
  borderRadius: '50%',
  animation: 'spin .7s linear infinite',
} as const;

/**
 * ConfigGate — renders children only after /relay/config is loaded.
 *
 * Used to wrap routes that need `network` (Sandbox, Promotion).
 * Routes that don't need network (Home, Docs, Playground, Status)
 * are NOT gated and render immediately.
 */
function ConfigGate({ children }: { children: React.ReactNode }) {
  const { config, loading, error } = useAppConfig();

  if (loading) {
    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          alignItems: 'center',
          minHeight: '60vh',
          gap: 16,
        }}
      >
        <div style={spinnerStyle} />
        <span style={{ fontSize: 13, color: 'var(--text-secondary, #888)' }}>
          Connecting to Host...
        </span>
      </div>
    );
  }

  if (error || !config) {
    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          alignItems: 'center',
          minHeight: '60vh',
          gap: 16,
        }}
      >
        <div style={{ fontSize: 40 }}>⚠️</div>
        <div style={{ fontSize: 14, color: '#f87171', textAlign: 'center', maxWidth: 400 }}>
          Failed to load config from API
        </div>
        <div
          style={{
            fontSize: 12,
            color: 'var(--text-secondary, #888)',
            textAlign: 'center',
            maxWidth: 400,
            fontFamily: 'monospace',
          }}
        >
          {error ?? 'Unknown error'}
        </div>
        <button
          onClick={() => window.location.reload()}
          style={{
            padding: '8px 20px',
            borderRadius: 8,
            border: '1px solid rgba(99,102,241,0.4)',
            background: 'rgba(99,102,241,0.1)',
            color: '#818cf8',
            fontSize: 13,
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          Retry
        </button>
      </div>
    );
  }

  return <>{children}</>;
}

export default function App() {
  return (
    <>
      <NavBar links={NAV_LINKS} badge={<NetworkBadge />} />
      <Suspense
        fallback={
          <div
            style={{
              display: 'flex',
              justifyContent: 'center',
              alignItems: 'center',
              minHeight: '60vh',
            }}
          >
            <div style={spinnerStyle} />
          </div>
        }
      >
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/status" element={<Status />} />
          <Route path="/docs" element={<Docs />} />
          <Route path="/playground" element={<Playground />} />
          <Route
            path="/sandbox"
            element={
              <ConfigGate>
                <Sandbox />
              </ConfigGate>
            }
          />
          {isStudioMode && (
            <Route
              path="/promotion"
              element={
                <ConfigGate>
                  <Promotion />
                </ConfigGate>
              }
            />
          )}
        </Routes>
      </Suspense>
    </>
  );
}
