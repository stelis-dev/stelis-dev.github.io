/**
 * Prepare runner procedure and ownership-boundary tests.
 *
 * Expected traces are written independently from production declarations. Each
 * success trace observes both policy hooks and the host ports that acquire,
 * commit, store, and release resources.
 */
import { describe, expect, test, vi } from 'vitest';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { toHex } from '@mysten/sui/utils';
import type { AddressBalanceGasTransaction } from '@stelis/core-relay/server';

const { testGasTransactions } = vi.hoisted(() => ({
  testGasTransactions: new WeakMap<object, { bytes: Uint8Array; txBytesHash: string }>(),
}));

vi.mock('@stelis/core-relay/server', async (importOriginal) => {
  const original = await importOriginal<typeof import('@stelis/core-relay/server')>();
  return {
    ...original,
    getAddressBalanceGasTransactionBytes: (transaction: object) => {
      const contents = testGasTransactions.get(transaction);
      if (!contents) throw new TypeError('unknown test gas transaction');
      return contents.bytes.slice();
    },
    getAddressBalanceGasTransactionTxBytesHash: (transaction: object) => {
      const contents = testGasTransactions.get(transaction);
      if (!contents) throw new TypeError('unknown test gas transaction');
      return contents.txBytesHash;
    },
  };
});
import {
  runPrepareStateMachine,
  RunnerHostMisconfiguredError,
  RunnerLedgerReservationRejectedError,
  RunnerSponsorSlotExhaustedError,
  type PrepareStateMachineHost,
  type PrepareStateMachineRequest,
} from '../src/session/sponsoredExecution/runner.js';
import type { GasBoundBuildResult } from '../src/session/sponsoredExecution/reservationHandles.js';
import type {
  PolicyHooks,
  SponsoredExecutionPolicy,
} from '../src/session/sponsoredExecution/executionPolicy.js';
import { MemorySponsoredExecutionStore } from '../src/store/memorySponsoredExecutionStore.js';
import { MemoryPrepareInflight } from '../src/store/memoryPrepareInflight.js';
import { MemoryPromotionExecutionLedger } from '../src/studio/executionLedgerMemory.js';
import { MemoryPromotionStore } from '../src/studio/promotionStore.js';
import { SponsorPool } from '../src/context.js';

const SPONSOR_KP = Ed25519Keypair.generate();
const TEST_HMAC_SECRET = 'unit-8-prepare-runner-test-hmac-secret';
const TEST_SENDER = `0x${'be'.repeat(32)}`;
const TEST_PROMO = '00000000-0000-4000-8000-000000000208';
const TEST_USER = 'unit-8-user';
const TEST_CLIENT_IP = '127.0.0.1';
const TEST_TX_BYTES = new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd]);
const TEST_TX_BYTES_HASH = 'a'.repeat(64);
const TEST_GAS_TRANSACTION = Object.freeze({}) as AddressBalanceGasTransaction;
testGasTransactions.set(TEST_GAS_TRANSACTION, {
  bytes: TEST_TX_BYTES,
  txBytesHash: TEST_TX_BYTES_HASH,
});
const TEST_BUILD_RESULT: GasBoundBuildResult = {
  addressBalanceGasTransaction: TEST_GAS_TRANSACTION,
  measuredGasMist: 1_400_000n,
};

type Trace = string[];

interface TestPrepareResponse {
  readonly receiptId: string;
  readonly draftReceiptId: string;
  readonly txBytesHash: string;
}

interface PolicyOptions {
  readonly buildResult?: GasBoundBuildResult;
  readonly failAtHook?: string;
}

function recordHook(trace: Trace, name: string, failAtHook?: string): void {
  trace.push(`hook:${name}`);
  if (failAtHook === name) throw new Error(`policy fault at ${name}`);
}

