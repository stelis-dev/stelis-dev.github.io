import { Outlet, useOutletContext } from 'react-router-dom';
import type { AdminLayoutContext } from './AdminLayout';

export function StudioGuard() {
  const context = useOutletContext<AdminLayoutContext>();

  if (context.studioAvailability.status === 'loading') {
    return (
      <div className="admin-page">
        <h1 className="admin-page-title">Promotions</h1>
        <p className="admin-page-sub">Loading Studio availability…</p>
      </div>
    );
  }

  if (context.studioAvailability.status === 'unavailable') {
    return (
      <div className="admin-page">
        <h1 className="admin-page-title">Promotions</h1>
        <div className="admin-card">
          <p>Studio is not enabled for this Host.</p>
        </div>
      </div>
    );
  }

  if (context.studioAvailability.status === 'failed') {
    return (
      <div className="admin-page">
        <h1 className="admin-page-title">Promotions</h1>
        <div className="admin-card">
          <p style={{ color: '#f87171' }}>{context.studioAvailability.error}</p>
          <button
            type="button"
            className="admin-btn admin-btn-primary"
            onClick={() => void context.refreshStudioAvailability()}
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  return <Outlet context={context} />;
}
