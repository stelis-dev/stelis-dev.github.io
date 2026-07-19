/**
 * AdminLayout — sidebar shell wrapping admin pages.
 */
import { useEffect, useState, useCallback, useRef } from 'react';
import { Outlet, useNavigate, useLocation, useOutletContext } from 'react-router-dom';
import { RenewModal } from './RenewModal';
import { getStudio, logoutAdminSession } from '../api/client';
import type { AuthContext } from './AuthGuard';
import type { AdminStudioResponse } from '@stelis/contracts';

const RENEW_WARNING_SECONDS = 60;
const RENEW_GRACE_SECONDS = 15;
const TICK_FAST_THRESHOLD = 90;

type StudioConfig = Extract<AdminStudioResponse, { enabled: true }>['config'];

export type StudioAvailability =
  | { readonly status: 'loading' }
  | { readonly status: 'available'; readonly config: StudioConfig }
  | { readonly status: 'unavailable' }
  | { readonly status: 'failed'; readonly error: string };

interface ActiveStudioRequest {
  readonly id: number;
  readonly controller: AbortController;
  readonly task: Promise<void>;
}

function formatRemaining(seconds: number): string {
  if (seconds <= 0) return 'Expired';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (seconds < 60) return `${seconds}s`;
  return `${m}m`;
}

