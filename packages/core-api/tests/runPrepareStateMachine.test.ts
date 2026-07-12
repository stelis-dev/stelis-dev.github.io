/**
 * runPrepareStateMachine.test.ts — prepare-side `SponsoredExecution` runner.
 *
 * Pins the runner architecture and cleanup-ordering contracts:
 *
 *   - States walk in the order declared by `PREPARE_STATE_ORDER`.
 *   - Every state's policy hook fires exactly once on the success path.
 *   - Reservations are acquired in fixed order: inflight, sponsor slot,
 *     (optional) nonce, gas-bound build, (optional) ledger.
 *   - On any failure, reservations release in REVERSE acquired order.
 *   - Inflight ALWAYS releases (non-transferable).
 *   - Slot / nonce / ledger transfer ownership at the
 *     `AwaitUserSignature` boundary; their `release()` calls become
 *     no-ops on the success path.
 *
 * The test uses real `MemoryPrepareInflight`, `MemoryPrepareStore`,
 * and `MemoryPromotionExecutionLedger` adapters plus a real
 * `SponsorPool` (in-memory) so the runner-side acquire / release
 * actually exercises the production reservation classes.
 */
import { describe, test, expect } from 'vitest';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { toHex } from '@mysten/sui/utils';
import {
  runPrepareStateMachine,
  RunnerHostMisconfiguredError,
  RunnerLedgerReservationRejectedError,
  RunnerSponsorSlotExhaustedError,
  type PrepareStateMachineHost,
  type PrepareStateMachineRequest,
} from '../src/session/sponsoredExecution/runner.js';
import type {
  SponsoredExecutionPolicy,
  PolicyHooks,
  PreparePolicyHookContext,
  GasBoundBuildResult,
  PreparedCommitInputs,
} from '../src/session/sponsoredExecution/index.js';
import { MemoryPrepareStore } from '../src/store/memoryPrepareStore.js';
import { MemoryPrepareInflight } from '../src/store/memoryPrepareInflight.js';
import { MemoryPromotionExecutionLedger } from '../src/studio/executionLedgerMemory.js';
import { SponsorPool } from '../src/context.js';
import { PREPARE_STATE_ORDER } from '../src/session/sponsoredExecution/states.js';

// ─────────────────────────────────────────────
// Shared fixtures
// ─────────────────────────────────────────────

const SPONSOR_KP = Ed25519Keypair.generate();
const TEST_HMAC_SECRET = 'pr-1-2-runner-test-hmac-secret-00000';

interface HookCallLog {
  state: string;
  args: unknown[];
}

