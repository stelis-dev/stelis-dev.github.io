/**
 * Integration tests — admin pages rendering + routing + auth guard.
 *
 * Environment: jsdom (via vite.config.ts)
 * Strategy:
 *   - AuthGuard tests: full routing with MemoryRouter
 *   - Page tests: render with mocked outlet context to avoid deep nesting
 *   - Route structure: verify wildcard redirect
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route, Navigate, Outlet, useLocation } from 'react-router-dom';
import { AuthGuard } from '../src/components/AuthGuard';
import { AppRoutes } from '../src/App';
import { buildSponsorRefillAccountWithdrawMessage } from '@stelis/contracts';
import type { AdminStudioResponse } from '@stelis/contracts';
import type { StudioAvailability } from '../src/components/AdminLayout';

const { mockGetWallets } = vi.hoisted(() => ({
  mockGetWallets: vi.fn(),
}));

vi.mock('@mysten/wallet-standard', () => ({
  getWallets: mockGetWallets,
}));

// ── Shared test helpers ─────────────────────────────────────────────────────

function mockFetchResponses(responses: Record<string, unknown>) {
  return vi.fn().mockImplementation((url: string) => {
    const body = responses[url];
    if (body === undefined) {
      return Promise.reject(new Error(`Unhandled test request: ${url}`));
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(body),
    });
  });
}

const VALID_SESSION = {
  address: '0x' + 'a'.repeat(64),
  exp: Math.floor(Date.now() / 1000) + 3600,
  iat: Math.floor(Date.now() / 1000),
};

const STUDIO_AVAILABLE_STATUS = {
  enabled: true,
  config: { developerJwtVerifyUrlConfigured: false },
} as const satisfies AdminStudioResponse;

const STUDIO_UNAVAILABLE_STATUS = {
  enabled: false,
} as const;

const STUDIO_AVAILABLE_AVAILABILITY = {
  status: 'available',
  config: STUDIO_AVAILABLE_STATUS.config,
} as const satisfies StudioAvailability;

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function jsonResponse(value: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(value),
  };
}

const SPONSOR_OPERATIONS_DATA = {
  network: 'testnet',
  primaryAddress: '0x' + 'd'.repeat(64),
  settlementPayoutRecipientAddress: '0x' + 'b'.repeat(64),
  sponsorBalanceWarnMist: '1000000000',
  sponsorBalanceRefillTargetMist: '2000000000',
  sponsorRefillAccountRunwayTargetMist: '2000000000',
  refillEnabled: true,
  quotedHostFeeMist: '100000',
  onChainIds: {
    packageId: '0x' + '1'.repeat(64),
    configId: '0x' + '2'.repeat(64),
    vaultRegistryId: '0x' + '3'.repeat(64),
    deepbookPackageId: '0x' + '4'.repeat(64),
  },
  rpcFleet: {
    endpoints: [
      {
        origin: 'https://primary.rpc.test',
        role: 'primary',
      },
      {
        origin: 'https://secondary.rpc.test',
        role: 'secondary',
      },
    ],
  },
  sponsorOperations: {
    gateErrorCode: null,
    healthySlots: 3,
    degradedSlots: 0,
    slotLeases: {
      leasedSlots: 0,
      freeSlots: 3,
      slots: [
        { address: '0x' + 'd'.repeat(64), leased: false },
        { address: '0x' + 'e'.repeat(64), leased: false },
        { address: '0x' + 'f'.repeat(64), leased: false },
      ],
    },
    slots: [
      {
        address: '0x' + 'd'.repeat(64),
        state: 'healthy',
        addressBalanceMist: '3000000000',
        lastObservedAtMs: 1_700_000_000_000,
        lastError: null,
      },
      {
        address: '0x' + 'e'.repeat(64),
        state: 'healthy',
        addressBalanceMist: '3000000000',
        lastObservedAtMs: 1_700_000_000_000,
        lastError: null,
      },
      {
        address: '0x' + 'f'.repeat(64),
        state: 'healthy',
        addressBalanceMist: '3000000000',
        lastObservedAtMs: 1_700_000_000_000,
        lastError: null,
      },
    ],
    sponsorRefillAccount: {
      address: '0x' + 'c'.repeat(64),
      totalBalanceMist: '2000000000',
      healthy: true,
      lastObservedAtMs: 1_700_000_000_000,
      lastError: null,
    },
  },
  feeConfig: {
    maxHostFeeMist: '100000',
    protocolFlatFeeMist: '50000',
    maxClaimMist: '500000',
    minSettleMist: '10000',
    configVersion: '1',
  },
  supportedSettlementSwapPaths: [],
};

/** Outlet wrapper that provides auth context directly (bypasses AuthGuard→AdminLayout chain). */
function DirectOutletProvider({
  element,
  studioAvailability = STUDIO_AVAILABLE_AVAILABILITY,
  refreshStudioAvailability = async () => {},
}: {
  element: React.ReactNode;
  studioAvailability?: StudioAvailability;
  refreshStudioAvailability?: () => Promise<void>;
}) {
  return (
    <MemoryRouter initialEntries={['/test']}>
      <Routes>
        <Route
          element={
            <ProvideOutletContext
              studioAvailability={studioAvailability}
              refreshStudioAvailability={refreshStudioAvailability}
            />
          }
        >
          <Route path="/test" element={element} />
        </Route>
      </Routes>
    </MemoryRouter>
  );
}

function ProvideOutletContext({
  studioAvailability = STUDIO_AVAILABLE_AVAILABILITY,
  refreshStudioAvailability = async () => {},
}: {
  studioAvailability?: StudioAvailability;
  refreshStudioAvailability?: () => Promise<void>;
}) {
  return (
    <Outlet
      context={{
        session: VALID_SESSION,
        refreshSession: vi.fn(),
        studioAvailability,
        refreshStudioAvailability,
      }}
    />
  );
}

afterEach(() => {
  mockGetWallets.mockReset();
});

// ── § 1. AuthGuard behavior ─────────────────────────────────────────────────

