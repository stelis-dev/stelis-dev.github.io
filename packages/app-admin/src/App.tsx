import { Suspense, lazy } from 'react';
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom';

const AuthGuard = lazy(() =>
  import('./components/AuthGuard').then((module) => ({ default: module.AuthGuard })),
);
const AdminLayout = lazy(() =>
  import('./components/AdminLayout').then((module) => ({ default: module.AdminLayout })),
);
const StudioGuard = lazy(() =>
  import('./components/StudioGuard').then((module) => ({ default: module.StudioGuard })),
);
const LoginPage = lazy(() =>
  import('./pages/LoginPage').then((module) => ({ default: module.LoginPage })),
);
const DashboardPage = lazy(() =>
  import('./pages/DashboardPage').then((module) => ({ default: module.DashboardPage })),
);
const SecurityPage = lazy(() =>
  import('./pages/SecurityPage').then((module) => ({ default: module.SecurityPage })),
);
const ConfigPage = lazy(() =>
  import('./pages/ConfigPage').then((module) => ({ default: module.ConfigPage })),
);
const PromotionsPage = lazy(() =>
  import('./pages/PromotionsPage').then((module) => ({ default: module.PromotionsPage })),
);
const SponsoredLogsPage = lazy(() =>
  import('./pages/SponsoredLogsPage').then((module) => ({ default: module.SponsoredLogsPage })),
);

function RouteFallback() {
  return (
    <div className="auth-loading">
      <div className="auth-loading-spinner" />
    </div>
  );
}

/** The production route tree without a router, for alternate router owners and composition tests. */
export function AppRoutes() {
  return (
    <Suspense fallback={<RouteFallback />}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route element={<AuthGuard />}>
          <Route element={<AdminLayout />}>
            <Route path="/dashboard" element={<DashboardPage />} />
            <Route element={<StudioGuard />}>
              <Route path="/promotions" element={<PromotionsPage />} />
            </Route>
            <Route path="/sponsored-logs" element={<SponsoredLogsPage />} />
            <Route path="/security" element={<SecurityPage />} />
            <Route path="/config" element={<ConfigPage />} />
          </Route>
        </Route>
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </Suspense>
  );
}

export function App() {
  return (
    <HashRouter>
      <AppRoutes />
    </HashRouter>
  );
}