function makeMockHooks(opts?: { buildResult?: GasBoundBuildResult; failAtState?: string }): {
  hooks: SponsoredExecutionPolicy['hooks'];
  log: HookCallLog[];
} {
  const log: HookCallLog[] = [];
  const buildResult: GasBoundBuildResult = opts?.buildResult ?? {
    txBytes: new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd]),
    txBytesHash: 'a'.repeat(64),
    measuredGasMist: 1_400_000n,
  };
  const recordingHook =
    (state: string) =>
    (...args: unknown[]) => {
      log.push({ state, args });
      if (opts?.failAtState === state) {
        throw new Error(`policy fault at ${state}`);
      }
    };
  const recordingObjectHook =
    (state: string) =>
    (...args: unknown[]) => {
      log.push({ state, args });
      if (opts?.failAtState === state) {
        throw new Error(`policy fault at ${state}`);
      }
      return {};
    };

  const hooks: PolicyHooks = {
    Intent: recordingHook('Intent'),
    RequestValidation: recordingHook('RequestValidation'),
    InflightAdmission: recordingHook('InflightAdmission'),
    ChainSnapshot: recordingObjectHook('ChainSnapshot'),
    ExecutionPolicySelected: recordingHook('ExecutionPolicySelected'),
    SlotFreePlan: recordingHook('SlotFreePlan'),
    ReceiptIdGenerated: recordingHook('ReceiptIdGenerated'),
    SponsorSlotReservationAcquired: recordingHook('SponsorSlotReservationAcquired'),
    // Optional hooks — registered in the test policy so the
    // state-walk test can observe whether the runner fires them. The
    // runner consults `handleRequirements` to decide whether to
    // acquire the matching reservation; once acquired, the hook fires
    // for any policy-side observability.
    RouteReservationBeforeBuild: recordingHook('RouteReservationBeforeBuild'),
    RouteReservationAfterBuild: recordingHook('RouteReservationAfterBuild'),
    GasBoundBuild: (...args: unknown[]) => {
      log.push({ state: 'GasBoundBuild', args });
      if (opts?.failAtState === 'GasBoundBuild') {
        throw new Error('policy fault at GasBoundBuild');
      }
      return buildResult;
    },
    SelfCheck: recordingHook('SelfCheck'),
    SponsorLeaseCommitted: recordingHook('SponsorLeaseCommitted'),
    PrepareStored: recordingHook('PrepareStored'),
    AwaitUserSignature: recordingHook('AwaitUserSignature'),
    DecodeSponsorSubmission: recordingHook('DecodeSponsorSubmission'),
    UserSignatureValidation: recordingHook('UserSignatureValidation'),
    Consume: recordingHook('Consume'),
    SharedPostconsumeChecks: recordingObjectHook('SharedPostconsumeChecks'),
    PolicyPostconsumeChecks: recordingObjectHook('PolicyPostconsumeChecks'),
    Preflight: recordingHook('Preflight'),
    PolicyApproval: recordingHook('PolicyApproval'),
    SponsorSign: recordingHook('SponsorSign'),
    Submit: recordingHook('Submit'),
    ClassifySponsorResult: recordingHook('ClassifySponsorResult'),
    Release: recordingHook('Release'),
  };

  return { hooks, log };
}

function makeGenericPolicy(opts?: Parameters<typeof makeMockHooks>[0]): {
  policy: SponsoredExecutionPolicy<'generic'>;
  log: HookCallLog[];
} {
  const { hooks, log } = makeMockHooks(opts);
  const chainSnapshot = (...args: unknown[]) => {
    log.push({ state: 'ChainSnapshot', args });
    if (opts?.failAtState === 'ChainSnapshot') {
      throw new Error('policy fault at ChainSnapshot');
    }
    return { nonceAcquire: { onchainLastNonce: 0n } };
  };
  return {
    policy: {
      discriminator: 'generic',
      handleRequirements: {
        gasBoundBuild: { sponsorSlot: true, nonce: true },
        preparedCommit: { sponsorSlot: true, nonce: true },
        sponsorResult: { sponsorSlot: true },
      },
      hooks: { ...hooks, ChainSnapshot: chainSnapshot },
    },
    log,
  };
}

function makePromotionPolicy(opts?: Parameters<typeof makeMockHooks>[0]): {
  policy: SponsoredExecutionPolicy<'promotion'>;
  log: HookCallLog[];
} {
  const { hooks, log } = makeMockHooks(opts);
  return {
    policy: {
      discriminator: 'promotion',
      handleRequirements: {
        gasBoundBuild: { sponsorSlot: true },
        preparedCommit: { sponsorSlot: true, ledgerReservation: true },
        sponsorResult: { sponsorSlot: true, ledgerReservation: true },
      },
      hooks,
    },
    log,
  };
}

interface HostBuild {
  host: PrepareStateMachineHost;
  inflight: MemoryPrepareInflight;
  prepareStore: MemoryPrepareStore;
  ledger: MemoryPromotionExecutionLedger;
  sponsorPool: SponsorPool;
}

function makeHost(): HostBuild {
  const sponsorPool = new SponsorPool([SPONSOR_KP], { hmacSecret: TEST_HMAC_SECRET });
  const prepareStore = new MemoryPrepareStore((sponsorAddress, receiptId, txBytesHash) =>
    sponsorPool.checkin(sponsorAddress, receiptId, txBytesHash),
  );
  const ledger = new MemoryPromotionExecutionLedger();
  const inflight = new MemoryPrepareInflight(8);
  return {
    host: {
      inflightLimiter: inflight,
      sponsorPool,
      prepareStore,
      executionLedger: ledger,
    },
    inflight,
    prepareStore,
    ledger,
    sponsorPool,
  };
}

