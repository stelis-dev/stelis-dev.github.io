/**
 * app-admin smoke tests — API client + route rendering.
 *
 * These tests verify:
 * 1. API client functions construct correct requests
 * 2. API client handles error responses properly
 * 3. Component exports exist and are renderable
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  ADMIN_BLOCKLIST_MAX_LIMIT,
  hostErrorPublicMessage,
  SUI_CHAIN_IDENTIFIERS,
} from '@stelis/contracts';

const { assertSuiNetworkMock } = vi.hoisted(() => ({
  assertSuiNetworkMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@stelis/core-relay/browser', () => ({
  assertSuiNetwork: assertSuiNetworkMock,
  createSuiEndpointSnapshot: (endpoints: readonly { network: string }[]) => ({
    endpointCount: endpoints.length,
    network: endpoints[0]!.network,
  }),
}));

// ── API Client tests ───────────────────────────────────────────────────────

describe('API client', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('getSession sends GET /admin/auth/session with credentials', async () => {
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
      '/admin/auth/session',
      expect.objectContaining({
        credentials: 'include',
      }),
    );
    expect(result).toEqual(mockResponse);
  });

  it('issueAdminAuthChallenge sends POST /admin/auth/nonce with credentials', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ nonce: 'test-nonce-123' }),
      }),
    );

    const { issueAdminAuthChallenge } = await import('../src/api/client');
    const result = await issueAdminAuthChallenge();

    expect(result.nonce).toBe('test-nonce-123');
  });

  it('verifyAdminAuth sends POST /admin/auth/verify with body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ ok: true }),
      }),
    );

    const { verifyAdminAuth } = await import('../src/api/client');
    await verifyAdminAuth({ nonce: 'n', signature: 's', address: '0x1' });

    expect(fetch).toHaveBeenCalledWith(
      '/admin/auth/verify',
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        body: JSON.stringify({ nonce: 'n', signature: 's', address: '0x1' }),
      }),
    );
  });

  it('renewAdminSession sends POST /admin/auth/renew with body through the shared API client', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ ok: true }),
      }),
    );

    const { renewAdminSession } = await import('../src/api/client');
    await renewAdminSession({ nonce: 'n', signature: 's', address: '0x1' });

    expect(fetch).toHaveBeenCalledWith(
      '/admin/auth/renew',
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        body: JSON.stringify({ nonce: 'n', signature: 's', address: '0x1' }),
      }),
    );
  });

  it('parses the current coded error response before throwing ApiError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: () =>
          Promise.resolve({
            error: hostErrorPublicMessage('ADMIN_UNAUTHORIZED'),
            code: 'ADMIN_UNAUTHORIZED',
          }),
      }),
    );

    const { getSession, ApiError } = await import('../src/api/client');

    await expect(getSession()).rejects.toThrow(ApiError);
    try {
      await getSession();
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as InstanceType<typeof ApiError>).status).toBe(401);
      expect((e as InstanceType<typeof ApiError>).code).toBe('ADMIN_UNAUTHORIZED');
    }
  });

  it('rejects an uncoded error instead of synthesizing an HTTP code', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: () => Promise.resolve({ error: 'UNAUTHORIZED' }),
      }),
    );

    const { getSession, ApiError } = await import('../src/api/client');
    await expect(getSession()).rejects.not.toBeInstanceOf(ApiError);
    await expect(getSession()).rejects.toThrow(/code must be a string/);
  });

  it('preserves contracts-validated Host error metadata', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        json: () =>
          Promise.resolve({
            error: hostErrorPublicMessage('WITHDRAWAL_PENDING'),
            code: 'WITHDRAWAL_PENDING',
            operationId: 'withdrawal-op-1',
            digest: '0xdigest',
          }),
      }),
    );

    const { executeSponsorRefillAccountWithdrawal, ApiError } = await import('../src/api/client');
    try {
      await executeSponsorRefillAccountWithdrawal({
        nonce: 'nonce',
        signature: 'signature',
        amountMist: '1',
      });
      throw new Error('expected ApiError');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as InstanceType<typeof ApiError>).meta).toEqual({
        operationId: 'withdrawal-op-1',
        digest: '0xdigest',
      });
    }
  });

  it('rejects a malformed success response instead of returning an unchecked cast', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ address: '0xabc', exp: 'not-a-number', iat: 1 }),
      }),
    );

    const { getSession } = await import('../src/api/client');
    await expect(getSession()).rejects.toThrow(/exp must be a safe integer/);
  });

  it('getSponsorOperations sends GET /admin/sponsor-operations', async () => {
    const mockPool = {
      network: 'testnet',
      // `sponsorOperations` is always a concrete payload. The smoke test just
      // asserts the request shape and return pass-through.
      sponsorOperations: {
        gateErrorCode: null,
        healthySlots: 1,
        degradedSlots: 0,
        slotLeases: {
          leasedSlots: 0,
          freeSlots: 1,
          slots: [{ address: '0x' + '11'.repeat(32), leased: false }],
        },
        slots: [
          {
            address: '0x' + '11'.repeat(32),
            state: 'healthy',
            addressBalanceMist: '1000',
            lastObservedAtMs: 1_700_000_000_000,
            lastError: null,
          },
        ],
        sponsorRefillAccount: {
          address: '0x' + '55'.repeat(32),
          totalBalanceMist: '0',
          healthy: true,
          lastObservedAtMs: 1_700_000_000_000,
          lastError: null,
        },
      },
      primaryAddress: '0x' + '11'.repeat(32),
      settlementPayoutRecipientAddress: '0xR',
      sponsorBalanceWarnMist: '1000',
      sponsorBalanceRefillTargetMist: '2000',
      sponsorRefillAccountRunwayTargetMist: '2000',
      refillEnabled: true,
      quotedHostFeeMist: '0',
      feeConfig: null,
      supportedSettlementSwapPaths: [],
      onChainIds: {
        packageId: '0x1',
        configId: '0x2',
        vaultRegistryId: '0x3',
        deepbookPackageId: '0x4',
      },
      rpcFleet: {
        endpoints: [
          {
            origin: 'https://primary.rpc.test',
            role: 'primary',
          },
        ],
      },
    };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockPool),
      }),
    );

    const { getSponsorOperations } = await import('../src/api/client');
    const result = await getSponsorOperations();

    expect(fetch).toHaveBeenCalledWith(
      '/admin/sponsor-operations',
      expect.objectContaining({
        credentials: 'include',
      }),
    );
    expect(result.network).toBe('testnet');

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            ...mockPool,
            rpcFleet: {
              endpoints: [
                { origin: 'https://primary.rpc.test', role: 'primary' },
                { origin: 'https://primary.rpc.test', role: 'secondary' },
              ],
            },
          }),
      }),
    );
    await expect(getSponsorOperations()).resolves.toMatchObject({
      rpcFleet: {
        endpoints: [
          { origin: 'https://primary.rpc.test', role: 'primary' },
          { origin: 'https://primary.rpc.test', role: 'secondary' },
        ],
      },
    });

    for (const origin of [
      'https://user:secret@primary.rpc.test',
      'https://primary.rpc.test/provider/path',
      'https://primary.rpc.test?token=secret',
      'https://primary.rpc.test#fragment',
      'https://primary.rpc.test\n',
      'https://PRIMARY.rpc.test:443',
    ]) {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              ...mockPool,
              rpcFleet: {
                endpoints: [{ origin, role: 'primary' }],
              },
            }),
        }),
      );
      await expect(getSponsorOperations()).rejects.toThrow(/current Sui RPC origin|canonical/);
    }
  });

  it('getBlocklist returns { blocklist: [...] } matching server contract', async () => {
    const serverResponse = {
      blocklist: [
        {
          scope: 'ip',
          subject: '127.0.0.1',
          reason: 'manipulation',
          blockedUntilMs: 1_800_000_000_000,
        },
      ],
      nextCursor: 'Y3Vyc29y',
    };
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
    expect(result.blocklist[0]).toEqual(serverResponse.blocklist[0]);
    expect(result.nextCursor).toBe('Y3Vyc29y');
  });

  const currentBlocklistEntry = {
    scope: 'ip',
    subject: '127.0.0.1',
    reason: 'manipulation',
    blockedUntilMs: 1_800_000_000_000,
  } as const;

  it.each([
    {
      label: 'a non-current raw-key shape',
      response: {
        blocklist: [{ key: 'stelis:abuse:block:ip:127.0.0.1', ttl: 300 }],
        nextCursor: null,
      },
      error: /non-current field/,
    },
    {
      label: 'an unsupported scope',
      response: {
        blocklist: [{ ...currentBlocklistEntry, scope: 'user' }],
        nextCursor: null,
      },
      error: /current block scope/,
    },
    {
      label: 'an unsupported reason',
      response: {
        blocklist: [{ ...currentBlocklistEntry, reason: 'manual' }],
        nextCursor: null,
      },
      error: /current block reason/,
    },
    {
      label: 'a non-positive deadline',
      response: {
        blocklist: [{ ...currentBlocklistEntry, blockedUntilMs: 0 }],
        nextCursor: null,
      },
      error: /must be positive/,
    },
    {
      label: 'a page above the response bound',
      response: {
        blocklist: Array.from(
          { length: ADMIN_BLOCKLIST_MAX_LIMIT + 1 },
          () => currentBlocklistEntry,
        ),
        nextCursor: null,
      },
      error: new RegExp(`at most ${ADMIN_BLOCKLIST_MAX_LIMIT} entries`),
    },
  ])('getBlocklist rejects $label through the API client boundary', async ({ response, error }) => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(response),
      }),
    );

    const { getBlocklist } = await import('../src/api/client');
    await expect(getBlocklist()).rejects.toThrow(error);
  });

  it('getAuditLogs accepts only the current structured audit entries', async () => {
    const entry = {
      ts: '2026-01-02T03:04:05.000Z',
      event: 'admin_login_success',
      ip: '127.0.0.1',
      address: '0x' + 'a'.repeat(64),
    };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ logs: [entry] }),
      }),
    );

    const { getAuditLogs } = await import('../src/api/client');
    await expect(getAuditLogs()).resolves.toEqual({ logs: [entry] });
  });

  it('getAuditLogs rejects the removed JSON-string audit shape', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            logs: [
              JSON.stringify({
                ts: '2026-01-02T03:04:05.000Z',
                event: 'admin_login_success',
                ip: '127.0.0.1',
              }),
            ],
          }),
      }),
    );

    const { getAuditLogs } = await import('../src/api/client');
    await expect(getAuditLogs()).rejects.toThrow(
      /AdminAuditLogsResponse\.logs\[0\] must be an object/,
    );
  });

  it('issueSponsorRefillAccountWithdrawalChallenge returns the current challenge', async () => {
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

    const { issueSponsorRefillAccountWithdrawalChallenge } = await import('../src/api/client');
    const result = await issueSponsorRefillAccountWithdrawalChallenge();

    expect(typeof result.expiresAt).toBe('string');
    expect(result.nonce).toContain('stelis-withdraw');
  });

  it('executeSponsorRefillAccountWithdrawal validates the current response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            digest: '0xDIGEST',
            amountMist: '1000',
            recipient: '0x1',
          }),
      }),
    );

    const { executeSponsorRefillAccountWithdrawal } = await import('../src/api/client');
    await executeSponsorRefillAccountWithdrawal({ nonce: 'n', signature: 's', amountMist: '1000' });

    expect(fetch).toHaveBeenCalledWith(
      '/admin/sponsor-refill-account/withdraw',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ nonce: 'n', signature: 's', amountMist: '1000' }),
      }),
    );
  });

  it('logout sends POST /admin/auth/logout', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ ok: true }),
      }),
    );

    const { logoutAdminSession } = await import('../src/api/client');
    await logoutAdminSession();

    expect(fetch).toHaveBeenCalledWith(
      '/admin/auth/logout',
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
      }),
    );
  });

  it('removeBlocklistEntry sends DELETE /admin/blocklist with a typed identity', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ removed: true }),
      }),
    );

    const { removeBlocklistEntry } = await import('../src/api/client');
    await removeBlocklistEntry({ scope: 'studio_user', subject: 'User-A' });

    expect(fetch).toHaveBeenCalledWith(
      '/admin/blocklist',
      expect.objectContaining({
        method: 'DELETE',
        body: JSON.stringify({ scope: 'studio_user', subject: 'User-A' }),
      }),
    );
  });

  it('preserves ADMIN_CONFLICT from a concurrent block removal', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 409,
        json: () =>
          Promise.resolve({
            code: 'ADMIN_CONFLICT',
            error: hostErrorPublicMessage('ADMIN_CONFLICT'),
          }),
      }),
    );

    const { removeBlocklistEntry } = await import('../src/api/client');
    await expect(
      removeBlocklistEntry({ scope: 'studio_user', subject: 'User-A' }),
    ).rejects.toMatchObject({
      status: 409,
      code: 'ADMIN_CONFLICT',
    });
  });
});

describe('Sui RPC selection', () => {
  it('maps API-reported networks to public Sui RPC endpoints', async () => {
    const { getSuiRpcUrl } = await import('../src/suiRpc');

    expect(getSuiRpcUrl('testnet')).toBe('https://fullnode.testnet.sui.io:443');
    expect(getSuiRpcUrl('mainnet')).toBe('https://fullnode.mainnet.sui.io:443');
  });

  it('returns an app-admin client only after proving the Host network chain identity', async () => {
    assertSuiNetworkMock.mockResolvedValueOnce(undefined);
    const { createVerifiedAdminSuiClient } = await import('../src/suiRpc');

    const client = await createVerifiedAdminSuiClient('testnet');

    expect(client.network).toBe('testnet');
    expect(assertSuiNetworkMock).toHaveBeenCalledWith(
      expect.objectContaining({ network: 'testnet', endpointCount: 1 }),
      {
        network: 'testnet',
        chainIdentifier: SUI_CHAIN_IDENTIFIERS.testnet,
      },
    );
  });

  it('does not return a client when live chain identity proof fails', async () => {
    assertSuiNetworkMock.mockRejectedValueOnce(new Error('chain mismatch'));
    const { createVerifiedAdminSuiClient } = await import('../src/suiRpc');

    await expect(createVerifiedAdminSuiClient('testnet')).rejects.toThrow('chain mismatch');
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