describe('AuthGuard integration', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    sessionStorage.clear();
  });

  it('redirects to /login when session returns 401', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: () => Promise.resolve({ error: 'Authentication failed', code: 'ADMIN_UNAUTHORIZED' }),
      }),
    );

    let currentPath = '/dashboard';
    function LocationTracker() {
      const loc = useLocation();
      currentPath = loc.pathname;
      return null;
    }

    render(
      <MemoryRouter initialEntries={['/dashboard']}>
        <Routes>
          <Route path="/login" element={<div data-testid="login">Login</div>} />
          <Route element={<AuthGuard />}>
            <Route path="/dashboard" element={<div>Dashboard</div>} />
          </Route>
        </Routes>
        <LocationTracker />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(currentPath).toBe('/login');
    });
  });

  it('renders child route when session is valid', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetchResponses({
        '/auth/session': VALID_SESSION,
      }),
    );

    render(
      <MemoryRouter initialEntries={['/dashboard']}>
        <Routes>
          <Route path="/login" element={<div>Login</div>} />
          <Route element={<AuthGuard />}>
            <Route
              path="/dashboard"
              element={<div data-testid="dash-content">Dashboard Content</div>}
            />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('dash-content')).toBeDefined();
    });
  });

  it('shows loading spinner while checking session', () => {
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise(() => {})));

    const { container } = render(
      <MemoryRouter initialEntries={['/dashboard']}>
        <Routes>
          <Route element={<AuthGuard />}>
            <Route path="/dashboard" element={<div>Dashboard</div>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    expect(container.querySelector('.auth-loading')).not.toBeNull();
  });

  it('redirects on network error (fail-closed)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network failure')));

    let currentPath = '/dashboard';
    function LocationTracker() {
      const loc = useLocation();
      currentPath = loc.pathname;
      return null;
    }

    render(
      <MemoryRouter initialEntries={['/dashboard']}>
        <Routes>
          <Route path="/login" element={<div>Login</div>} />
          <Route element={<AuthGuard />}>
            <Route path="/dashboard" element={<div>Dashboard</div>} />
          </Route>
        </Routes>
        <LocationTracker />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(currentPath).toBe('/login');
    });
  });
});

// ── § 2. Page rendering (with mocked outlet context + fetch) ────────────────