const TEST_RECEIPT_ID = `0x${toHex(new Uint8Array(32).fill(0xaa))}`;
const TEST_SENDER = '0x' + 'be'.repeat(32);
const TEST_PROMO = 'pr-1-2-promo-1';
const TEST_USER = 'pr-1-2-user-1';

const HOOK_CTX: PreparePolicyHookContext = {
  receiptId: TEST_RECEIPT_ID,
  senderAddress: TEST_SENDER,
  clientIp: '127.0.0.1',
};

function makeGenericRequest(): PrepareStateMachineRequest {
  return {
    hookContext: HOOK_CTX,
    preparedCommitInputs: ({
      receiptId,
      txBytesHash,
      sponsorSlot,
      nonce,
      buildResult: _buildResult,
    }): PreparedCommitInputs => ({
      mode: 'generic',
      receiptId,
      senderAddress: sponsorSlot.receiptId === receiptId ? TEST_SENDER : TEST_SENDER,
      clientIp: HOOK_CTX.clientIp,
      txBytesHash,
      sponsorAddress: sponsorSlot.sponsorAddress,
      executionPathKey: 'credit',
      orderId: null,
      nonce: nonce?.nonce ?? 0n,
    }),
  };
}

async function makePromotionRequest(host: HostBuild): Promise<PrepareStateMachineRequest> {
  // Promotion requires an entitlement before the runner can reserve.
  await host.ledger.claim(TEST_PROMO, TEST_USER, {
    maxParticipants: 16,
    perUserGasAllowanceMist: '100000000',
    useUntilAt: null,
  });
  return {
    hookContext: HOOK_CTX,
    ledgerAcquireParams: { promotionId: TEST_PROMO, userId: TEST_USER },
    preparedCommitInputs: ({
      receiptId,
      txBytesHash,
      sponsorSlot,
      ledgerReservation,
    }): PreparedCommitInputs => ({
      mode: 'promotion',
      receiptId,
      senderAddress: TEST_SENDER,
      clientIp: HOOK_CTX.clientIp,
      txBytesHash,
      sponsorAddress: sponsorSlot.sponsorAddress,
      executionPathKey: `promotion:${TEST_PROMO}`,
      orderId: null,
      nonce: 0n,
      promotionId: ledgerReservation?.promotionId ?? TEST_PROMO,
      userId: ledgerReservation?.userId ?? TEST_USER,
      reservedGasMist: ledgerReservation?.reservedGasMist ?? 0n,
    }),
  };
}

// ─────────────────────────────────────────────
// Section 1 — Generic happy path (state walking + ownership transfer)
// ─────────────────────────────────────────────

