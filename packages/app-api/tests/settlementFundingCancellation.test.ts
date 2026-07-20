import { Transaction } from '@mysten/sui/transactions';
import { toBase64 } from '@mysten/sui/utils';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';

const coreRelayMocks = vi.hoisted(() => ({
  queryUserCredit: vi.fn(),
}));

vi.mock('@stelis/core-relay', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@stelis/core-relay')>()),
  queryUserCredit: coreRelayMocks.queryUserCredit,
}));

import type { AppApiContext } from '../src/context.js';
import { createRelayRoutes } from '../src/routes/relay.js';

afterEach(() => {
  coreRelayMocks.queryUserCredit.mockReset();
  vi.restoreAllMocks();
});

const SENDER = `0x${'11'.repeat(32)}`;
const PACKAGE = `0x${'22'.repeat(32)}`;
const CONFIG = `0x${'33'.repeat(32)}`;
const VAULT_REGISTRY = `0x${'44'.repeat(32)}`;
const DEEPBOOK = `0x${'55'.repeat(32)}`;
const SETTLEMENT_RECIPIENT = `0x${'66'.repeat(32)}`;
const VAULTS_TABLE = `0x${'77'.repeat(32)}`;
const TOKEN = `0x${'88'.repeat(32)}::deep::DEEP`;
const POOL = `0x${'99'.repeat(32)}`;

function createAggregateCapacity() {
  let inflight = 0;
  return {
    get inflight() {
      return inflight;
    },
    capacity: 1,
    async tryAcquire() {
      if (inflight === 1) return null;
      inflight += 1;
      let released = false;
      return {
        async release() {
          if (released) return;
          released = true;
          inflight -= 1;
        },
      };
    },
  };
}

const settlementSwapPath = {
  settlementTokenType: TOKEN,
  settlementTokenSymbol: 'DEEP',
  settlementTokenDecimals: 6,
  settlementSwapDirection: 'baseForQuote' as const,
  effectiveFeeRateBps: 0,
  lotSize: 1n,
  minSize: 1n,
  hops: [
    {
      poolId: POOL,
      baseType: TOKEN,
      quoteType: '0x2::sui::SUI',
      swapDirection: 'baseForQuote' as const,
      feeBps: 0,
    },
  ],
};

function createTestApp(aggregateCapacity: ReturnType<typeof createAggregateCapacity>) {
  const context = {
    mode: 'relay_only',
    host: {
      network: 'testnet',
      sui: Object.freeze({ network: 'testnet', chainIdentifier: 'test' }),
      packageId: PACKAGE,
      configId: CONFIG,
      vaultRegistryId: VAULT_REGISTRY,
      deepbookPackageId: DEEPBOOK,
      settlementPayoutRecipientAddress: SETTLEMENT_RECIPIENT,
      vaultsTableId: VAULTS_TABLE,
      prepareInflightLimiter: aggregateCapacity,
      abuseBlocker: {
        checkIp: vi.fn().mockResolvedValue({ blocked: false }),
        checkSubject: vi.fn().mockResolvedValue({ blocked: false }),
      },
      rateLimiter: {
        check: vi.fn().mockResolvedValue({ allowed: true }),
      },
      getConfig: vi.fn().mockResolvedValue({
        minSettleMist: 100n,
        maxClaimMist: 1_000n,
        protocolFlatFeeMist: 10n,
      }),
    },
    prepareConfig: {
      deepbookPackageId: DEEPBOOK,
      supportedSettlementSwapPaths: [settlementSwapPath],
      settlementSwapPathDescriptors: new Map([[TOKEN, settlementSwapPath]]),
      allowedSettlementSwapPaths: [],
      quotedHostFeeMist: 20n,
    },
  } as unknown as AppApiContext;
  const routes = createRelayRoutes(context, {
    host: context.host,
    resolveClientIp: () => '127.0.0.1',
  });
  const app = new Hono();
  app.route('/relay', routes);
  return app;
}

async function requestFundingCheck(app: Hono, signal: AbortSignal): Promise<Response> {
  const txKindBytes = toBase64(await new Transaction().build({ onlyTransactionKind: true }));
  return app.request(
    new Request('http://localhost/relay/settlement-funding-check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        txKindBytes,
        senderAddress: SENDER,
        settlementTokenType: TOKEN,
        estimatedExecutionCostClaimMist: '500',
      }),
      signal,
    }),
  );
}

describe('settlement funding request cancellation', () => {
  it('does not classify a closed client as an internal failure and restores shared capacity', async () => {
    const aggregateCapacity = createAggregateCapacity();
    let resolveCredit!: (value: {
      vaultObjectId: null;
      credit: string;
      needsCreate: true;
      lastNonce: string;
    }) => void;
    coreRelayMocks.queryUserCredit.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveCredit = resolve;
      }),
    );

    const app = createTestApp(aggregateCapacity);
    const controller = new AbortController();
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const responseTask = requestFundingCheck(app, controller.signal);

    await vi.waitFor(() => expect(coreRelayMocks.queryUserCredit).toHaveBeenCalledTimes(1));
    expect(aggregateCapacity.inflight).toBe(1);
    controller.abort('Client connection prematurely closed.');
    expect(aggregateCapacity.inflight).toBe(1);
    resolveCredit({ vaultObjectId: null, credit: '0', needsCreate: true, lastNonce: '0' });

    const response = await responseTask;
    expect(response.status).toBe(499);
    await expect(response.text()).resolves.toBe('');
    expect(errorLog).not.toHaveBeenCalled();
    expect(aggregateCapacity.inflight).toBe(0);
    const next = await aggregateCapacity.tryAcquire();
    expect(next).not.toBeNull();
    await next?.release();
  });

  it('does not hide an independent chain failure that races with client cancellation', async () => {
    const aggregateCapacity = createAggregateCapacity();
    let rejectCredit!: (reason: Error) => void;
    coreRelayMocks.queryUserCredit.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        rejectCredit = reject;
      }),
    );
    const app = createTestApp(aggregateCapacity);
    const controller = new AbortController();
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const responseTask = requestFundingCheck(app, controller.signal);

    await vi.waitFor(() => expect(coreRelayMocks.queryUserCredit).toHaveBeenCalledTimes(1));
    controller.abort('Client connection prematurely closed.');
    rejectCredit(new Error('independent RPC failure'));

    const response = await responseTask;
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(errorLog).toHaveBeenCalledTimes(1);
    expect(aggregateCapacity.inflight).toBe(0);
  });
});