describe('DashboardPage integration', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    sessionStorage.clear();
  });

  async function renderDashboardPage() {
    const { DashboardPage } = await import('../src/pages/DashboardPage');

    render(<DirectOutletProvider element={<DashboardPage />} />);

    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Dashboard');
    });
  }

  function stubDashboardFetch() {
    const calls = {
      withdrawNonce: 0,
      withdrawPost: 0,
    };

    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        if (url === '/api/sponsor-operations' && method === 'GET') {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve(SPONSOR_OPERATIONS_DATA),
          });
        }
        if (url === '/api/sponsor-refill-account/withdrawal-challenge' && method === 'POST') {
          calls.withdrawNonce += 1;
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () =>
              Promise.resolve({
                nonce: 'stelis-withdraw:test:123',
                expiresAt: '2026-03-27T00:00:00.000Z',
              }),
          });
        }
        if (url === '/api/sponsor-refill-account/withdraw' && method === 'POST') {
          calls.withdrawPost += 1;
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () =>
              Promise.resolve({
                digest: '0xDIGEST',
                amountMist: '1000000000',
                recipient: VALID_SESSION.address,
              }),
          });
        }
        return Promise.reject(new Error(`Unhandled test request: ${method} ${url}`));
      }),
    );

    return calls;
  }

  it('renders dashboard page title and loads data', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetchResponses({
        '/api/sponsor-operations': SPONSOR_OPERATIONS_DATA,
      }),
    );

    const { DashboardPage } = await import('../src/pages/DashboardPage');

    render(<DirectOutletProvider element={<DashboardPage />} />);

    // Page title should render immediately
    await waitFor(
      () => {
        expect(screen.getByRole('heading', { level: 1 })).toBeDefined();
        expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Dashboard');
      },
      { timeout: 3000 },
    );
  });

  it('renders sponsored logs KPI as compact losses over executions without a standalone section title', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetchResponses({
        '/api/sponsor-operations': SPONSOR_OPERATIONS_DATA,
        '/api/sponsored-logs/summary?mode=all': {
          summary: {
            mode: 'all',
            sponsoredExecutions: '1250000',
            lossCount: '3',
            cumulativeHostNetMist: '1000000000',
            cumulativeLossMist: '-3000000',
          },
        },
      }),
    );

    const { DashboardPage } = await import('../src/pages/DashboardPage');
    render(<DirectOutletProvider element={<DashboardPage />} />);

    await waitFor(() => {
      expect(screen.getByText('3 / 1.2M')).toBeDefined();
    });
    expect(screen.getByText('Loss / Executions')).toBeDefined();
    expect(screen.queryByText('Sponsored Executions (All)')).toBeNull();
    expect(screen.queryByText('Loss Count')).toBeNull();
  });

  it('renders the immutable qualified RPC endpoints above Service Accounts', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetchResponses({
        '/api/sponsor-operations': SPONSOR_OPERATIONS_DATA,
      }),
    );

    const { DashboardPage } = await import('../src/pages/DashboardPage');
    render(<DirectOutletProvider element={<DashboardPage />} />);

    await waitFor(() => {
      expect(screen.getByText('RPC Endpoints (2 qualified)')).toBeDefined();
    });

    const rpcFleetCard = screen.getByText('RPC Endpoints (2 qualified)').closest('.admin-card');
    const serviceAccountsCard = screen.getByText('Service Accounts').closest('.admin-card');
    expect(rpcFleetCard).not.toBeNull();
    expect(serviceAccountsCard).not.toBeNull();
    expect(
      rpcFleetCard!.compareDocumentPosition(serviceAccountsCard!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.getByText('https://primary.rpc.test')).toBeDefined();
    expect(screen.getByText('https://secondary.rpc.test')).toBeDefined();
  });

  it('renders sponsor operations gate status in the Sponsor Slots stat card', async () => {
    const sponsorOperationsData = {
      ...SPONSOR_OPERATIONS_DATA,
      sponsorOperations: {
        ...SPONSOR_OPERATIONS_DATA.sponsorOperations,
        gateErrorCode: 'SPONSOR_CAPACITY_UNAVAILABLE',
        healthySlots: 0,
        degradedSlots: 3,
        slots: SPONSOR_OPERATIONS_DATA.sponsorOperations.slots.map((slot) => ({
          ...slot,
          state: 'rpc_unreachable',
          lastError: 'RPC unavailable',
        })),
        slotLeases: {
          leasedSlots: 3,
          freeSlots: 0,
          slots: SPONSOR_OPERATIONS_DATA.sponsorOperations.slotLeases.slots.map((slot) => ({
            ...slot,
            leased: true,
          })),
        },
      },
    };
    vi.stubGlobal(
      'fetch',
      mockFetchResponses({
        '/api/sponsor-operations': sponsorOperationsData,
      }),
    );

    const { DashboardPage } = await import('../src/pages/DashboardPage');
    render(<DirectOutletProvider element={<DashboardPage />} />);

    await waitFor(() => {
      expect(screen.getByText('Closed — SPONSOR_CAPACITY_UNAVAILABLE')).toBeDefined();
    });
  });

  it('renders large MIST balances without Number precision loss', async () => {
    const hugeMist = '9999999999999999999';
    const sponsorOperationsData = {
      ...SPONSOR_OPERATIONS_DATA,
      sponsorOperations: {
        ...SPONSOR_OPERATIONS_DATA.sponsorOperations,
        slots: SPONSOR_OPERATIONS_DATA.sponsorOperations.slots.map((slot, index) =>
          index === 0 ? { ...slot, addressBalanceMist: hugeMist } : slot,
        ),
        sponsorRefillAccount: {
          ...SPONSOR_OPERATIONS_DATA.sponsorOperations.sponsorRefillAccount,
          totalBalanceMist: hugeMist,
        },
      },
    };

    vi.stubGlobal(
      'fetch',
      mockFetchResponses({
        '/api/sponsor-operations': sponsorOperationsData,
      }),
    );

    const { DashboardPage } = await import('../src/pages/DashboardPage');
    render(<DirectOutletProvider element={<DashboardPage />} />);

    await waitFor(() => {
      expect(screen.getByText('Available: 9999999999.9999')).toBeDefined();
    });

    expect(screen.getAllByText('9999999999.9999').length).toBeGreaterThanOrEqual(2);
  });

  it('signs shared withdraw bytes and posts no dead address field', async () => {
    const nonce = 'stelis-withdraw:test:123';
    const amountMist = '1500000000';
    const signature = '0xSIG';
    const signPersonalMessage = vi.fn().mockResolvedValue({ signature, bytes: '0xBYTES' });

    mockGetWallets.mockReturnValue({
      get: () => [
        {
          features: {
            'sui:signPersonalMessage': {
              signPersonalMessage,
            },
          },
          accounts: [{ address: VALID_SESSION.address }],
        },
      ],
    });

    let withdrawBody: Record<string, unknown> | null = null;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        if (url === '/api/sponsor-operations' && method === 'GET') {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve(SPONSOR_OPERATIONS_DATA),
          });
        }
        if (url === '/api/sponsor-refill-account/withdrawal-challenge' && method === 'POST') {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ nonce, expiresAt: '2026-03-27T00:00:00.000Z' }),
          });
        }
        if (url === '/api/sponsor-refill-account/withdraw' && method === 'POST') {
          withdrawBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () =>
              Promise.resolve({
                digest: '0xDIGEST',
                amountMist: '1000000000',
                recipient: VALID_SESSION.address,
              }),
          });
        }
        return Promise.reject(new Error(`Unhandled test request: ${method} ${url}`));
      }),
    );

    const { DashboardPage } = await import('../src/pages/DashboardPage');
    render(<DirectOutletProvider element={<DashboardPage />} />);

    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Dashboard');
    });

    fireEvent.change(screen.getByPlaceholderText('0.5'), {
      target: { value: '1.5' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw' }));

    await waitFor(() => {
      expect(signPersonalMessage).toHaveBeenCalledTimes(1);
    });

    const params = signPersonalMessage.mock.calls[0][0] as {
      message: Uint8Array;
      account: { address: string };
    };
    const expectedMessage = buildSponsorRefillAccountWithdrawMessage('testnet', amountMist, nonce);
    expect(Array.from(params.message)).toEqual(
      Array.from(new TextEncoder().encode(expectedMessage)),
    );
    expect(params.account.address).toBe(VALID_SESSION.address);

    await waitFor(() => {
      expect(withdrawBody).not.toBeNull();
    });
    expect(withdrawBody).toEqual({
      nonce,
      signature,
      amountMist,
    });
  });

  it('retries a pending withdrawal with the exact same nonce, signature, and amount', async () => {
    const nonce = 'stelis-withdraw:pending:123';
    const signature = '0xPENDING_SIG';
    const signPersonalMessage = vi.fn().mockResolvedValue({ signature, bytes: '0xBYTES' });
    mockGetWallets.mockReturnValue({
      get: () => [
        {
          features: { 'sui:signPersonalMessage': { signPersonalMessage } },
          accounts: [{ address: VALID_SESSION.address }],
        },
      ],
    });

    let nonceRequests = 0;
    const postedBodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        if (url === '/api/sponsor-operations' && method === 'GET') {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve(SPONSOR_OPERATIONS_DATA),
          });
        }
        if (url === '/api/sponsor-refill-account/withdrawal-challenge' && method === 'POST') {
          nonceRequests += 1;
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ nonce, expiresAt: '2026-07-12T12:00:00.000Z' }),
          });
        }
        if (url === '/api/sponsor-refill-account/withdraw' && method === 'POST') {
          postedBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
          if (postedBodies.length === 1) {
            return Promise.resolve({
              ok: false,
              status: 503,
              json: () =>
                Promise.resolve({
                  code: 'WITHDRAWAL_PENDING',
                  error: 'Service temporarily unavailable',
                  operationId: 'withdrawal-op-pending',
                }),
            });
          }
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () =>
              Promise.resolve({
                digest: '0xRECOVERED',
                amountMist: '1500000000',
                recipient: VALID_SESSION.address,
              }),
          });
        }
        return Promise.reject(new Error(`Unhandled test request: ${method} ${url}`));
      }),
    );

    const { DashboardPage } = await import('../src/pages/DashboardPage');
    render(<DirectOutletProvider element={<DashboardPage />} />);
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toBeDefined());

    fireEvent.change(screen.getByPlaceholderText('0.5'), { target: { value: '1.5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Retry pending withdrawal' })).toBeDefined(),
    );

    cleanup();
    render(<DirectOutletProvider element={<DashboardPage />} />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Retry pending withdrawal' })).toBeDefined(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Retry pending withdrawal' }));
    await waitFor(() => expect(screen.getByText('Success: 0xRECOVERED')).toBeDefined());

    expect(nonceRequests).toBe(1);
    expect(signPersonalMessage).toHaveBeenCalledTimes(1);
    expect(postedBodies).toHaveLength(2);
    expect(postedBodies[1]).toEqual(postedBodies[0]);
    expect(sessionStorage.getItem('stelis:admin:pending-withdrawal')).toBeNull();
  });

  it.each([
    {
      name: 'wrong-network',
      request: {
        adminAddress: VALID_SESSION.address,
        network: 'mainnet',
        request: {
          nonce: 'stelis-withdraw:mainnet:123',
          signature: '0xMAINNET_SIG',
          amountMist: '1500000000',
        },
      },
    },
    {
      name: 'invalid-without-network',
      request: {
        adminAddress: VALID_SESSION.address,
        nonce: 'stelis-withdraw:invalid:123',
        signature: '0xINVALID_SIG',
        amountMist: '1500000000',
      },
    },
  ])('discards a $name stored withdrawal without retrying it', async ({ request }) => {
    sessionStorage.setItem('stelis:admin:pending-withdrawal', JSON.stringify(request));
    const calls = stubDashboardFetch();

    await renderDashboardPage();

    expect(screen.getByRole('button', { name: 'Withdraw' })).toBeDefined();
    expect(sessionStorage.getItem('stelis:admin:pending-withdrawal')).toBeNull();
    expect(calls.withdrawNonce).toBe(0);
    expect(calls.withdrawPost).toBe(0);
  });

  it('discards an in-memory pending withdrawal when the Host network changes', async () => {
    const nonce = 'stelis-withdraw:testnet-pending:123';
    const signature = '0xTESTNET_PENDING_SIG';
    const signPersonalMessage = vi.fn().mockResolvedValue({ signature, bytes: '0xBYTES' });
    mockGetWallets.mockReturnValue({
      get: () => [
        {
          features: { 'sui:signPersonalMessage': { signPersonalMessage } },
          accounts: [{ address: VALID_SESSION.address }],
        },
      ],
    });

    let sponsorOperationsReads = 0;
    let withdrawPosts = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        if (url === '/api/sponsor-operations' && method === 'GET') {
          sponsorOperationsReads += 1;
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () =>
              Promise.resolve({
                ...SPONSOR_OPERATIONS_DATA,
                network: sponsorOperationsReads === 1 ? 'testnet' : 'mainnet',
              }),
          });
        }
        if (url === '/api/sponsor-refill-account/withdrawal-challenge' && method === 'POST') {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ nonce, expiresAt: '2026-07-12T12:00:00.000Z' }),
          });
        }
        if (url === '/api/sponsor-refill-account/withdraw' && method === 'POST') {
          withdrawPosts += 1;
          return Promise.resolve({
            ok: false,
            status: 503,
            json: () =>
              Promise.resolve({
                code: 'WITHDRAWAL_PENDING',
                error: 'Service temporarily unavailable',
                operationId: 'withdrawal-op-pending',
              }),
          });
        }
        return Promise.reject(new Error(`Unhandled test request: ${method} ${url}`));
      }),
    );

    await renderDashboardPage();
    fireEvent.change(screen.getByPlaceholderText('0.5'), { target: { value: '1.5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Retry pending withdrawal' })).toBeDefined(),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(screen.getByText('mainnet')).toBeDefined());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Withdraw' })).toBeDefined());

    expect(sessionStorage.getItem('stelis:admin:pending-withdrawal')).toBeNull();
    expect(withdrawPosts).toBe(1);
  });

  it.each([
    {
      status: 409,
      code: 'WITHDRAWAL_NOT_ACCEPTED',
      error: 'Request conflicts with current state',
      operationId: 'withdrawal-op-not-accepted',
    },
    {
      status: 401,
      code: 'WITHDRAWAL_SIGNATURE_INVALID',
      error: 'Authentication failed',
      operationId: undefined,
    },
  ])('clears a stored request after terminal response $code', async (response) => {
    sessionStorage.setItem(
      'stelis:admin:pending-withdrawal',
      JSON.stringify({
        adminAddress: VALID_SESSION.address,
        network: 'testnet',
        request: {
          nonce: 'stelis-withdraw:unaccepted:123',
          signature: '0xUNACCEPTED',
          amountMist: '1500000000',
        },
      }),
    );
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        if (url === '/api/sponsor-operations' && method === 'GET') {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve(SPONSOR_OPERATIONS_DATA),
          });
        }
        if (url === '/api/sponsor-refill-account/withdraw' && method === 'POST') {
          return Promise.resolve({
            ok: false,
            status: response.status,
            json: () =>
              Promise.resolve({
                code: response.code,
                error: response.error,
                ...(response.operationId === undefined
                  ? {}
                  : { operationId: response.operationId }),
              }),
          });
        }
        return Promise.reject(new Error(`Unhandled test request: ${method} ${url}`));
      }),
    );

    const { DashboardPage } = await import('../src/pages/DashboardPage');
    render(<DirectOutletProvider element={<DashboardPage />} />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Retry pending withdrawal' })).toBeDefined(),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Retry pending withdrawal' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Withdraw' })).toBeDefined());

    expect(sessionStorage.getItem('stelis:admin:pending-withdrawal')).toBeNull();
  });

  it('blocks zero withdraw input before nonce fetch and signing', async () => {
    const signPersonalMessage = vi.fn();
    const calls = stubDashboardFetch();

    mockGetWallets.mockReturnValue({
      get: () => [
        {
          features: {
            'sui:signPersonalMessage': {
              signPersonalMessage,
            },
          },
          accounts: [{ address: VALID_SESSION.address }],
        },
      ],
    });

    await renderDashboardPage();

    fireEvent.change(screen.getByPlaceholderText('0.5'), {
      target: { value: '0' },
    });

    const withdrawButton = screen.getByRole('button', { name: 'Withdraw' });
    expect((withdrawButton as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Withdrawal amount must be greater than 0')).toBeDefined();

    fireEvent.click(withdrawButton);

    expect(calls.withdrawNonce).toBe(0);
    expect(signPersonalMessage).not.toHaveBeenCalled();
    expect(calls.withdrawPost).toBe(0);
  });

  it('blocks negative withdraw input before nonce fetch and signing', async () => {
    const signPersonalMessage = vi.fn();
    const calls = stubDashboardFetch();

    mockGetWallets.mockReturnValue({
      get: () => [
        {
          features: {
            'sui:signPersonalMessage': {
              signPersonalMessage,
            },
          },
          accounts: [{ address: VALID_SESSION.address }],
        },
      ],
    });

    await renderDashboardPage();

    fireEvent.change(screen.getByPlaceholderText('0.5'), {
      target: { value: '-1.5' },
    });

    const withdrawButton = screen.getByRole('button', { name: 'Withdraw' });
    expect((withdrawButton as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Withdrawal amount must be greater than 0')).toBeDefined();

    fireEvent.click(withdrawButton);

    expect(calls.withdrawNonce).toBe(0);
    expect(signPersonalMessage).not.toHaveBeenCalled();
    expect(calls.withdrawPost).toBe(0);
  });

  it('normalizes malformed multi-dot withdraw input to the empty local state before nonce fetch and signing', async () => {
    const signPersonalMessage = vi.fn();
    const calls = stubDashboardFetch();

    mockGetWallets.mockReturnValue({
      get: () => [
        {
          features: {
            'sui:signPersonalMessage': {
              signPersonalMessage,
            },
          },
          accounts: [{ address: VALID_SESSION.address }],
        },
      ],
    });

    await renderDashboardPage();

    const withdrawInput = screen.getByPlaceholderText('0.5') as HTMLInputElement;
    const withdrawButton = screen.getByRole('button', { name: 'Withdraw' }) as HTMLButtonElement;

    expect(withdrawInput.min).toBe('0.000000001');

    for (const malformedValue of ['1.2.3', '1..2']) {
      fireEvent.change(withdrawInput, {
        target: { value: malformedValue },
      });

      expect(withdrawInput.value).toBe('');
      expect(withdrawButton.disabled).toBe(true);

      fireEvent.click(withdrawButton);
    }

    expect(calls.withdrawNonce).toBe(0);
    expect(signPersonalMessage).not.toHaveBeenCalled();
    expect(calls.withdrawPost).toBe(0);
  });

  it('blocks parse-invalid withdraw input before nonce fetch and signing', async () => {
    const signPersonalMessage = vi.fn();
    const calls = stubDashboardFetch();

    mockGetWallets.mockReturnValue({
      get: () => [
        {
          features: {
            'sui:signPersonalMessage': {
              signPersonalMessage,
            },
          },
          accounts: [{ address: VALID_SESSION.address }],
        },
      ],
    });

    await renderDashboardPage();

    fireEvent.change(screen.getByPlaceholderText('0.5'), {
      target: { value: '1.0000000001' },
    });

    const withdrawButton = screen.getByRole('button', { name: 'Withdraw' });
    expect((withdrawButton as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('SUI amount cannot have more than 9 decimal places')).toBeDefined();

    fireEvent.click(withdrawButton);

    expect(calls.withdrawNonce).toBe(0);
    expect(signPersonalMessage).not.toHaveBeenCalled();
    expect(calls.withdrawPost).toBe(0);
  });

  it('blocks an amount above u64 MIST before nonce fetch and signing', async () => {
    const signPersonalMessage = vi.fn();
    const calls = stubDashboardFetch();
    mockGetWallets.mockReturnValue({
      get: () => [
        {
          features: { 'sui:signPersonalMessage': { signPersonalMessage } },
          accounts: [{ address: VALID_SESSION.address }],
        },
      ],
    });
    await renderDashboardPage();

    fireEvent.change(screen.getByPlaceholderText('0.5'), {
      target: { value: '18446744073.709551616' },
    });
    const withdrawButton = screen.getByRole('button', { name: 'Withdraw' });
    expect((withdrawButton as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Withdrawal amount must fit a positive u64 MIST value')).toBeDefined();
    expect(calls.withdrawNonce).toBe(0);
    expect(signPersonalMessage).not.toHaveBeenCalled();
    expect(calls.withdrawPost).toBe(0);
  });

  it('blocks missing wallet before nonce fetch and signing', async () => {
    const calls = stubDashboardFetch();

    mockGetWallets.mockReturnValue({
      get: () => [],
    });

    await renderDashboardPage();

    fireEvent.change(screen.getByPlaceholderText('0.5'), {
      target: { value: '1.5' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw' }));

    await waitFor(() => {
      expect(screen.getByText('Wallet not connected')).toBeDefined();
    });

    expect(calls.withdrawNonce).toBe(0);
    expect(calls.withdrawPost).toBe(0);
  });

  it('blocks missing matching admin account before nonce fetch and signing', async () => {
    const signPersonalMessage = vi.fn();
    const calls = stubDashboardFetch();

    mockGetWallets.mockReturnValue({
      get: () => [
        {
          features: {
            'sui:signPersonalMessage': {
              signPersonalMessage,
            },
          },
          accounts: [{ address: '0x' + 'b'.repeat(64) }],
        },
      ],
    });

    await renderDashboardPage();

    fireEvent.change(screen.getByPlaceholderText('0.5'), {
      target: { value: '1.5' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw' }));

    await waitFor(() => {
      expect(screen.getByText('Admin account not found')).toBeDefined();
    });

    expect(calls.withdrawNonce).toBe(0);
    expect(signPersonalMessage).not.toHaveBeenCalled();
    expect(calls.withdrawPost).toBe(0);
  });
});

describe('SecurityPage integration', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders security page with abuse blocklist management', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetchResponses({
        '/api/blocklist': { blocklist: [], nextCursor: null },
        '/api/logs': {
          logs: [
            {
              ts: '2026-01-02T03:04:05.000Z',
              event: 'admin_login_success',
              ip: '127.0.0.1',
              address: '0x' + 'a'.repeat(64),
            },
          ],
        },
      }),
    );

    const { SecurityPage } = await import('../src/pages/SecurityPage');

    render(<DirectOutletProvider element={<SecurityPage />} />);

    await waitFor(
      () => {
        expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Security');
        expect(screen.getByText('Abuse Blocklist')).toBeDefined();
        expect(screen.getByText('Admin Audit')).toBeDefined();
        expect(screen.getByText('admin_login_success')).toBeDefined();
        expect(screen.queryByText('Sponsor Operations Gate')).toBeNull();
      },
      { timeout: 3000 },
    );
  });

  it('pages block records without reloading the independent audit log', async () => {
    const cursor = 'Y3Vyc29y';
    const requestedUrls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) => {
        requestedUrls.push(url);
        if (url === '/api/blocklist') {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () =>
              Promise.resolve({
                blocklist: [
                  {
                    scope: 'ip',
                    subject: '127.0.0.1',
                    reason: 'manipulation',
                    blockedUntilMs: 1_800_000_000_000,
                  },
                ],
                nextCursor: cursor,
              }),
          });
        }
        if (url === `/api/blocklist?cursor=${cursor}`) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () =>
              Promise.resolve({
                blocklist: [
                  {
                    scope: 'studio_user',
                    subject: 'User-A',
                    reason: 'dry_run_failure_threshold',
                    blockedUntilMs: 1_800_000_001_000,
                  },
                ],
                nextCursor: null,
              }),
          });
        }
        if (url === '/api/logs') {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () =>
              Promise.resolve({
                logs: [
                  {
                    ts: '2026-01-02T03:04:05.000Z',
                    event: 'admin_login_success',
                    ip: '127.0.0.1',
                  },
                ],
              }),
          });
        }
        return Promise.reject(new Error(`Unhandled test request: ${url}`));
      }),
    );

    const { SecurityPage } = await import('../src/pages/SecurityPage');
    render(<DirectOutletProvider element={<SecurityPage />} />);
    await waitFor(() => expect(screen.getByText('manipulation')).toBeDefined());

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(screen.getByText('User-A')).toBeDefined());

    fireEvent.click(screen.getByRole('button', { name: 'Previous' }));
    await waitFor(() => expect(screen.getByText('manipulation')).toBeDefined());

    expect(requestedUrls.filter((url) => url === '/api/logs')).toHaveLength(1);
    expect(requestedUrls.filter((url) => url.startsWith('/api/blocklist'))).toEqual([
      '/api/blocklist',
      `/api/blocklist?cursor=${cursor}`,
      '/api/blocklist',
    ]);
  });
});