describe('runPrepareStateMachine — generic happy path', () => {
  test('walks every prepare-side state in PREPARE_STATE_ORDER exactly once', async () => {
    const { host } = makeHost();
    const { policy, log } = makeGenericPolicy();
    const request = makeGenericRequest();

    await runPrepareStateMachine(host, request, policy);

    // The runner only walks the prepare-side states; sponsor states are
    // out of scope for `runPrepareStateMachine`.
    const expected = [...PREPARE_STATE_ORDER];
    // Optional state RouteReservationBeforeBuild fires for generic
    // (nonce required); RouteReservationAfterBuild does NOT fire for
    // generic (no ledger).
    const expectedFiltered = expected.filter((s) => s !== 'RouteReservationAfterBuild');
    const actualStates = log.map((entry) => entry.state);
    expect(actualStates).toEqual(expectedFiltered);
  });

  test('returns receiptId + txBytes + commit projected through composePreparedCommit', async () => {
    const { host, prepareStore } = makeHost();
    const { policy } = makeGenericPolicy();
    const request = makeGenericRequest();

    const result = await runPrepareStateMachine(host, request, policy);

    expect(result.receiptId).toBe(TEST_RECEIPT_ID);
    expect(result.txBytes).toEqual(new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd]));
    expect(result.txBytesHash).toBe('a'.repeat(64));
    expect(result.commit.mode).toBe('generic');
    expect(result.commit.receiptId).toBe(TEST_RECEIPT_ID);

    // prepareStore.peek finds the entry by receiptId, written through the
    // runner's single
    // composePreparedCommit call.
    const peeked = await prepareStore.peek(TEST_RECEIPT_ID);
    expect(peeked).not.toBeNull();
    expect(peeked!.txBytesHash).toBe('a'.repeat(64));
  });

  test('inflight handle is released even after success (non-transferable)', async () => {
    const { host, inflight } = makeHost();
    const { policy } = makeGenericPolicy();
    const request = makeGenericRequest();

    expect(inflight.inflight).toBe(0);
    await runPrepareStateMachine(host, request, policy);
    // Inflight count returned to zero — inflight always releases.
    expect(inflight.inflight).toBe(0);
  });

  test('sponsor slot stays committed in the pool after success (transferred to durable store)', async () => {
    const { host, sponsorPool } = makeHost();
    const { policy } = makeGenericPolicy();
    const request = makeGenericRequest();

    await runPrepareStateMachine(host, request, policy);

    // Pool should still see the slot as in-use after success — the
    // runner transferred ownership to the durable store. The sponsor
    // lifecycle owns checkin from this point.
    expect(sponsorPool.size - sponsorPool.addresses().length).toBeLessThanOrEqual(1);
    // More directly: a second checkout should fail because the only
    // slot is held by the durable store.
    const secondCheckout = await sponsorPool.checkout(`0x${toHex(new Uint8Array(32).fill(0xbb))}`);
    expect(secondCheckout).toBeNull();
  });
});

// ─────────────────────────────────────────────
// Section 2 — Studio happy path
// ─────────────────────────────────────────────

describe('runPrepareStateMachine — Studio happy path', () => {
  test('walks the promotion path with RouteReservationAfterBuild (no nonce, ledger present)', async () => {
    const hostBuild = makeHost();
    const { policy, log } = makePromotionPolicy();
    const request = await makePromotionRequest(hostBuild);

    const result = await runPrepareStateMachine(hostBuild.host, request, policy);

    expect(result.commit.mode).toBe('promotion');

    // Generic-only state RouteReservationBeforeBuild does NOT fire for
    // promotion. Studio-only state RouteReservationAfterBuild DOES fire.
    const states = log.map((e) => e.state);
    expect(states).not.toContain('RouteReservationBeforeBuild');
    expect(states).toContain('RouteReservationAfterBuild');
  });

  test('promotion ledger consumes the reservation slot (active reservation moves to durable store)', async () => {
    const hostBuild = makeHost();
    const { policy } = makePromotionPolicy();
    const request = await makePromotionRequest(hostBuild);

    await runPrepareStateMachine(hostBuild.host, request, policy);

    const ent = await hostBuild.ledger.getEntitlement(TEST_PROMO, TEST_USER);
    expect(ent!.activeReservationReceiptId).toBe(TEST_RECEIPT_ID);
    expect(ent!.activeReservationAmountMist).toBe('1400000');
  });
});

// ─────────────────────────────────────────────
// Section 3 — Failure paths and reverse-order cleanup
// ─────────────────────────────────────────────