function makeMockHooks(trace: Trace, options: PolicyOptions = {}): PolicyHooks<'promotion'> {
  const buildResult = options.buildResult ?? TEST_BUILD_RESULT;
  const hook = (name: string) => () => recordHook(trace, name, options.failAtHook);
  return {
    Intent: hook('Intent'),
    RequestValidation: hook('RequestValidation'),
    ChainSnapshot: () => {
      recordHook(trace, 'ChainSnapshot', options.failAtHook);
      return {};
    },
    GasBoundBuild: () => {
      recordHook(trace, 'GasBoundBuild', options.failAtHook);
      return buildResult;
    },
    SponsorSubmissionAdmission: () => {},
    SharedSponsorChecks: () => ({}),
    PolicySponsorChecks: () => ({}),
    Preflight: () => {},
    ClassifySponsorResult: () => {},
  };
}

function makeGenericPolicy(
  trace: Trace = [],
  options: PolicyOptions = {},
): SponsoredExecutionPolicy<'generic'> {
  const hooks = makeMockHooks(trace, options);
  return {
    discriminator: 'generic',
    handleRequirements: {
      gasBoundBuild: { nonce: true },
      preparedCommit: {},
      sponsorResult: {},
    },
    hooks: {
      ...hooks,
      ChainSnapshot: () => {
        recordHook(trace, 'ChainSnapshot', options.failAtHook);
        return { nonceAcquire: { onchainLastNonce: 0n } };
      },
    },
  };
}

function makePromotionPolicy(
  trace: Trace = [],
  options: PolicyOptions = {},
): SponsoredExecutionPolicy<'promotion'> {
  return {
    discriminator: 'promotion',
    handleRequirements: {
      gasBoundBuild: {},
      preparedCommit: { ledgerReservation: true },
      sponsorResult: { ledgerReservation: true },
    },
    hooks: makeMockHooks(trace, options),
  };
}

/** Synthetic runner policy used only to prove cleanup of every handle kind. */
function makeAllReservationPolicy(trace: Trace): SponsoredExecutionPolicy {
  const promotion = makePromotionPolicy(trace);
  return {
    ...promotion,
    handleRequirements: {
      gasBoundBuild: { nonce: true },
      preparedCommit: { ledgerReservation: true },
      sponsorResult: { ledgerReservation: true },
    },
    hooks: {
      ...promotion.hooks,
      ChainSnapshot: () => {
        recordHook(trace, 'ChainSnapshot');
        return { nonceAcquire: { onchainLastNonce: 0n } };
      },
    },
  };
}

interface HostBuild {
  readonly host: PrepareStateMachineHost;
  readonly inflight: MemoryPrepareInflight;
  readonly sponsoredExecutionStore: MemorySponsoredExecutionStore;
  readonly ledger: MemoryPromotionExecutionLedger;
  readonly promotionStore: MemoryPromotionStore;
  readonly sponsorPool: SponsorPool;
  readonly observedReceiptIds: {
    readonly checkout: string[];
    readonly nonce: string[];
    readonly store: string[];
  };
}