describe('PromotionsPage integration', () => {
  const CURRENT_PROMOTION_ID = '00000000-0000-4000-8000-000000000001';
  const CONFLICT_PROMOTION_ID = '00000000-0000-4000-8000-000000000002';
  const promotionRecord = {
    promotionId: CURRENT_PROMOTION_ID,
    type: 'gas_sponsorship',
    displayName: 'Current Promotion',
    description: 'Current description',
    status: 'draft',
    maxParticipants: 10,
    perUserGasAllowanceMist: '1000000',
    totalRequiredBudgetMist: '10000000',
    claimDeadlineAt: null,
    postClaimUseWindowMs: 0,
    startAt: null,
    pauseReason: null,
    archiveReason: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('advertises the positive-only maxParticipants minimum in the create form', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetchResponses({
        '/api/promotions': { promotions: [], nextCursor: null },
      }),
    );

    const { PromotionsPage } = await import('../src/pages/PromotionsPage');

    render(<DirectOutletProvider element={<PromotionsPage />} />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '+ New Promotion' })).toBeDefined();
    });

    fireEvent.click(screen.getByRole('button', { name: '+ New Promotion' }));

    const maxParticipantsInput = screen.getByLabelText(
      /Max Participants \(required, must be > 0\)/i,
    ) as HTMLInputElement;
    expect(maxParticipantsInput.min).toBe('1');
  });

  it('uses the returned exclusive cursor for next and previous pages', async () => {
    const secondPromotionId = '00000000-0000-4000-8000-000000000003';
    const requestedUrls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) => {
        requestedUrls.push(url);
        if (url === '/api/promotions') {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () =>
              Promise.resolve({ promotions: [promotionRecord], nextCursor: CURRENT_PROMOTION_ID }),
          });
        }
        if (url === `/api/promotions?cursor=${CURRENT_PROMOTION_ID}`) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () =>
              Promise.resolve({
                promotions: [
                  {
                    ...promotionRecord,
                    promotionId: secondPromotionId,
                    displayName: 'Second Promotion',
                  },
                ],
                nextCursor: null,
              }),
          });
        }
        return Promise.reject(new Error(`Unhandled test request: ${url}`));
      }),
    );

    const { PromotionsPage } = await import('../src/pages/PromotionsPage');
    render(<DirectOutletProvider element={<PromotionsPage />} />);
    await waitFor(() => expect(screen.getByText('Current Promotion')).toBeDefined());

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(screen.getByText('Second Promotion')).toBeDefined());
    expect(screen.getByText('Page 2')).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Previous' }));
    await waitFor(() => expect(screen.getByText('Current Promotion')).toBeDefined());
    expect(requestedUrls).toEqual([
      '/api/promotions',
      `/api/promotions?cursor=${CURRENT_PROMOTION_ID}`,
      '/api/promotions',
    ]);
  });

  it('reloads the current promotion and closes stale edits after current conflicts', async () => {
    const original = {
      ...promotionRecord,
      promotionId: CONFLICT_PROMOTION_ID,
      displayName: 'Original Promotion',
      description: 'Before concurrent update',
    };
    let listReads = 0;
    let updateWrites = 0;
    let statusWrites = 0;
    let releaseUpdateConflict!: () => void;
    const updateConflictGate = new Promise<void>((resolve) => {
      releaseUpdateConflict = resolve;
    });
    let releaseStatusConflict!: () => void;
    const statusConflictGate = new Promise<void>((resolve) => {
      releaseStatusConflict = resolve;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        if (url === '/api/promotions' && method === 'GET') {
          listReads += 1;
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () =>
              Promise.resolve({
                promotions: [
                  listReads === 1
                    ? original
                    : {
                        ...original,
                        displayName: 'Concurrent Promotion',
                        description: 'Committed by another request',
                        updatedAt: '2026-01-01T00:00:01.000Z',
                      },
                ],
                nextCursor: null,
              }),
          });
        }
        if (url === `/api/promotions/${CONFLICT_PROMOTION_ID}` && method === 'PUT') {
          updateWrites += 1;
          return updateConflictGate.then(() => ({
            ok: false,
            status: 409,
            json: () =>
              Promise.resolve({
                code: 'PROMOTION_CURRENT_CONFLICT',
                error: 'Request conflicts with current state',
              }),
          }));
        }
        if (url === `/api/promotions/${CONFLICT_PROMOTION_ID}/status` && method === 'POST') {
          statusWrites += 1;
          return statusConflictGate.then(() => ({
            ok: false,
            status: 409,
            json: () =>
              Promise.resolve({
                code: 'PROMOTION_CURRENT_CONFLICT',
                error: 'Request conflicts with current state',
              }),
          }));
        }
        return Promise.reject(new Error(`Unhandled test request: ${method} ${url}`));
      }),
    );

    const { PromotionsPage } = await import('../src/pages/PromotionsPage');
    render(<DirectOutletProvider element={<PromotionsPage />} />);
    await waitFor(() => expect(screen.getByText('Original Promotion')).toBeDefined());

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Display Name'), {
      target: { value: 'Stale Operator Edit' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Update' }));

    await waitFor(() => expect(updateWrites).toBe(1));
    for (const name of ['+ New Promotion', 'Cancel', 'Edit']) {
      expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(true);
    }
    releaseUpdateConflict();
    await waitFor(() => expect(screen.getByText('Concurrent Promotion')).toBeDefined());
    expect(screen.queryByRole('heading', { name: 'Edit Promotion' })).toBeNull();
    expect(screen.getByText('Request conflicts with current state')).toBeDefined();
    expect(listReads).toBe(2);
    expect(updateWrites).toBe(1);

    fireEvent.click(screen.getByRole('button', { name: 'Activate' }));
    await waitFor(() => expect(statusWrites).toBe(1));
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Display Name'), {
      target: { value: 'Stale After Status Conflict' },
    });
    releaseStatusConflict();

    await waitFor(() =>
      expect(screen.getByText('Request conflicts with current state')).toBeDefined(),
    );
    expect(screen.queryByRole('heading', { name: 'Edit Promotion' })).toBeNull();
    expect(listReads).toBe(3);
  });

  it.each([
    {
      label: 'activation',
      action: 'Activate',
      method: 'POST',
      path: `/api/promotions/${CURRENT_PROMOTION_ID}/status`,
    },
    {
      label: 'deletion',
      action: 'Delete',
      method: 'DELETE',
      path: `/api/promotions/${CURRENT_PROMOTION_ID}`,
    },
  ])('closes the same-record editor after successful $label', async (testCase) => {
    let listReads = 0;
    let mutationWrites = 0;
    let releaseMutation!: () => void;
    const mutationGate = new Promise<void>((resolve) => {
      releaseMutation = resolve;
    });
    vi.spyOn(globalThis, 'confirm').mockReturnValue(true);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        if (url === '/api/promotions' && method === 'GET') {
          listReads += 1;
          const promotions =
            listReads === 1
              ? [promotionRecord]
              : testCase.label === 'deletion'
                ? []
                : [{ ...promotionRecord, status: 'active' }];
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ promotions, nextCursor: null }),
          });
        }
        if (url === testCase.path && method === testCase.method) {
          mutationWrites += 1;
          return mutationGate.then(() => ({
            ok: true,
            status: 200,
            json: () =>
              Promise.resolve(
                testCase.label === 'deletion'
                  ? { ok: true }
                  : { promotion: { ...promotionRecord, status: 'active' } },
              ),
          }));
        }
        return Promise.reject(new Error(`Unhandled test request: ${method} ${url}`));
      }),
    );

    const { PromotionsPage } = await import('../src/pages/PromotionsPage');
    render(<DirectOutletProvider element={<PromotionsPage />} />);
    await waitFor(() => expect(screen.getByText('Current Promotion')).toBeDefined());

    fireEvent.click(screen.getByRole('button', { name: testCase.action }));
    await waitFor(() => expect(mutationWrites).toBe(1));
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Display Name'), {
      target: { value: 'Stale After Mutation' },
    });
    expect(screen.getByRole('heading', { name: 'Edit Promotion' })).toBeDefined();

    releaseMutation();
    await waitFor(() => expect(listReads).toBe(2));
    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: 'Edit Promotion' })).toBeNull(),
    );
  });
});