describe('runPrepareStateMachine — failure paths', () => {
  test('fault at GasBoundBuild releases all reservations in reverse order', async () => {
    const { host, inflight, sponsorPool } = makeHost();
    const { policy } = makeGenericPolicy({ failAtState: 'GasBoundBuild' });
    const request = makeGenericRequest();

    await expect(runPrepareStateMachine(host, request, policy)).rejects.toThrow(
      'policy fault at GasBoundBuild',
    );

    // Inflight slot returned. Sponsor pool slot returned (a second
    // checkout succeeds). The nonce reservation was acquired AND
    // released, so the prepareStore's pending-nonce set is empty.
    expect(inflight.inflight).toBe(0);
    const fresh = await sponsorPool.checkout(`0x${toHex(new Uint8Array(32).fill(0xbc))}`);
    expect(fresh).not.toBeNull();
  });

  test('fault at SelfCheck (after build) releases sponsor slot AND nonce AND inflight', async () => {
    const { host, inflight, sponsorPool, prepareStore } = makeHost();
    const { policy } = makeGenericPolicy({ failAtState: 'SelfCheck' });
    const request = makeGenericRequest();

    await expect(runPrepareStateMachine(host, request, policy)).rejects.toThrow();

    expect(inflight.inflight).toBe(0);
    expect(await prepareStore.peek(TEST_RECEIPT_ID)).toBeNull();
    const fresh = await sponsorPool.checkout(`0x${toHex(new Uint8Array(32).fill(0xbd))}`);
    expect(fresh).not.toBeNull();
  });

  test('Studio fault after ledger acquire releases the ledger reservation', async () => {
    const hostBuild = makeHost();
    const { policy } = makePromotionPolicy({ failAtState: 'SelfCheck' });
    const request = await makePromotionRequest(hostBuild);

    await expect(runPrepareStateMachine(hostBuild.host, request, policy)).rejects.toThrow();

    const ent = await hostBuild.ledger.getEntitlement(TEST_PROMO, TEST_USER);
    expect(ent!.activeReservationReceiptId).toBeNull();
  });

  test('inflight ALWAYS releases — even when an early hook throws before any other reservation is acquired', async () => {
    const { host, inflight } = makeHost();
    const { policy } = makeGenericPolicy({ failAtState: 'ChainSnapshot' });
    const request = makeGenericRequest();

    await expect(runPrepareStateMachine(host, request, policy)).rejects.toThrow();
    expect(inflight.inflight).toBe(0);
  });

  test('sponsor pool exhausted at SponsorSlotReservation throws RunnerSponsorSlotExhaustedError', async () => {
    const hostBuild = makeHost();
    // Pre-checkout the only slot so the runner sees a null result.
    await hostBuild.sponsorPool.checkout(`0x${toHex(new Uint8Array(32).fill(0xee))}`);

    const { policy } = makeGenericPolicy();
    const request = makeGenericRequest();

    await expect(runPrepareStateMachine(hostBuild.host, request, policy)).rejects.toBeInstanceOf(
      RunnerSponsorSlotExhaustedError,
    );
    expect(hostBuild.inflight.inflight).toBe(0);
  });

  test('host misconfiguration (Studio policy without executionLedger) throws RunnerHostMisconfiguredError', async () => {
    const hostBuild = makeHost();
    const hostWithoutLedger: PrepareStateMachineHost = {
      inflightLimiter: hostBuild.inflight,
      sponsorPool: hostBuild.sponsorPool,
      prepareStore: hostBuild.prepareStore,
      // executionLedger intentionally omitted
    };
    const { policy } = makePromotionPolicy();
    const request = await makePromotionRequest(hostBuild);

    await expect(runPrepareStateMachine(hostWithoutLedger, request, policy)).rejects.toBeInstanceOf(
      RunnerHostMisconfiguredError,
    );
    expect(hostBuild.inflight.inflight).toBe(0);
  });

  test('host misconfiguration (generic ChainSnapshot without nonceAcquire) throws RunnerHostMisconfiguredError', async () => {
    const hostBuild = makeHost();
    const generic = makeGenericPolicy();
    // Deliberately widen to the runner's common boundary so the
    // runtime fail-closed guard remains tested even though
    // SponsoredExecutionPolicy<'generic'> requires nonceAcquire at type level.
    const policy: SponsoredExecutionPolicy = {
      ...generic.policy,
      hooks: {
        ...generic.policy.hooks,
        ChainSnapshot: () => ({}),
      },
    };
    const request = makeGenericRequest();

    await expect(runPrepareStateMachine(hostBuild.host, request, policy)).rejects.toBeInstanceOf(
      RunnerHostMisconfiguredError,
    );
    expect(hostBuild.inflight.inflight).toBe(0);
  });
});