function makeHost(
  trace: Trace = [],
  options: { readonly commitPreparedReceiptError?: Error } = {},
): HostBuild {
  const sponsorPool = new SponsorPool([SPONSOR_KP], { hmacSecret: TEST_HMAC_SECRET });
  class FixedPromotionStore extends MemoryPromotionStore {
    protected override generateId(): string {
      return TEST_PROMO;
    }
  }
  const promotionStore = new FixedPromotionStore();
  const ledger = new MemoryPromotionExecutionLedger(promotionStore);
  const sponsoredExecutionStore = new MemorySponsoredExecutionStore(sponsorPool, ledger);
  const inflight = new MemoryPrepareInflight(8);
  const observedReceiptIds = {
    checkout: [] as string[],
    nonce: [] as string[],
    store: [] as string[],
  };

  const originalTryAcquire = inflight.tryAcquire.bind(inflight);
  inflight.tryAcquire = async (route?: string) => {
    trace.push('port:inflight.acquire');
    const handle = await originalTryAcquire(route);
    if (!handle) return null;
    return {
      release: async () => {
        trace.push('port:inflight.release');
        await handle.release();
      },
    };
  };

  const originalCheckout = sponsorPool.checkout.bind(sponsorPool);
  sponsorPool.checkout = async (receiptId: string) => {
    trace.push('port:sponsor.checkout');
    observedReceiptIds.checkout.push(receiptId);
    return originalCheckout(receiptId);
  };
  const originalCheckin = sponsorPool.checkin.bind(sponsorPool);
  sponsorPool.checkin = async (sponsorAddress, receiptId) => {
    trace.push('port:sponsor.checkin');
    await originalCheckin(sponsorAddress, receiptId);
  };

  const originalStore = sponsoredExecutionStore.commitPreparedReceipt.bind(sponsoredExecutionStore);
  sponsoredExecutionStore.commitPreparedReceipt = async (draft) => {
    trace.push('port:commitPreparedReceipt');
    observedReceiptIds.store.push(draft.receiptId);
    if (options.commitPreparedReceiptError) throw options.commitPreparedReceiptError;
    return originalStore(draft);
  };
  const originalReserveNonce = sponsoredExecutionStore.reserveNonce.bind(sponsoredExecutionStore);
  sponsoredExecutionStore.reserveNonce = async (senderAddress, onchainLastNonce, reservationId) => {
    trace.push('port:nonce.reserve');
    observedReceiptIds.nonce.push(reservationId);
    return originalReserveNonce(senderAddress, onchainLastNonce, reservationId);
  };
  const originalReleaseReservation =
    sponsoredExecutionStore.releaseNonceReservation.bind(sponsoredExecutionStore);
  sponsoredExecutionStore.releaseNonceReservation = async (reservationId, senderAddress) => {
    trace.push('port:nonce.release');
    await originalReleaseReservation(reservationId, senderAddress);
  };

  const originalLedgerReserve = ledger.reserve.bind(ledger);
  ledger.reserve = async (params) => {
    trace.push('port:ledger.reserve');
    return originalLedgerReserve(params);
  };
  const originalLedgerRelease = ledger.release.bind(ledger);
  ledger.release = async (receiptId) => {
    trace.push('port:ledger.release');
    return originalLedgerRelease(receiptId);
  };

  return {
    host: {
      inflightLimiter: inflight,
      sponsorPool,
      sponsoredExecutionStore,
      executionLedger: ledger,
    },
    inflight,
    sponsoredExecutionStore,
    ledger,
    promotionStore,
    sponsorPool,
    observedReceiptIds,
  };
}

function makeGenericRequest(
  trace: Trace = [],
  options: { readonly projectionError?: Error } = {},
): PrepareStateMachineRequest<TestPrepareResponse> {
  return {
    senderAddress: TEST_SENDER,
    clientIp: TEST_CLIENT_IP,
    assertSponsorAvailable: async () => {
      trace.push('request:assertSponsorAvailable');
    },
    preparedDraftFields: () => {
      trace.push('request:preparedDraftFields');
      return { executionPathKey: 'credit', orderId: null };
    },
    projectResponse: ({ draft }) => {
      trace.push('request:projectResponse');
      if (options.projectionError) throw options.projectionError;
      return {
        receiptId: draft.receiptId,
        draftReceiptId: draft.receiptId,
        txBytesHash: draft.txBytesHash,
      };
    },
  };
}

async function makePromotionRequest(
  host: HostBuild,
  trace: Trace = [],
  options: {
    readonly allowanceMist?: string;
    readonly projectionError?: Error;
  } = {},
): Promise<PrepareStateMachineRequest<TestPrepareResponse>> {
  const promotion = await host.promotionStore.create({
    type: 'gas_sponsorship',
    displayName: 'Prepare runner promotion',
    maxParticipants: 16,
    perUserGasAllowanceMist: options.allowanceMist ?? '100000000',
  });
  await host.promotionStore.transitionStatus(promotion.promotionId, 'active');
  await host.ledger.claim(TEST_PROMO, TEST_USER, {
    useUntilAt: null,
  });
  return {
    senderAddress: TEST_SENDER,
    clientIp: TEST_CLIENT_IP,
    assertSponsorAvailable: async () => {
      trace.push('request:assertSponsorAvailable');
    },
    ledgerAcquireParams: { promotionId: TEST_PROMO, userId: TEST_USER },
    preparedDraftFields: () => {
      trace.push('request:preparedDraftFields');
      return { executionPathKey: `promotion:${TEST_PROMO}`, orderId: null };
    },
    projectResponse: ({ draft }) => {
      trace.push('request:projectResponse');
      if (options.projectionError) throw options.projectionError;
      return {
        receiptId: draft.receiptId,
        draftReceiptId: draft.receiptId,
        txBytesHash: draft.txBytesHash,
      };
    },
  };
}

