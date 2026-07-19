/**
 * AuthGuard — protects admin routes.
 *
 * Checks /auth/session on mount and tab focus.
 * Redirects to /login on 401 or missing session.
 * Renders <Outlet /> when authenticated.
 */
import { useEffect, useState, useCallback } from 'react';
import { Outlet, useNavigate } from 'react-router-dom';
import { getSession, ApiError } from '../api/client';
import type { AdminSessionResponse } from '@stelis/contracts';

export function AuthGuard() {
  const navigate = useNavigate();
  const [session, setSession] = useState<AdminSessionResponse | null>(null);
  const [loading, setLoading] = useState(true);

  const checkSession = useCallback(async () => {
    try {
      const s = await getSession();
      setSession(s);
      setLoading(false);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        navigate('/login', { replace: true });
      } else {
        // Network error or unexpected — still redirect
        navigate('/login', { replace: true });
      }
    }
  }, [navigate]);

  useEffect(() => {
    void checkSession();
  }, [checkSession]);

  // Re-check on tab focus
  useEffect(() => {
    const handler = () => {
      if (document.visibilityState === 'visible') {
        void checkSession();
      }
    };
    document.addEventListener('visibilitychange', handler);
    return () => document.removeEventListener('visibilitychange', handler);
  }, [checkSession]);

  if (loading) {
    return (
      <div className="auth-loading">
        <div className="auth-loading-spinner" />
      </div>
    );
  }

  if (!session) return null;

  return <Outlet context={{ session, refreshSession: checkSession }} />;
}

export type AuthContext = {
  session: AdminSessionResponse;
  refreshSession: () => Promise<void>;
};