export function AdminLayout() {
  const { session, refreshSession } = useOutletContext<AuthContext>();
  const navigate = useNavigate();
  const location = useLocation();

  const [remaining, setRemaining] = useState<string | null>(null);
  const [expAt, setExpAt] = useState<number | null>(session?.exp ?? null);
  const [showRenewModal, setShowRenewModal] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const isRenewingRef = useRef(false);
  const graceTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [fastTick, setFastTick] = useState(false);
  const [studioAvailability, setStudioAvailability] = useState<StudioAvailability>({
    status: 'loading',
  });
  const mountedRef = useRef(false);
  const nextStudioRequestIdRef = useRef(0);
  const activeStudioRequestRef = useRef<ActiveStudioRequest | null>(null);

  const refreshStudioAvailability = useCallback((): Promise<void> => {
    const active = activeStudioRequestRef.current;
    if (active !== null) return active.task;

    const id = ++nextStudioRequestIdRef.current;
    const controller = new AbortController();
    setStudioAvailability({ status: 'loading' });
    const task = getStudio(controller.signal)
      .then((response) => {
        if (!mountedRef.current || activeStudioRequestRef.current?.id !== id) return;
        setStudioAvailability(
          response.enabled
            ? { status: 'available', config: response.config }
            : { status: 'unavailable' },
        );
      })
      .catch((error: unknown) => {
        if (!mountedRef.current || activeStudioRequestRef.current?.id !== id) return;
        setStudioAvailability({
          status: 'failed',
          error: error instanceof Error ? error.message : 'Failed to load Studio availability',
        });
      })
      .finally(() => {
        if (activeStudioRequestRef.current?.id === id) activeStudioRequestRef.current = null;
      });
    activeStudioRequestRef.current = { id, controller, task };
    return task;
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void refreshStudioAvailability();
    return () => {
      mountedRef.current = false;
      const active = activeStudioRequestRef.current;
      activeStudioRequestRef.current = null;
      active?.controller.abort();
    };
  }, [refreshStudioAvailability]);

  // Sync session exp
  useEffect(() => {
    if (session?.exp) {
      setExpAt(session.exp);
      const left = session.exp - Math.floor(Date.now() / 1000);
      if (left > RENEW_WARNING_SECONDS) {
        setDismissed(false);
        setShowRenewModal(false);
      }
    }
  }, [session]);

  // Timer tick
  useEffect(() => {
    if (expAt === null) return;

    const tick = () => {
      const left = expAt - Math.floor(Date.now() / 1000);

      if (left <= 0) {
        if (isRenewingRef.current) {
          if (!graceTimeoutRef.current) {
            graceTimeoutRef.current = setTimeout(() => {
              navigate('/login', { replace: true });
            }, RENEW_GRACE_SECONDS * 1000);
          }
          setRemaining(formatRemaining(0));
          return;
        }
        navigate('/login', { replace: true });
        return;
      }

      setRemaining(formatRemaining(left));
      if (left <= TICK_FAST_THRESHOLD && !fastTick) setFastTick(true);
      if (left <= RENEW_WARNING_SECONDS && !dismissed && !showRenewModal) {
        setShowRenewModal(true);
      }
    };

    tick();
    const intervalMs = fastTick ? 1000 : 30_000;
    const interval = setInterval(tick, intervalMs);

    return () => {
      clearInterval(interval);
      if (graceTimeoutRef.current) {
        clearTimeout(graceTimeoutRef.current);
        graceTimeoutRef.current = null;
      }
    };
  }, [expAt, dismissed, showRenewModal, fastTick, navigate]);

  const handleRenewSuccess = useCallback(() => {
    setShowRenewModal(false);
    setDismissed(false);
    setFastTick(false);
    isRenewingRef.current = false;
    if (graceTimeoutRef.current) {
      clearTimeout(graceTimeoutRef.current);
      graceTimeoutRef.current = null;
    }
    void refreshSession();
  }, [refreshSession]);

  const handleDismiss = useCallback(() => {
    setShowRenewModal(false);
    setDismissed(true);
  }, []);

  const handleLogout = useCallback(async () => {
    try {
      await logoutAdminSession();
    } catch {
      /* ignore */
    }
    navigate('/login', { replace: true });
  }, [navigate]);

  const navItems = [
    { path: '/dashboard', label: 'Dashboard' },
    ...(studioAvailability.status === 'available'
      ? [{ path: '/promotions', label: 'Promotions' }]
      : []),
    { path: '/sponsored-logs', label: 'Sponsored Logs' },
    { path: '/security', label: 'Security' },
    { path: '/config', label: 'Config' },
  ];

  return (
    <div className="admin-root">
      <div className="admin-shell">
        <aside className="admin-sidebar">
          <div className="admin-sidebar-brand">
            <span>Stelis Admin</span>
          </div>
          <nav className="admin-nav">
            {navItems.map((item) => (
              <a
                key={item.path}
                href={item.path}
                className={`admin-nav-item${location.pathname === item.path ? ' active' : ''}`}
                onClick={(e) => {
                  e.preventDefault();
                  navigate(item.path);
                }}
              >
                <span>{item.label}</span>
              </a>
            ))}
          </nav>
          <div className="admin-sidebar-footer">
            {remaining !== null && (
              <div
                style={{ fontSize: 12, color: '#64748b', marginBottom: 10, textAlign: 'center' }}
              >
                Session:{' '}
                <span
                  style={{
                    color: remaining === 'Expired' ? '#f87171' : '#94a3b8',
                    fontFamily: "'JetBrains Mono', monospace",
                  }}
                >
                  {remaining}
                </span>
              </div>
            )}
            <button type="button" className="admin-logout-btn" onClick={() => void handleLogout()}>
              Sign out
            </button>
          </div>
        </aside>
        <main className="admin-main">
          <Outlet
            context={{
              session,
              refreshSession,
              studioAvailability,
              refreshStudioAvailability,
            }}
          />
        </main>

        {showRenewModal && expAt !== null && session?.address && (
          <RenewModal
            expAt={expAt}
            address={session.address}
            onSuccess={handleRenewSuccess}
            onDismiss={handleDismiss}
            onRenewStart={() => {
              isRenewingRef.current = true;
            }}
            onRenewEnd={() => {
              isRenewingRef.current = false;
            }}
          />
        )}
      </div>
    </div>
  );
}

export type AdminLayoutContext = AuthContext & {
  studioAvailability: StudioAvailability;
  refreshStudioAvailability: () => Promise<void>;
};