describe('ConfigPage integration', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders config page', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetchResponses({
        '/api/sponsor-operations': SPONSOR_OPERATIONS_DATA,
      }),
    );

    const { ConfigPage } = await import('../src/pages/ConfigPage');

    render(<DirectOutletProvider element={<ConfigPage />} />);

    await waitFor(
      () => {
        expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Config');
      },
      { timeout: 3000 },
    );
  });

  it('renders baseForQuote settlement swap direction without intermediate token', async () => {
    const DEEP_TYPE = '0x' + 'de'.repeat(32) + '::deep::DEEP';
    const sponsorOperationsDataWith1hop = {
      ...SPONSOR_OPERATIONS_DATA,
      supportedSettlementSwapPaths: [
        {
          settlementTokenSymbol: 'DEEP',
          settlementTokenType: DEEP_TYPE,
          settlementTokenDecimals: 9,
          settlementSwapDirection: 'baseForQuote',
          lotSize: 1,
          minSize: 1,
          hops: [
            {
              poolId: '0x' + 'a1'.repeat(32),
              baseType: DEEP_TYPE,
              quoteType: '0x2::sui::SUI',
              swapDirection: 'baseForQuote',
              feeBps: 0,
            },
          ],
          effectiveFeeRateBps: 0,
        },
      ],
    };
    vi.stubGlobal(
      'fetch',
      mockFetchResponses({
        '/api/sponsor-operations': sponsorOperationsDataWith1hop,
      }),
    );

    const { ConfigPage } = await import('../src/pages/ConfigPage');

    render(<DirectOutletProvider element={<ConfigPage />} />);

    await waitFor(
      () => {
        expect(screen.getByText('DEEP → SUI')).toBeDefined();
      },
      { timeout: 3000 },
    );
  });

  it('does not render the qualified RPC endpoint snapshot on the config page', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetchResponses({
        '/api/sponsor-operations': SPONSOR_OPERATIONS_DATA,
      }),
    );

    const { ConfigPage } = await import('../src/pages/ConfigPage');
    render(<DirectOutletProvider element={<ConfigPage />} />);

    await waitFor(() => {
      expect(screen.getByText('Sponsor Operations')).toBeDefined();
    });

    expect(screen.queryByText('RPC Endpoints (2 qualified)')).toBeNull();
    expect(screen.queryByText('Sponsor Operations Gate')).toBeNull();
  });
});