function alternateReceipt(fill: number): string {
  return `0x${toHex(new Uint8Array(32).fill(fill))}`;
}

describe('runPrepareStateMachine procedural traces', () => {
  test('generic hook and host-port order matches an independent literal trace', async () => {
    const trace: Trace = [];
    const host = makeHost(trace);

    await runPrepareStateMachine(host.host, makeGenericRequest(trace), makeGenericPolicy(trace));

    expect(trace).toEqual([
      'hook:Intent',
      'hook:RequestValidation',
      'request:assertSponsorAvailable',
      'port:inflight.acquire',
      'hook:ChainSnapshot',
      'port:sponsor.checkout',
      'port:nonce.reserve',
      'hook:GasBoundBuild',
      'request:preparedDraftFields',
      'request:projectResponse',
      'port:commitPreparedReceipt',
      'port:inflight.release',
    ]);
  });

  test('promotion hook and host-port order matches an independent literal trace', async () => {
    const trace: Trace = [];
    const host = makeHost(trace);
    const request = await makePromotionRequest(host, trace);

    const response = await runPrepareStateMachine(host.host, request, makePromotionPolicy(trace));

    expect(trace).toEqual([
      'hook:Intent',
      'hook:RequestValidation',
      'request:assertSponsorAvailable',
      'port:inflight.acquire',
      'hook:ChainSnapshot',
      'port:sponsor.checkout',
      'hook:GasBoundBuild',
      'port:ledger.reserve',
      'request:preparedDraftFields',
      'request:projectResponse',
      'port:commitPreparedReceipt',
      'port:inflight.release',
    ]);
    await expect(
      host.sponsoredExecutionStore.readPreparedReceipt(response.receiptId),
    ).resolves.toMatchObject({
      mode: 'promotion',
      receiptId: response.receiptId,
      promotionId: TEST_PROMO,
      userId: TEST_USER,
      reservedGasMist: TEST_BUILD_RESULT.measuredGasMist,
    });
    await expect(host.ledger.getEntitlement(TEST_PROMO, TEST_USER)).resolves.toMatchObject({
      activeReservationReceiptId: response.receiptId,
      activeReservationAmountMist: TEST_BUILD_RESULT.measuredGasMist.toString(),
    });
  });
});