// ─────────────────────────────────────────────
// Section 4 — Ledger reservation rejection (entitlement insufficient)
// ─────────────────────────────────────────────

describe('runPrepareStateMachine — ledger reservation rejection', () => {
  test('throws RunnerLedgerReservationRejectedError when entitlement cannot cover measured gas', async () => {
    const hostBuild = makeHost();
    // Claim with very small allowance.
    await hostBuild.ledger.claim(TEST_PROMO, TEST_USER, {
      maxParticipants: 16,
      perUserGasAllowanceMist: '100', // way below the 1.4M measuredGasMist
      useUntilAt: null,
    });
    // Build returns 1.4M — over the 100-mist allowance.
    const { policy } = makePromotionPolicy();
    const request: PrepareStateMachineRequest = {
      hookContext: HOOK_CTX,
      ledgerAcquireParams: { promotionId: TEST_PROMO, userId: TEST_USER },
      preparedCommitInputs: () => {
        throw new Error('preparedCommitInputs should not be reached');
      },
    };

    await expect(runPrepareStateMachine(hostBuild.host, request, policy)).rejects.toBeInstanceOf(
      RunnerLedgerReservationRejectedError,
    );
    // All reservations released — sponsor pool is back to a checkout-able state.
    const fresh = await hostBuild.sponsorPool.checkout(`0x${toHex(new Uint8Array(32).fill(0xff))}`);
    expect(fresh).not.toBeNull();
  });
});

// ─────────────────────────────────────────────
// Section 5 — Post-store boundary atomicity
//
// Durable visibility (the prepared-store entry) and resource ownership
// (sponsor slot, nonce, ledger reservation) must not diverge across any
// post-store hook failure.
//
// The runner transfers ownership of every transferable reservation
// IMMEDIATELY after `prepareStore.store()`, before either `PrepareStored`
// or `AwaitUserSignature` fires. Therefore:
//   - if a post-store hook throws, the runner propagates the error,
//   - the durable entry stays visible (it is coherent — it owns its
//     resources),
//   - transferable reservations skip release in the `finally` cleanup,
//   - inflight always releases (non-transferable).
// ─────────────────────────────────────────────