describe('Admin Studio availability integration', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('keeps a direct Promotion URL closed until the parsed Host response reports availability', async () => {
    const studioResponse = deferred<unknown>();
    let promotionReads = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) => {
        if (url === '/auth/session') return Promise.resolve(jsonResponse(VALID_SESSION));
        if (url === '/api/studio') {
          return studioResponse.promise.then((value) => jsonResponse(value));
        }
        if (url === '/api/promotions') {
          promotionReads += 1;
          return Promise.resolve(jsonResponse({ promotions: [], nextCursor: null }));
        }
        return Promise.reject(new Error(`Unhandled test request: ${url}`));
      }),
    );

    let currentPath = '/promotions';
    function LocationTracker() {
      currentPath = useLocation().pathname;
      return null;
    }
    render(
      <MemoryRouter initialEntries={['/promotions']}>
        <AppRoutes />
        <LocationTracker />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('Loading Studio availability…')).toBeDefined());
    expect(screen.queryByRole('link', { name: 'Promotions' })).toBeNull();
    expect(promotionReads).toBe(0);

    studioResponse.resolve(STUDIO_UNAVAILABLE_STATUS);
    await waitFor(() => {
      expect(screen.getByText('Studio is not enabled for this Host.')).toBeDefined();
    });
    expect(currentPath).toBe('/promotions');
    expect(screen.queryByRole('link', { name: 'Promotions' })).toBeNull();
    expect(promotionReads).toBe(0);
  });

  it('retries the shared Host request and mounts Promotions only after availability', async () => {
    let studioReads = 0;
    let promotionReads = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) => {
        if (url === '/auth/session') return Promise.resolve(jsonResponse(VALID_SESSION));
        if (url === '/api/studio') {
          studioReads += 1;
          return studioReads === 1
            ? Promise.reject(new Error('Studio status request failed'))
            : Promise.resolve(jsonResponse(STUDIO_AVAILABLE_STATUS));
        }
        if (url === '/api/promotions') {
          promotionReads += 1;
          return Promise.resolve(jsonResponse({ promotions: [], nextCursor: null }));
        }
        return Promise.reject(new Error(`Unhandled test request: ${url}`));
      }),
    );
    render(
      <MemoryRouter initialEntries={['/promotions']}>
        <AppRoutes />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('Studio status request failed')).toBeDefined());
    expect(promotionReads).toBe(0);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByText('No promotions found.')).toBeDefined());
    expect(screen.getByRole('link', { name: 'Promotions' })).toBeDefined();
    expect(studioReads).toBe(2);
    expect(promotionReads).toBe(1);
  });

  it('joins refreshes, aborts the owned request on unmount, and ignores its late completion', async () => {
    const firstStudioResponse = deferred<unknown>();
    const secondStudioResponse = deferred<unknown>();
    const studioSignals: AbortSignal[] = [];
    let studioReads = 0;
    let promotionReads = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string, init?: RequestInit) => {
        if (url === '/auth/session') return Promise.resolve(jsonResponse(VALID_SESSION));
        if (url === '/api/sponsor-operations') {
          return Promise.resolve(jsonResponse(SPONSOR_OPERATIONS_DATA));
        }
        if (url === '/api/studio') {
          studioReads += 1;
          if (init?.signal) studioSignals.push(init.signal);
          return (
            studioReads === 1 ? firstStudioResponse.promise : secondStudioResponse.promise
          ).then((value) => jsonResponse(value));
        }
        if (url === '/api/promotions') {
          promotionReads += 1;
          return Promise.resolve(jsonResponse({ promotions: [], nextCursor: null }));
        }
        return Promise.reject(new Error(`Unhandled test request: ${url}`));
      }),
    );

    const firstMount = render(
      <MemoryRouter initialEntries={['/config']}>
        <AppRoutes />
      </MemoryRouter>,
    );
    await waitFor(() => expect(studioReads).toBe(1));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh' })).toBeDefined());
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(studioReads).toBe(1);

    firstMount.unmount();
    expect(studioSignals[0]?.aborted).toBe(true);

    render(
      <MemoryRouter initialEntries={['/promotions']}>
        <AppRoutes />
      </MemoryRouter>,
    );
    await waitFor(() => expect(studioReads).toBe(2));
    await waitFor(() => expect(screen.getByText('Loading Studio availability…')).toBeDefined());

    firstStudioResponse.resolve(STUDIO_AVAILABLE_STATUS);
    await Promise.resolve();
    expect(screen.getByText('Loading Studio availability…')).toBeDefined();
    expect(promotionReads).toBe(0);

    secondStudioResponse.resolve(STUDIO_AVAILABLE_STATUS);
    await waitFor(() => expect(screen.getByText('No promotions found.')).toBeDefined());
    expect(promotionReads).toBe(1);
  });
});

// ── § 3. Route structure ────────────────────────────────────────────────────

describe('Route structure', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('unknown routes redirect to /dashboard', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetchResponses({
        '/auth/session': VALID_SESSION,
      }),
    );

    let currentPath = '/unknown-page';
    function LocationTracker() {
      const loc = useLocation();
      currentPath = loc.pathname;
      return null;
    }

    render(
      <MemoryRouter initialEntries={['/unknown-page']}>
        <Routes>
          <Route path="/login" element={<div>Login</div>} />
          <Route element={<AuthGuard />}>
            <Route path="/dashboard" element={<div>Dashboard</div>} />
          </Route>
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Routes>
        <LocationTracker />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(currentPath).toBe('/dashboard');
    });
  });
});
