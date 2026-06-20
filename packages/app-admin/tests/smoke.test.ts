/**
 * app-admin smoke tests — API client + route rendering.
 *
 * These tests verify:
 * 1. API client functions construct correct requests
 * 2. API client handles error responses properly
 * 3. Component exports exist and are renderable
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── API Client tests ───────────────────────────────────────────────────────

describe('API client', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('getSession sends GET /auth/session with credentials', async () => {
    const mockResponse = { address: '0xabc', exp: 9999999999, iat: 1000000000 };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      }),
    );

    const { getSession } = await import('../src/api/client');
    const result = await getSession();

    expect(fetch).toHaveBeenCalledWith(
      '/auth/session',
      expect.objectContaining({
        credentials: 'include',
      }),
    );
    expect(result).toEqual(mockResponse);
  });

  it('getNonce sends GET /auth/nonce with credentials', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ nonce: 'test-nonce-123' }),
      }),
    );

    const { getNonce } = await import('../src/api/client');
    const result = await getNonce();

    expect(result.nonce).toBe('test-nonce-123');
  });

  it('verifySignature sends POST /auth/verify with body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({}),
      }),
    );

    const { verifySignature } = await import('../src/api/client');
    await verifySignature({ nonce: 'n', signature: 's', address: '0x1' });

    expect(fetch).toHaveBeenCalledWith(
      '/auth/verify',
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        body: JSON.stringify({ nonce: 'n', signature: 's', address: '0x1' }),
      }),
    );
  });

  it('throws ApiError on non-ok response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: () => Promise.resolve({ error: 'UNAUTHORIZED', message: 'Not authenticated' }),
      }),
    );

    const { getSession, ApiError } = await import('../src/api/client');

    await expect(getSession()).rejects.toThrow(ApiError);
    try {
      await getSession();
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as InstanceType<typeof ApiError>).status).toBe(401);
      expect((e as InstanceType<typeof ApiError>).code).toBe('UNAUTHORIZED');
    }
  });

  it('getPool sends GET /api/pool', async () => {
    const mockPool = {
      network: 'testnet',
      // `sponsorOperations` is always a concrete payload. The smoke test just
      // asserts the request shape and return pass-through.
      sponsorOperations: {
        gateErrorCode: null,
        availableSlots: 1,
        degradedSlots: 0,
        slotLeases: {
          leasedSlots: 0,
          freeSlots: 1,
          slots: [],
        },
        slots: [],
        sponsorRefillAccount: {
          address: '0x' + '55'.repeat(32),
          balanceMist: '0',
          healthy: true,
          refillsRemaining: 0,
          lastObservedAtMs: 1_700_000_000_000,
          lastError: null,
        },
      },
      settlementPayoutRecipientAddress: '0xR',
    };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockPool),
      }),
    );

    const { getPool } = await import('../src/api/client');
    const result = await getPool();

    expect(fetch).toHaveBeenCalledWith(
      '/api/pool',
      expect.objectContaining({
        credentials: 'include',
      }),
    );
    expect(result.network).toBe('testnet');
  });

  it('getBlocklist returns { blocklist: [...] } matching server contract', async () => {
    const serverResponse = { blocklist: [{ key: '0x123', ttl: 300 }] };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(serverResponse),
      }),
    );

    const { getBlocklist } = await import('../src/api/client');
    const result = await getBlocklist();

    expect(result.blocklist).toHaveLength(1);
    expect(result.blocklist[0].key).toBe('0x123');
    expect(result.blocklist[0].ttl).toBe(300);
  });

  it('getSponsorRefillAccountWithdrawNonce returns expiresAt as string (ISO)', async () => {
    const serverResponse = {
      nonce: 'stelis-withdraw:uuid:123',
      expiresAt: '2026-03-27T00:00:00.000Z',
    };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(serverResponse),
      }),
    );

    const { getSponsorRefillAccountWithdrawNonce } = await import('../src/api/client');
    const result = await getSponsorRefillAccountWithdrawNonce();

    expect(typeof result.expiresAt).toBe('string');
    expect(result.nonce).toContain('stelis-withdraw');
  });

  it('executeSponsorRefillAccountWithdraw sends POST /api/sponsor-refill-account/withdraw without dead address field', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ digest: '0xDIGEST' }),
      }),
    );

    const { executeSponsorRefillAccountWithdraw } = await import('../src/api/client');
    await executeSponsorRefillAccountWithdraw({ nonce: 'n', signature: 's', amountMist: '1000' });

    expect(fetch).toHaveBeenCalledWith(
      '/api/sponsor-refill-account/withdraw',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ nonce: 'n', signature: 's', amountMist: '1000' }),
      }),
    );
  });

  it('logout sends POST /auth/logout', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({}),
      }),
    );

    const { logout } = await import('../src/api/client');
    await logout();

    expect(fetch).toHaveBeenCalledWith(
      '/auth/logout',
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
      }),
    );
  });

  it('removeBlocklistEntry sends DELETE /api/blocklist with key', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({}),
      }),
    );

    const { removeBlocklistEntry } = await import('../src/api/client');
    await removeBlocklistEntry('0xbad');

    expect(fetch).toHaveBeenCalledWith(
      '/api/blocklist',
      expect.objectContaining({
        method: 'DELETE',
        body: JSON.stringify({ key: '0xbad' }),
      }),
    );
  });
});

describe('Sui RPC selection', () => {
  it('maps API-reported networks to public Sui RPC endpoints', async () => {
    const { getSuiRpcUrl } = await import('../src/suiRpc');

    expect(getSuiRpcUrl('testnet')).toBe('https://fullnode.testnet.sui.io:443');
    expect(getSuiRpcUrl('mainnet')).toBe('https://fullnode.mainnet.sui.io:443');
  });
});

// ── Component export smoke tests ───────────────────────────────────────────

describe('Component exports', () => {
  it('AuthGuard is exported', async () => {
    const mod = await import('../src/components/AuthGuard');
    expect(mod.AuthGuard).toBeDefined();
    expect(typeof mod.AuthGuard).toBe('function');
  });

  it('AdminLayout is exported', async () => {
    const mod = await import('../src/components/AdminLayout');
    expect(mod.AdminLayout).toBeDefined();
    expect(typeof mod.AdminLayout).toBe('function');
  });

  it('RenewModal is exported', async () => {
    const mod = await import('../src/components/RenewModal');
    expect(mod.RenewModal).toBeDefined();
    expect(typeof mod.RenewModal).toBe('function');
  });

  it('LoginPage is exported', async () => {
    const mod = await import('../src/pages/LoginPage');
    expect(mod.LoginPage).toBeDefined();
  });

  it('DashboardPage is exported', async () => {
    const mod = await import('../src/pages/DashboardPage');
    expect(mod.DashboardPage).toBeDefined();
  });

  it('SecurityPage is exported', async () => {
    const mod = await import('../src/pages/SecurityPage');
    expect(mod.SecurityPage).toBeDefined();
  });

  it('ConfigPage is exported', async () => {
    const mod = await import('../src/pages/ConfigPage');
    expect(mod.ConfigPage).toBeDefined();
  });
});

// ── Utility function tests ──────────────────────────────────────────────

describe('mistToSui', () => {
  it('converts small MIST values correctly', async () => {
    const { mistToSui } = await import('../src/utils');
    expect(mistToSui('1000000000')).toBe('1.0000');
    expect(mistToSui('500000000')).toBe('0.5000');
    expect(mistToSui('0')).toBe('0.0000');
  });

  it('handles large MIST values without precision loss', async () => {
    const { mistToSui } = await import('../src/utils');
    // 10_000 SUI = 10_000_000_000_000 MIST (exceeds 2^53 at ~9007 SUI)
    expect(mistToSui('10000000000000')).toBe('10000.0000');
    // 9_999_999_999_999_999_999 MIST — well above Number.MAX_SAFE_INTEGER
    expect(mistToSui('9999999999999999999')).toBe('9999999999.9999');
  });

  it('handles negative values', async () => {
    const { mistToSui } = await import('../src/utils');
    expect(mistToSui('-500000000')).toBe('-0.5000');
  });

  it('handles bigint input directly', async () => {
    const { mistToSui } = await import('../src/utils');
    expect(mistToSui(1_500_000_000n)).toBe('1.5000');
  });

  it('returns dash for invalid input', async () => {
    const { mistToSui } = await import('../src/utils');
    expect(mistToSui('not_a_number')).toBe('—');
    expect(mistToSui(Number.MAX_SAFE_INTEGER + 1)).toBe('—');
  });
});

describe('suiToMist', () => {
  it('converts whole SUI to MIST', async () => {
    const { suiToMist } = await import('../src/utils');
    expect(suiToMist('1')).toBe('1000000000');
    expect(suiToMist('0')).toBe('0');
  });

  it('converts fractional SUI to MIST', async () => {
    const { suiToMist } = await import('../src/utils');
    expect(suiToMist('1.5')).toBe('1500000000');
    expect(suiToMist('0.000000001')).toBe('1');
  });

  it('rejects more than 9 decimal places', async () => {
    const { suiToMist } = await import('../src/utils');
    expect(() => suiToMist('1.0000000001')).toThrow('more than 9 decimal places');
  });

  it('rejects malformed decimal strings', async () => {
    const { suiToMist } = await import('../src/utils');
    expect(() => suiToMist('1.2.3')).toThrow('non-negative decimal string');
    expect(() => suiToMist('1e3')).toThrow('non-negative decimal string');
  });
});