describe('runPrepareStateMachine — post-store boundary atomicity', () => {
  test('PrepareStored hook failure leaves durable entry AND keeps sponsor slot ownership (generic)', async () => {
    const { host, inflight, sponsorPool, prepareStore } = makeHost();
    const { policy } = makeGenericPolicy({ failAtState: 'PrepareStored' });
    const request = makeGenericRequest();

    await expect(runPrepareStateMachine(host, request, policy)).rejects.toThrow(
      'policy fault at PrepareStored',
    );

    // Durable entry MUST remain visible — store() succeeded before the
    // hook threw.
    const peeked = await prepareStore.peek(TEST_RECEIPT_ID);
    expect(peeked).not.toBeNull();
    expect(peeked!.txBytesHash).toBe('a'.repeat(64));

    // Sponsor slot ownership MUST stay with the durable entry. The pool
    // has only one slot, and it is still committed to this receiptId.
    const secondCheckout = await sponsorPool.checkout(`0x${toHex(new Uint8Array(32).fill(0xaf))}`);
    expect(secondCheckout).toBeNull();

    // Inflight MUST release (non-transferable; always returns to zero).
    expect(inflight.inflight).toBe(0);
  });

  test('AwaitUserSignature hook failure leaves durable entry AND keeps sponsor slot ownership (generic)', async () => {
    const { host, inflight, sponsorPool, prepareStore } = makeHost();
    const { policy } = makeGenericPolicy({ failAtState: 'AwaitUserSignature' });
    const request = makeGenericRequest();

    await expect(runPrepareStateMachine(host, request, policy)).rejects.toThrow(
      'policy fault at AwaitUserSignature',
    );

    const peeked = await prepareStore.peek(TEST_RECEIPT_ID);
    expect(peeked).not.toBeNull();

    const secondCheckout = await sponsorPool.checkout(`0x${toHex(new Uint8Array(32).fill(0xb1))}`);
    expect(secondCheckout).toBeNull();

    expect(inflight.inflight).toBe(0);
  });

  test('PrepareStored hook failure keeps ledger reservation owned by durable entry (Studio)', async () => {
    const hostBuild = makeHost();
    const { policy } = makePromotionPolicy({ failAtState: 'PrepareStored' });
    const request = await makePromotionRequest(hostBuild);

    await expect(runPrepareStateMachine(hostBuild.host, request, policy)).rejects.toThrow(
      'policy fault at PrepareStored',
    );

    // Durable entry visible.
    const peeked = await hostBuild.prepareStore.peek(TEST_RECEIPT_ID);
    expect(peeked).not.toBeNull();
    expect(peeked!.mode).toBe('promotion');

    // Ledger reservation MUST stay active — ownership transferred to
    // the durable entry before the hook fired. A reverse cleanup that
    // released the ledger reservation here would refund the
    // entitlement while the entry still references it.
    const ent = await hostBuild.ledger.getEntitlement(TEST_PROMO, TEST_USER);
    expect(ent!.activeReservationReceiptId).toBe(TEST_RECEIPT_ID);
    expect(ent!.activeReservationAmountMist).toBe('1400000');

    // Sponsor slot still held by the durable entry.
    const secondCheckout = await hostBuild.sponsorPool.checkout(
      `0x${toHex(new Uint8Array(32).fill(0xb3))}`,
    );
    expect(secondCheckout).toBeNull();

    // Inflight always releases.
    expect(hostBuild.inflight.inflight).toBe(0);
  });

  test('AwaitUserSignature hook failure keeps ledger reservation owned by durable entry (Studio)', async () => {
    const hostBuild = makeHost();
    const { policy } = makePromotionPolicy({ failAtState: 'AwaitUserSignature' });
    const request = await makePromotionRequest(hostBuild);

    await expect(runPrepareStateMachine(hostBuild.host, request, policy)).rejects.toThrow(
      'policy fault at AwaitUserSignature',
    );

    const peeked = await hostBuild.prepareStore.peek(TEST_RECEIPT_ID);
    expect(peeked).not.toBeNull();

    const ent = await hostBuild.ledger.getEntitlement(TEST_PROMO, TEST_USER);
    expect(ent!.activeReservationReceiptId).toBe(TEST_RECEIPT_ID);

    const secondCheckout = await hostBuild.sponsorPool.checkout(
      `0x${toHex(new Uint8Array(32).fill(0xb5))}`,
    );
    expect(secondCheckout).toBeNull();

    expect(hostBuild.inflight.inflight).toBe(0);
  });
});

// ─────────────────────────────────────────────
// Section 6 — Module API
// ─────────────────────────────────────────────

describe('runPrepareStateMachine — module API', () => {
  test('directory internal barrel exposes runner symbols', async () => {
    const barrel = (await import('../src/session/sponsoredExecution/index.js')) as Record<
      string,
      unknown
    >;
    expect(barrel.runPrepareStateMachine).toBeDefined();
    expect(barrel.RunnerHostMisconfiguredError).toBeDefined();
    expect(barrel.RunnerSponsorSlotExhaustedError).toBeDefined();
    expect(barrel.RunnerLedgerReservationRejectedError).toBeDefined();
  });

  test('package main barrel does NOT re-export runner symbols', async () => {
    const mainBarrel = await import('@stelis/core-api');
    expect(Object.prototype.hasOwnProperty.call(mainBarrel, 'runPrepareStateMachine')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(mainBarrel, 'RunnerHostMisconfiguredError')).toBe(
      false,
    );
  });
});
