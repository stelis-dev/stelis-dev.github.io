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
import { buildSponsorRefillAccountWithdrawMessage } from '@stelis/contracts';

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
      return Promise.resolve({
        ok: false,
        status: 404,
        json: () => Promise.resolve({ error: 'NOT_FOUND' }),
      });
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

const POOL_DATA = {
  network: 'testnet',
  primaryAddress: '0x' + 'd'.repeat(64),
  settlementPayoutRecipientAddress: '0x' + 'b'.repeat(64),
  rpcFleet: {
    endpoints: [
      {
        url: 'https://primary.rpc.test',
        role: 'primary',
        status: 'healthy',
        cooldownRemainingMs: 0,
      },
      {
        url: 'https://secondary.rpc.test',
        role: 'secondary',
        status: 'cooldown',
        cooldownRemainingMs: 12_000,
      },
    ],
    totalEndpoints: 2,
    healthyEndpoints: 1,
  },
  sponsorOperations: {
    gateErrorCode: null,
    availableSlots: 3,
    degradedSlots: 0,
    slotLeases: {
      leasedSlots: 0,
      freeSlots: 3,
      slots: [],
    },
    slots: [],
    sponsorRefillAccount: {
      address: '0x' + 'c'.repeat(64),
      balanceMist: '2000000000',
      healthy: true,
      refillsRemaining: 5,
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
function DirectOutletProvider({ element }: { element: React.ReactNode }) {
  return (
    <MemoryRouter initialEntries={['/test']}>
      <Routes>
        <Route element={<ProvideOutletContext />}>
          <Route path="/test" element={element} />
        </Route>
      </Routes>
    </MemoryRouter>
  );
}

function ProvideOutletContext() {
  return <Outlet context={{ session: VALID_SESSION, refreshSession: vi.fn() }} />;
}

afterEach(() => {
  mockGetWallets.mockReset();
});

// ── § 1. AuthGuard behavior ─────────────────────────────────────────────────

describe('AuthGuard integration', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('redirects to /login when session returns 401', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: () => Promise.resolve({ error: 'UNAUTHORIZED' }),
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
        if (url === '/api/pool' && method === 'GET') {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve(POOL_DATA),
          });
        }
        if (url === '/api/sponsor-refill-account/withdraw' && method === 'GET') {
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
            json: () => Promise.resolve({ digest: '0xDIGEST' }),
          });
        }
        return Promise.resolve({
          ok: false,
          status: 404,
          json: () => Promise.resolve({ error: 'NOT_FOUND' }),
        });
      }),
    );

    return calls;
  }

  it('renders dashboard page title and loads data', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetchResponses({
        '/api/pool': POOL_DATA,
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

  it('renders sponsored logs KPI as compact executions over losses without a standalone section title', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetchResponses({
        '/api/pool': POOL_DATA,
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

  it('renders RPC Fleet above Service Accounts', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetchResponses({
        '/api/pool': POOL_DATA,
      }),
    );

    const { DashboardPage } = await import('../src/pages/DashboardPage');
    render(<DirectOutletProvider element={<DashboardPage />} />);

    await waitFor(() => {
      expect(screen.getByText('RPC Fleet (1/2 healthy)')).toBeDefined();
    });

    const rpcFleetCard = screen.getByText('RPC Fleet (1/2 healthy)').closest('.admin-card');
    const serviceAccountsCard = screen.getByText('Service Accounts').closest('.admin-card');
    expect(rpcFleetCard).not.toBeNull();
    expect(serviceAccountsCard).not.toBeNull();
    expect(
      rpcFleetCard!.compareDocumentPosition(serviceAccountsCard!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.getByText('https://primary.rpc.test')).toBeDefined();
    expect(screen.getByText('12s')).toBeDefined();
  });

  it('renders sponsor operations gate status in the Sponsor Pool stat card', async () => {
    const poolData = {
      ...POOL_DATA,
      sponsorOperations: {
        ...POOL_DATA.sponsorOperations,
        gateErrorCode: 'NO_HEALTHY_SPONSOR',
      },
    };
    vi.stubGlobal(
      'fetch',
      mockFetchResponses({
        '/api/pool': poolData,
      }),
    );

    const { DashboardPage } = await import('../src/pages/DashboardPage');
    render(<DirectOutletProvider element={<DashboardPage />} />);

    await waitFor(() => {
      expect(screen.getByText('Closed — NO_HEALTHY_SPONSOR')).toBeDefined();
    });
  });

  it('renders large MIST balances without Number precision loss', async () => {
    const hugeMist = '9999999999999999999';
    const poolData = {
      ...POOL_DATA,
      sponsorOperations: {
        ...POOL_DATA.sponsorOperations,
        slots: [
          {
            address: '0x' + 'e'.repeat(64),
            state: 'healthy',
            balanceMist: hugeMist,
            lastObservedAtMs: 1_700_000_000_000,
            lastError: null,
          },
        ],
        sponsorRefillAccount: {
          ...POOL_DATA.sponsorOperations.sponsorRefillAccount,
          balanceMist: hugeMist,
        },
      },
    };

    vi.stubGlobal(
      'fetch',
      mockFetchResponses({
        '/api/pool': poolData,
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
        if (url === '/api/pool' && method === 'GET') {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve(POOL_DATA),
          });
        }
        if (url === '/api/sponsor-refill-account/withdraw' && method === 'GET') {
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
            json: () => Promise.resolve({ digest: '0xDIGEST' }),
          });
        }
        return Promise.resolve({
          ok: false,
          status: 404,
          json: () => Promise.resolve({ error: 'NOT_FOUND' }),
        });
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
    const expectedMessage = buildSponsorRefillAccountWithdrawMessage(amountMist, nonce);
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
        '/api/blocklist': { blocklist: [] },
        '/api/logs': {
          logs: [
            JSON.stringify({
              ts: '2026-01-02T03:04:05.000Z',
              event: 'admin_login_success',
              level: 'info',
              ip: '127.0.0.1',
              address: '0x' + 'a'.repeat(64),
            }),
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
        expect(screen.getByText('Auth Audit')).toBeDefined();
        expect(screen.getByText('admin_login_success')).toBeDefined();
        expect(screen.queryByText('Sponsor Operations Gate')).toBeNull();
      },
      { timeout: 3000 },
    );
  });
});

describe('PromotionsPage integration', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('advertises the positive-only maxParticipants minimum in the create form', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetchResponses({
        '/api/promotions': { promotions: [] },
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
        '/api/pool': POOL_DATA,
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
    const poolDataWith1hop = {
      ...POOL_DATA,
      supportedSettlementSwapPaths: [
        {
          settlementTokenSymbol: 'DEEP',
          settlementTokenType: DEEP_TYPE,
          settlementSwapDirection: 'baseForQuote',
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
        '/api/pool': poolDataWith1hop,
        '/api/studio': { enabled: false },
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

  it('does not render RPC Fleet on the config page', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetchResponses({
        '/api/pool': POOL_DATA,
        '/api/studio': { enabled: false },
      }),
    );

    const { ConfigPage } = await import('../src/pages/ConfigPage');
    render(<DirectOutletProvider element={<ConfigPage />} />);

    await waitFor(() => {
      expect(screen.getByText('Sponsor Operations')).toBeDefined();
    });

    expect(screen.queryByText('RPC Fleet (1/2 healthy)')).toBeNull();
    expect(screen.queryByText('Sponsor Operations Gate')).toBeNull();
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