describe('runPrepareStateMachine commit boundary', () => {
  test('success uses one generated receipt for response, draft, committed entry, and store key', async () => {
    const trace: Trace = [];
    const host = makeHost(trace);

    const response = await runPrepareStateMachine(
      host.host,
      makeGenericRequest(trace),
      makeGenericPolicy(trace),
    );

    expect(response.receiptId).toMatch(/^0x[0-9a-f]{64}$/);
    expect(response.draftReceiptId).toBe(response.receiptId);
    expect(host.observedReceiptIds).toEqual({
      checkout: [response.receiptId],
      nonce: [response.receiptId],
      store: [response.receiptId],
    });
    await expect(
      host.sponsoredExecutionStore.readPreparedReceipt(response.receiptId),
    ).resolves.toMatchObject({
      receiptId: response.receiptId,
      txBytesHash: TEST_TX_BYTES_HASH,
    });
    expect(host.inflight.inflight).toBe(0);
  });

  test('response projection failure stores nothing and reverse-releases every acquired handle', async () => {
    const trace: Trace = [];
    const host = makeHost(trace);
    const request = await makePromotionRequest(host, trace, {
      projectionError: new Error('response projection failed'),
    });

    await expect(
      runPrepareStateMachine(host.host, request, makeAllReservationPolicy(trace)),
    ).rejects.toThrow('response projection failed');

    expect(trace).not.toContain('port:commitPreparedReceipt');
    expect(trace.slice(-5)).toEqual([
      'request:projectResponse',
      'port:ledger.release',
      'port:nonce.release',
      'port:sponsor.checkin',
      'port:inflight.release',
    ]);
    await expect(
      host.sponsoredExecutionStore.readPreparedReceipt(host.observedReceiptIds.checkout[0]!),
    ).resolves.toBeNull();
    await expect(host.ledger.getEntitlement(TEST_PROMO, TEST_USER)).resolves.toMatchObject({
      activeReservationReceiptId: null,
      activeReservationAmountMist: null,
    });
    expect(host.inflight.inflight).toBe(0);
    await expect(
      host.sponsoredExecutionStore.reserveNonce(TEST_SENDER, 0n, 'after-projection'),
    ).resolves.toBe(1n);
    await host.sponsoredExecutionStore.releaseNonceReservation('after-projection', TEST_SENDER);
    await expect(host.sponsorPool.checkout(alternateReceipt(0xb1))).resolves.not.toBeNull();
  });

  test('response projection cannot mutate the runner-owned store draft', async () => {
    const trace: Trace = [];
    const host = makeHost(trace);
    const request = makeGenericRequest(trace);

    await expect(
      runPrepareStateMachine(
        host.host,
        {
          ...request,
          projectResponse: ({ draft }) => {
            (draft as { receiptId: string }).receiptId = alternateReceipt(0xc1);
            return {
              receiptId: draft.receiptId,
              draftReceiptId: draft.receiptId,
              txBytesHash: draft.txBytesHash,
            };
          },
        },
        makeGenericPolicy(trace),
      ),
    ).rejects.toBeInstanceOf(TypeError);

    expect(trace).not.toContain('port:sponsor.commit');
    expect(trace).not.toContain('port:commitPreparedReceipt');
    await expect(
      host.sponsoredExecutionStore.readPreparedReceipt(host.observedReceiptIds.checkout[0]!),
    ).resolves.toBeNull();
    await expect(
      host.sponsoredExecutionStore.readPreparedReceipt(alternateReceipt(0xc1)),
    ).resolves.toBeNull();
    expect(host.inflight.inflight).toBe(0);
  });

  test('prepared-receipt commit failure reverse-releases every acquired handle', async () => {
    const trace: Trace = [];
    const host = makeHost(trace, {
      commitPreparedReceiptError: new Error('prepared receipt commit failed'),
    });
    const request = await makePromotionRequest(host, trace);

    await expect(
      runPrepareStateMachine(host.host, request, makeAllReservationPolicy(trace)),
    ).rejects.toThrow('prepared receipt commit failed');

    expect(trace.slice(-5)).toEqual([
      'port:commitPreparedReceipt',
      'port:ledger.release',
      'port:nonce.release',
      'port:sponsor.checkin',
      'port:inflight.release',
    ]);
    await expect(
      host.sponsoredExecutionStore.readPreparedReceipt(host.observedReceiptIds.store[0]!),
    ).resolves.toBeNull();
    await expect(host.ledger.getEntitlement(TEST_PROMO, TEST_USER)).resolves.toMatchObject({
      activeReservationReceiptId: null,
      activeReservationAmountMist: null,
    });
    expect(host.inflight.inflight).toBe(0);
    await expect(
      host.sponsoredExecutionStore.reserveNonce(TEST_SENDER, 0n, 'after-store'),
    ).resolves.toBe(1n);
    await host.sponsoredExecutionStore.releaseNonceReservation('after-store', TEST_SENDER);
    await expect(host.sponsorPool.checkout(alternateReceipt(0xb2))).resolves.not.toBeNull();
  });
});

describe('runPrepareStateMachine cleanup and admission failures', () => {
  test('GasBoundBuild failure releases generic nonce, sponsor slot, and inflight admission', async () => {
    const host = makeHost();

    await expect(
      runPrepareStateMachine(
        host.host,
        makeGenericRequest(),
        makeGenericPolicy([], { failAtHook: 'GasBoundBuild' }),
      ),
    ).rejects.toThrow('policy fault at GasBoundBuild');

    expect(host.inflight.inflight).toBe(0);
    await expect(
      host.sponsoredExecutionStore.readPreparedReceipt(host.observedReceiptIds.checkout[0]!),
    ).resolves.toBeNull();
    await expect(
      host.sponsoredExecutionStore.reserveNonce(TEST_SENDER, 0n, 'after-build'),
    ).resolves.toBe(1n);
    await host.sponsoredExecutionStore.releaseNonceReservation('after-build', TEST_SENDER);
    await expect(host.sponsorPool.checkout(alternateReceipt(0xbc))).resolves.not.toBeNull();
  });

  test('an early ChainSnapshot failure still releases inflight admission', async () => {
    const host = makeHost();

    await expect(
      runPrepareStateMachine(
        host.host,
        makeGenericRequest(),
        makeGenericPolicy([], { failAtHook: 'ChainSnapshot' }),
      ),
    ).rejects.toThrow('policy fault at ChainSnapshot');
    expect(host.inflight.inflight).toBe(0);
  });

  test('sponsor exhaustion is typed and releases inflight admission', async () => {
    const host = makeHost();
    await host.sponsorPool.checkout(alternateReceipt(0xee));

    await expect(
      runPrepareStateMachine(host.host, makeGenericRequest(), makeGenericPolicy()),
    ).rejects.toBeInstanceOf(RunnerSponsorSlotExhaustedError);
    expect(host.inflight.inflight).toBe(0);
  });

  test('promotion policy without an execution ledger fails closed', async () => {
    const host = makeHost();
    const request = await makePromotionRequest(host);
    const hostWithoutLedger: PrepareStateMachineHost = {
      inflightLimiter: host.host.inflightLimiter,
      sponsorPool: host.host.sponsorPool,
      sponsoredExecutionStore: host.host.sponsoredExecutionStore,
    };

    await expect(
      runPrepareStateMachine(hostWithoutLedger, request, makePromotionPolicy()),
    ).rejects.toBeInstanceOf(RunnerHostMisconfiguredError);
    expect(host.inflight.inflight).toBe(0);
  });

  test('generic policy without nonceAcquire snapshot fails closed', async () => {
    const host = makeHost();
    const generic = makeGenericPolicy();
    const policy: SponsoredExecutionPolicy = {
      ...generic,
      hooks: { ...generic.hooks, ChainSnapshot: () => ({}) },
    };

    await expect(
      runPrepareStateMachine(host.host, makeGenericRequest(), policy),
    ).rejects.toBeInstanceOf(RunnerHostMisconfiguredError);
    expect(host.inflight.inflight).toBe(0);
  });

  test('ledger rejection is typed and releases earlier resources', async () => {
    const host = makeHost();
    const request = await makePromotionRequest(host, [], { allowanceMist: '100' });

    await expect(
      runPrepareStateMachine(host.host, request, makePromotionPolicy()),
    ).rejects.toBeInstanceOf(RunnerLedgerReservationRejectedError);
    expect(host.inflight.inflight).toBe(0);
    await expect(host.sponsorPool.checkout(alternateReceipt(0xff))).resolves.not.toBeNull();
  });
});

describe('runPrepareStateMachine module API', () => {
  test('package main barrel does not re-export runner symbols', async () => {
    const mainBarrel = await import('../src/index.js');
    expect(Object.prototype.hasOwnProperty.call(mainBarrel, 'runPrepareStateMachine')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(mainBarrel, 'RunnerHostMisconfiguredError')).toBe(
      false,
    );
  });
});
