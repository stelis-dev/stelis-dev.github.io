/**
 * sponsoredExecutionLifecycle.test.ts — sponsored-execution lifecycle locks.
 *
 * Pins the type-level + runtime-guard contracts introduced in
 * `packages/core-api/src/session/sponsoredExecution/`:
 *
 *   - state vocabulary + HTTP phase map,
 *   - branded reservation handle construction (factory-key gate, internal-only
 *     factory access),
 *   - post-release / post-consume runtime guard
 *     (`ReservationHandleClosedError`),
 *   - per-stage reservation handle shapes (GasBoundBuild excludes
 *     `LedgerReservationHandle`; prepare-store commit and ClassifySponsorResult carry
 *     it),
 *   - GasBoundBuildInput reservation handle presence + liveness check,
 *   - sponsor-phase reconstruction shape parity,
 *   - SponsoredExecutionPolicy hook signatures + registry exhaustiveness with
 *     exact-key enforcement.
 *
 * Tests under `packages/*\/tests/**` are explicitly allowed to reach the
 * `__testingReservationHandleInternals` re-export.
 */
import { describe, test, expect } from 'vitest';
import {
  PREPARE_STATE_ORDER,
  SPONSOR_STATE_ORDER,
  STATE_SPONSORED_EXECUTION_PHASE,
  PREPARE_FORWARD_TRANSITIONS,
  SPONSOR_FORWARD_TRANSITIONS,
  OPTIONAL_PREPARE_STATES,
  type SponsoredExecutionState,
  type PrepareState,
  type SponsorState,
} from '../src/session/sponsoredExecution/states.js';
import {
  ReservationHandleClosedError,
  ReservationHandleConstructionError,
  reconstructReservationHandles,
  createGasBoundBuildInput,
  __testingReservationHandleInternals,
  type SponsorSlotReservationHandle,
  type NonceReservationHandle,
  type LedgerReservationHandle,
  type GasBoundBuildReservationHandles,
  type PreparedCommitReservationHandles,
  type SponsorResultReservationHandles,
} from '../src/session/sponsoredExecution/reservationHandles.js';
import {
  createSponsoredExecutionPolicyRegistry,
  SponsoredExecutionPolicyRegistryError,
  type SponsoredExecutionPolicy,
  type SponsoredExecutionPolicyRegistry,
  type PolicyDiscriminator,
  type PolicyHooks,
} from '../src/session/sponsoredExecution/executionPolicy.js';

const {
  SponsorSlotReservationHandleImpl,
  NonceReservationHandleImpl,
  LedgerReservationHandleImpl,
} = __testingReservationHandleInternals;

// ─────────────────────────────────────────────
// Section 1 — state vocabulary and HTTP phase map
// ─────────────────────────────────────────────

describe('SponsoredExecution — state vocabulary', () => {
  test('PREPARE_STATE_ORDER and SPONSOR_STATE_ORDER are non-empty and disjoint', () => {
    expect(PREPARE_STATE_ORDER.length).toBeGreaterThan(0);
    expect(SPONSOR_STATE_ORDER.length).toBeGreaterThan(0);
    const overlap = PREPARE_STATE_ORDER.filter((s) =>
      (SPONSOR_STATE_ORDER as readonly string[]).includes(s),
    );
    expect(overlap).toEqual([]);
  });

  test('STATE_SPONSORED_EXECUTION_PHASE covers every state literal exactly once', () => {
    const allStates: SponsoredExecutionState[] = [...PREPARE_STATE_ORDER, ...SPONSOR_STATE_ORDER];
    for (const s of allStates) {
      expect(STATE_SPONSORED_EXECUTION_PHASE[s]).toBeDefined();
    }
    const mappedKeys = Object.keys(STATE_SPONSORED_EXECUTION_PHASE) as SponsoredExecutionState[];
    expect(mappedKeys.length).toBe(allStates.length);
  });

  test('every prepare-side state maps to phase=prepare; every sponsor-side state maps to phase=sponsor', () => {
    for (const s of PREPARE_STATE_ORDER) expect(STATE_SPONSORED_EXECUTION_PHASE[s]).toBe('prepare');
    for (const s of SPONSOR_STATE_ORDER) expect(STATE_SPONSORED_EXECUTION_PHASE[s]).toBe('sponsor');
  });

  test('forward transitions stay within their HTTP phase (no synthetic edge bridging /prepare to /sponsor)', () => {
    for (const t of PREPARE_FORWARD_TRANSITIONS) {
      expect(STATE_SPONSORED_EXECUTION_PHASE[t.from]).toBe('prepare');
      expect(STATE_SPONSORED_EXECUTION_PHASE[t.to]).toBe('prepare');
    }
    for (const t of SPONSOR_FORWARD_TRANSITIONS) {
      expect(STATE_SPONSORED_EXECUTION_PHASE[t.from]).toBe('sponsor');
      expect(STATE_SPONSORED_EXECUTION_PHASE[t.to]).toBe('sponsor');
    }
  });

  test('AwaitUserSignature ends the prepare run; DecodeSponsorSubmission begins the sponsor run', () => {
    const lastPrepare: PrepareState = PREPARE_STATE_ORDER[PREPARE_STATE_ORDER.length - 1]!;
    const firstSponsor: SponsorState = SPONSOR_STATE_ORDER[0]!;
    expect(lastPrepare).toBe('AwaitUserSignature');
    expect(firstSponsor).toBe('DecodeSponsorSubmission');
    const fromPrepareToSponsor = PREPARE_FORWARD_TRANSITIONS.some(
      (t) => (t.to as string) === 'DecodeSponsorSubmission',
    );
    expect(fromPrepareToSponsor).toBe(false);
  });

  test('OPTIONAL_PREPARE_STATES is exactly { RouteReservationBeforeBuild, RouteReservationAfterBuild }', () => {
    expect([...OPTIONAL_PREPARE_STATES].sort()).toEqual([
      'RouteReservationAfterBuild',
      'RouteReservationBeforeBuild',
    ]);
  });
});

// ─────────────────────────────────────────────
// Section 2 — reservation handle construction guard + module API
// ─────────────────────────────────────────────

describe('SponsoredExecution — reservation handle construction guard', () => {
  test('reconstructReservationHandles (the public mint API) issues live tokens', () => {
    const slot = reconstructReservationHandles.sponsorSlot({
      sponsorAddress: '0xSPONSOR',
      receiptId: '0xR',
    });
    expect(slot.reservationKind).toBe('SponsorSlot');
    expect(slot.isLive()).toBe(true);
    expect(slot.sponsorAddress).toBe('0xSPONSOR');
  });

  test('direct constructor call with a forged factory key is rejected at runtime', () => {
    // The constructors accept a `unique symbol` typed factory key. A forged
    // symbol passed via `unknown` cast is the only way to even reach the
    // constructor body, and the runtime identity check rejects it.
    const fakeKey = Symbol('fake') as unknown as Parameters<
      typeof SponsorSlotReservationHandleImpl
    >[0];
    expect(() => new SponsorSlotReservationHandleImpl(fakeKey, '0xS', '0xR')).toThrow(
      ReservationHandleConstructionError,
    );
    expect(() => new NonceReservationHandleImpl(fakeKey, 1n, '0xS', '0xR')).toThrow(
      ReservationHandleConstructionError,
    );
    expect(() => new LedgerReservationHandleImpl(fakeKey, '0xR', 'p1', 'u1', 1_000n)).toThrow(
      ReservationHandleConstructionError,
    );
  });

  test('the directory-internal index.ts barrel does NOT re-export the raw factory key, factory, or impl classes', async () => {
    const internalBarrel = (await import('../src/session/sponsoredExecution/index.js')) as Record<
      string,
      unknown
    >;
    // Public mint helpers must be present.
    expect(internalBarrel.reconstructReservationHandles).toBeDefined();
    expect(internalBarrel.createGasBoundBuildInput).toBeDefined();
    // Raw construction API must NOT be reachable through the internal barrel.
    expect(internalBarrel.RESERVATION_HANDLE_FACTORY_KEY).toBeUndefined();
    expect(internalBarrel.internalReservationHandleFactory).toBeUndefined();
    expect(internalBarrel.SponsorSlotReservationHandleImpl).toBeUndefined();
    expect(internalBarrel.NonceReservationHandleImpl).toBeUndefined();
    expect(internalBarrel.LedgerReservationHandleImpl).toBeUndefined();
    expect(internalBarrel.__testingReservationHandleInternals).toBeUndefined();
  });

  test('the package main barrel does NOT re-export any SponsoredExecution API', async () => {
    const mainBarrel = await import('@stelis/core-api');
    expect(Object.prototype.hasOwnProperty.call(mainBarrel, 'reconstructReservationHandles')).toBe(
      false,
    );
    expect(Object.prototype.hasOwnProperty.call(mainBarrel, 'createGasBoundBuildInput')).toBe(
      false,
    );
    expect(
      Object.prototype.hasOwnProperty.call(mainBarrel, 'createSponsoredExecutionPolicyRegistry'),
    ).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(mainBarrel, 'PREPARE_STATE_ORDER')).toBe(false);
  });
});

// ─────────────────────────────────────────────
// Section 3 — post-release / post-consume guard
// ─────────────────────────────────────────────

describe('SponsoredExecution — post-release / post-consume guard', () => {
  test('after release(), every payload getter throws ReservationHandleClosedError(reason="released")', () => {
    const slot = reconstructReservationHandles.sponsorSlot({
      sponsorAddress: '0xSPONSOR',
      receiptId: '0xR',
    });
    slot.release();
    expect(slot.isLive()).toBe(false);
    expect(() => slot.sponsorAddress).toThrow(ReservationHandleClosedError);
    try {
      void slot.sponsorAddress;
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ReservationHandleClosedError);
      expect((err as ReservationHandleClosedError).reason).toBe('released');
      expect((err as ReservationHandleClosedError).reservationKind).toBe('SponsorSlot');
    }
  });

  test('after consume(), every payload getter throws ReservationHandleClosedError(reason="consumed")', () => {
    const ledger = reconstructReservationHandles.ledgerReservation({
      receiptId: '0xR',
      promotionId: 'promo-1',
      userId: 'user-1',
      reservedGasMist: 1_400_000n,
      ledgerLookupVerified: true,
    });
    ledger.consume();
    expect(ledger.isLive()).toBe(false);
    try {
      void ledger.reservedGasMist;
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ReservationHandleClosedError);
      expect((err as ReservationHandleClosedError).reason).toBe('consumed');
      expect((err as ReservationHandleClosedError).reservationKind).toBe('LedgerReservation');
    }
  });

  test('release() is idempotent on an already-released handle; no double-throw', () => {
    const nonce = reconstructReservationHandles.nonce({
      nonce: 1n,
      senderAddress: '0xS',
      receiptId: '0xR',
      inPtbNonceMatch: true,
    });
    nonce.release();
    expect(() => nonce.release()).not.toThrow();
    expect(nonce.isLive()).toBe(false);
  });

  test('release() after consume() throws — releasing a consumed token would mask the entitlement debit', () => {
    const ledger = reconstructReservationHandles.ledgerReservation({
      receiptId: '0xR',
      promotionId: 'p',
      userId: 'u',
      reservedGasMist: 1n,
      ledgerLookupVerified: true,
    });
    ledger.consume();
    expect(() => ledger.release()).toThrow(ReservationHandleClosedError);
  });

  test('consume() after release() throws — a released token cannot be debited', () => {
    const ledger = reconstructReservationHandles.ledgerReservation({
      receiptId: '0xR',
      promotionId: 'p',
      userId: 'u',
      reservedGasMist: 1n,
      ledgerLookupVerified: true,
    });
    ledger.release();
    expect(() => ledger.consume()).toThrow(ReservationHandleClosedError);
  });

  test('double consume() throws — entitlement double-spend prevention', () => {
    const ledger = reconstructReservationHandles.ledgerReservation({
      receiptId: '0xR',
      promotionId: 'p',
      userId: 'u',
      reservedGasMist: 1n,
      ledgerLookupVerified: true,
    });
    ledger.consume();
    expect(() => ledger.consume()).toThrow(ReservationHandleClosedError);
  });
});

// ─────────────────────────────────────────────
// Section 4 — per-stage reservation handle shapes (F2 lock)
// ─────────────────────────────────────────────

describe('SponsoredExecution — per-stage reservation handle shapes', () => {
  test('GasBoundBuildReservationHandles does NOT carry ledgerReservation', () => {
    // Type-level lock: the field is intentionally absent. Adding
    // `ledgerReservation?: LedgerReservationHandle` to GasBoundBuildReservationHandles
    // would violate the lifecycle boundary: the ledger reservation is acquired
    // AFTER GasBoundBuild.
    const slot = reconstructReservationHandles.sponsorSlot({
      sponsorAddress: '0xSPONSOR',
      receiptId: '0xR',
    });
    const ev: GasBoundBuildReservationHandles = { sponsorSlot: slot };
    // Use Object.keys for shape parity. `nonce` is the only legal optional key.
    const allowedKeys = new Set(['sponsorSlot', 'nonce']);
    for (const k of Object.keys(ev)) {
      expect(allowedKeys.has(k)).toBe(true);
    }
    // The TypeScript type `GasBoundBuildReservationHandles` does not name
    // `ledgerReservation` at all, so a getter for it would compile-error.
    expect((ev as Record<string, unknown>).ledgerReservation).toBeUndefined();
  });

  test('PreparedCommitReservationHandles carries both nonce and ledgerReservation as optional fields', () => {
    const slot = reconstructReservationHandles.sponsorSlot({
      sponsorAddress: '0xSPONSOR',
      receiptId: '0xR',
    });
    const nonce = reconstructReservationHandles.nonce({
      nonce: 1n,
      senderAddress: '0xS',
      receiptId: '0xR',
      inPtbNonceMatch: true,
    });
    const ledger = reconstructReservationHandles.ledgerReservation({
      receiptId: '0xR',
      promotionId: 'p',
      userId: 'u',
      reservedGasMist: 1_400_000n,
      ledgerLookupVerified: true,
    });
    const ev: PreparedCommitReservationHandles = {
      sponsorSlot: slot,
      nonce,
      ledgerReservation: ledger,
    };
    expect(ev.nonce?.reservationKind).toBe('Nonce');
    expect(ev.ledgerReservation?.reservationKind).toBe('LedgerReservation');
  });

  test('SponsorResultReservationHandles carries ledgerReservation but NOT nonce', () => {
    // Type-level lock: nonce has no sponsor result verb. The in-PTB nonce match
    // already happened at SharedPostconsumeChecks.
    const slot = reconstructReservationHandles.sponsorSlot({
      sponsorAddress: '0xSPONSOR',
      receiptId: '0xR',
    });
    const ev: SponsorResultReservationHandles = { sponsorSlot: slot };
    expect((ev as Record<string, unknown>).nonce).toBeUndefined();
  });
});

// ─────────────────────────────────────────────
// Section 5 — GasBoundBuildInput handle requirements
// ─────────────────────────────────────────────

describe('SponsoredExecution — GasBoundBuildInput reservation handle gate', () => {
  test('builder accepts SponsorSlotReservationHandle-only input (Studio-style ledger reservation arrives after build)', () => {
    const slot = reconstructReservationHandles.sponsorSlot({
      sponsorAddress: '0xSPONSOR',
      receiptId: '0xR',
    });
    const input = createGasBoundBuildInput({ sponsorSlot: slot });
    expect(input.reservationHandles.sponsorSlot).toBe(slot);
    expect(input.reservationHandles.nonce).toBeUndefined();
  });

  test('builder accepts SponsorSlot + Nonce (generic-style)', () => {
    const slot = reconstructReservationHandles.sponsorSlot({
      sponsorAddress: '0xSPONSOR',
      receiptId: '0xR',
    });
    const nonce = reconstructReservationHandles.nonce({
      nonce: 1n,
      senderAddress: '0xS',
      receiptId: '0xR',
      inPtbNonceMatch: true,
    });
    const input = createGasBoundBuildInput({ sponsorSlot: slot, nonce });
    expect(input.reservationHandles.nonce).toBe(nonce);
  });

  test('builder rejects a released sponsorSlot — fails closed before any build work', () => {
    const slot = reconstructReservationHandles.sponsorSlot({
      sponsorAddress: '0xSPONSOR',
      receiptId: '0xR',
    });
    slot.release();
    expect(() => createGasBoundBuildInput({ sponsorSlot: slot })).toThrow(
      ReservationHandleClosedError,
    );
  });

  test('builder rejects when a supplied nonce is released (generic safety)', () => {
    const slot = reconstructReservationHandles.sponsorSlot({
      sponsorAddress: '0xSPONSOR',
      receiptId: '0xR',
    });
    const nonce = reconstructReservationHandles.nonce({
      nonce: 1n,
      senderAddress: '0xS',
      receiptId: '0xR',
      inPtbNonceMatch: true,
    });
    nonce.release();
    expect(() => createGasBoundBuildInput({ sponsorSlot: slot, nonce })).toThrow(
      ReservationHandleClosedError,
    );
  });
});

// ─────────────────────────────────────────────
// Section 6 — sponsor-phase reconstruction parity
// ─────────────────────────────────────────────

describe('SponsoredExecution — sponsor-phase reconstruction', () => {
  test('reconstructReservationHandles.sponsorSlot lifts consumed lease identity into a live token', () => {
    const ev = reconstructReservationHandles.sponsorSlot({
      sponsorAddress: '0xSPONSOR',
      receiptId: '0xRECEIPT',
    });
    expect(ev.reservationKind).toBe('SponsorSlot');
    expect(ev.isLive()).toBe(true);
    expect(ev.sponsorAddress).toBe('0xSPONSOR');
  });

  test('reconstructReservationHandles.nonce produces a live token whose payload mirrors the durable inputs', () => {
    const ev = reconstructReservationHandles.nonce({
      nonce: 7n,
      senderAddress: '0xS',
      receiptId: '0xR',
      inPtbNonceMatch: true,
    });
    expect(ev.reservationKind).toBe('Nonce');
    expect(ev.nonce).toBe(7n);
  });

  test('reconstructReservationHandles.ledgerReservation mirrors the prepared-entry copy', () => {
    const ev = reconstructReservationHandles.ledgerReservation({
      receiptId: '0xR',
      promotionId: 'promo-1',
      userId: 'user-1',
      reservedGasMist: 1_400_000n,
      ledgerLookupVerified: true,
    });
    expect(ev.reservedGasMist).toBe(1_400_000n);
    expect(ev.userId).toBe('user-1');
  });

  test('reconstructed reservation handle is independent of any prior instance — release of one does not affect the other', () => {
    const original = reconstructReservationHandles.sponsorSlot({
      sponsorAddress: '0xSPONSOR',
      receiptId: '0xR',
    });
    const reconstructed = reconstructReservationHandles.sponsorSlot({
      sponsorAddress: '0xSPONSOR',
      receiptId: '0xR',
    });
    original.release();
    expect(original.isLive()).toBe(false);
    expect(reconstructed.isLive()).toBe(true);
    expect(reconstructed.sponsorAddress).toBe('0xSPONSOR');
  });
});

// ─────────────────────────────────────────────
// Section 7 — SponsoredExecutionPolicy registry exact-key enforcement (F3 lock)
// ─────────────────────────────────────────────

describe('SponsoredExecution — SponsoredExecutionPolicy registry', () => {
  function makeNoopHooks<D extends PolicyDiscriminator>(
    chainSnapshot: PolicyHooks<D>['ChainSnapshot'],
  ): PolicyHooks<D> {
    const noop = (): void => {};
    const sharedPostconsumeChecks: PolicyHooks<D>['SharedPostconsumeChecks'] = () => ({});
    const policyPostconsumeChecks: PolicyHooks<D>['PolicyPostconsumeChecks'] = () => ({});
    const gasBoundBuild: PolicyHooks<D>['GasBoundBuild'] = () => ({
      txBytes: new Uint8Array(),
      txBytesHash: '',
      measuredGasMist: 0n,
    });
    return {
      Intent: noop,
      RequestValidation: noop,
      InflightAdmission: noop,
      ChainSnapshot: chainSnapshot,
      ExecutionPolicySelected: noop,
      SlotFreePlan: noop,
      ReceiptIdGenerated: noop,
      SponsorSlotReservationAcquired: noop,
      GasBoundBuild: gasBoundBuild,
      SelfCheck: noop,
      SponsorLeaseCommitted: noop,
      PrepareStored: noop,
      AwaitUserSignature: noop,
      DecodeSponsorSubmission: noop,
      UserSignatureValidation: noop,
      Consume: noop,
      SharedPostconsumeChecks: sharedPostconsumeChecks,
      PolicyPostconsumeChecks: policyPostconsumeChecks,
      Preflight: noop,
      PolicyApproval: noop,
      SponsorSign: noop,
      Submit: noop,
      ClassifySponsorResult: noop,
      Release: noop,
    };
  }

  function makeNoopPolicy(d: 'generic'): SponsoredExecutionPolicy<'generic'>;
  function makeNoopPolicy(d: 'promotion'): SponsoredExecutionPolicy<'promotion'>;
  function makeNoopPolicy(d: PolicyDiscriminator): SponsoredExecutionPolicy {
    if (d === 'generic') {
      return {
        discriminator: 'generic',
        handleRequirements: {
          gasBoundBuild: { sponsorSlot: true, nonce: true },
          preparedCommit: { sponsorSlot: true, nonce: true },
          sponsorResult: { sponsorSlot: true },
        },
        hooks: makeNoopHooks<'generic'>(() => ({
          nonceAcquire: { onchainLastNonce: 0n },
        })),
      };
    }
    return {
      discriminator: 'promotion',
      handleRequirements: {
        gasBoundBuild: { sponsorSlot: true },
        preparedCommit: { sponsorSlot: true },
        sponsorResult: { sponsorSlot: true },
      },
      hooks: makeNoopHooks<'promotion'>(() => ({})),
    };
  }

  test('createSponsoredExecutionPolicyRegistry accepts a complete map and returns it shape-preserved', () => {
    const generic = makeNoopPolicy('generic');
    const promotion = makeNoopPolicy('promotion');
    const reg: SponsoredExecutionPolicyRegistry = createSponsoredExecutionPolicyRegistry({
      generic,
      promotion,
    });
    expect(reg.generic).toBe(generic);
    expect(reg.promotion).toBe(promotion);
  });

  test('createSponsoredExecutionPolicyRegistry rejects extra keys at runtime even when a cast bypasses the type gate', () => {
    const generic = makeNoopPolicy('generic');
    const promotion = makeNoopPolicy('promotion');
    const extra = makeNoopPolicy('generic');
    const tampered = {
      generic,
      promotion,
      extra,
    } as unknown as Parameters<typeof createSponsoredExecutionPolicyRegistry>[0];
    let caught: unknown;
    try {
      createSponsoredExecutionPolicyRegistry(tampered);
      expect.fail('expected throw on extra key');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SponsoredExecutionPolicyRegistryError);
    expect((caught as SponsoredExecutionPolicyRegistryError).reason).toBe('unknown_key');
  });

  test('createSponsoredExecutionPolicyRegistry returned object exposes ONLY the documented discriminator keys', () => {
    const generic = makeNoopPolicy('generic');
    const promotion = makeNoopPolicy('promotion');
    const reg = createSponsoredExecutionPolicyRegistry({ generic, promotion });
    expect(Object.keys(reg).sort()).toEqual(['generic', 'promotion']);
  });

  test('createSponsoredExecutionPolicyRegistry rejects a policy whose discriminator does not match its registry key', () => {
    const generic = makeNoopPolicy('generic');
    const tamperedPromotion: SponsoredExecutionPolicy = {
      ...makeNoopPolicy('promotion'),
      discriminator: 'generic',
    };
    let caught: unknown;
    try {
      createSponsoredExecutionPolicyRegistry({
        generic,
        promotion: tamperedPromotion,
      });
      expect.fail('expected throw on discriminator mismatch');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SponsoredExecutionPolicyRegistryError);
    expect((caught as SponsoredExecutionPolicyRegistryError).reason).toBe('discriminator_mismatch');
  });

  test('SponsoredExecutionPolicy hook shape compiles with a route-specific RouteReservation hook', () => {
    const generic = makeNoopPolicy('generic');
    const withReservation: SponsoredExecutionPolicy = {
      ...generic,
      hooks: {
        ...generic.hooks,
        RouteReservationBeforeBuild: () => undefined,
      },
    };
    expect(withReservation.hooks.RouteReservationBeforeBuild).toBeDefined();
  });

  test('handleRequirements is per-stage with sponsorSlot=true mandatory at each stage', () => {
    const reqs: SponsoredExecutionPolicy['handleRequirements'] = {
      gasBoundBuild: { sponsorSlot: true },
      preparedCommit: { sponsorSlot: true },
      sponsorResult: { sponsorSlot: true },
    };
    expect(reqs.gasBoundBuild.sponsorSlot).toBe(true);
    expect(reqs.preparedCommit.sponsorSlot).toBe(true);
    expect(reqs.sponsorResult.sponsorSlot).toBe(true);
    // Type-level: gasBoundBuild has NO `ledgerReservation` field. Attempting
    // to add it would compile-error. Surrounding `tsc --noEmit` enforces this.
    expect((reqs.gasBoundBuild as Record<string, unknown>).ledgerReservation).toBeUndefined();
  });
});

// ─────────────────────────────────────────────
// Section 8 — ReservationBase.release() never-throwing contract (F4 lock)
// ─────────────────────────────────────────────

describe('SponsoredExecution — ReservationBase release() contract', () => {
  test('release() swallows releaseImpl() exceptions and routes them to onReleaseError', async () => {
    const { InflightReservation } =
      await import('../src/session/sponsoredExecution/reservations.js');
    const errors: unknown[] = [];

    class FailingTestReservation extends InflightReservation {
      acquire(): Promise<void> {
        // Skip the real route check — drive the state machine manually.
        (this as unknown as { _state: 'acquired' })._state = 'acquired';
        return Promise.resolve();
      }
      protected async releaseImpl(): Promise<void> {
        throw new Error('infra release failure');
      }
      protected override onReleaseError(err: unknown): void {
        errors.push(err);
      }
    }

    const r = new FailingTestReservation();
    await r.acquire();
    expect(r.isAcquired()).toBe(true);
    // Must NOT throw — the contract is non-throwing.
    await expect(r.release()).resolves.toBeUndefined();
    expect(r.isAcquired()).toBe(false);
    // The error must have been routed exactly once.
    expect(errors.length).toBe(1);
    expect((errors[0] as Error).message).toBe('infra release failure');
  });

  test('release() is idempotent: a second call is a no-op', async () => {
    const { InflightReservation } =
      await import('../src/session/sponsoredExecution/reservations.js');
    let releaseCount = 0;

    class CountingReservation extends InflightReservation {
      acquire(): Promise<void> {
        (this as unknown as { _state: 'acquired' })._state = 'acquired';
        return Promise.resolve();
      }
      protected async releaseImpl(): Promise<void> {
        releaseCount += 1;
      }
    }

    const r = new CountingReservation();
    await r.acquire();
    await r.release();
    await r.release();
    await r.release();
    expect(releaseCount).toBe(1);
  });

  test('release() after transferOwnership() is a no-op for transferable reservations (ownership already passed to durable store)', async () => {
    // Sponsor slot is the canonical transferable reservation: ownership
    // moves to the prepared-store entry on `PrepareStored` success and
    // the sponsor lifecycle owns subsequent checkin. Inflight is
    // intentionally NOT transferable; this test uses
    // `SponsorSlotReservation` to drive the contract.
    const { SponsorSlotReservation } =
      await import('../src/session/sponsoredExecution/reservations.js');
    let releaseCount = 0;

    class TransferThenReleaseReservation extends SponsorSlotReservation {
      acquire(_receiptId: string): Promise<SponsorSlotReservationHandle | null> {
        (this as unknown as { _state: 'acquired' })._state = 'acquired';
        return Promise.resolve(null);
      }
      async commitToTxBytesHash(_hash: string): Promise<void> {}
      protected async releaseImpl(): Promise<void> {
        releaseCount += 1;
      }
    }

    const r = new TransferThenReleaseReservation();
    await r.acquire('0xR');
    r.transferOwnership();
    await r.release();
    expect(releaseCount).toBe(0);
  });

  test('a misbehaving onReleaseError that itself throws is still swallowed by release()', async () => {
    const { InflightReservation } =
      await import('../src/session/sponsoredExecution/reservations.js');

    class DoubleFailReservation extends InflightReservation {
      acquire(): Promise<void> {
        (this as unknown as { _state: 'acquired' })._state = 'acquired';
        return Promise.resolve();
      }
      protected async releaseImpl(): Promise<void> {
        throw new Error('release impl error');
      }
      protected override onReleaseError(_err: unknown): void {
        throw new Error('reporter itself threw');
      }
    }

    const r = new DoubleFailReservation();
    await r.acquire();
    await expect(r.release()).resolves.toBeUndefined();
    expect(r.isAcquired()).toBe(false);
  });
});

// ─────────────────────────────────────────────
// Type-level locks (no runtime; produce a compile error if drift lands)
// ─────────────────────────────────────────────

const _slotBrand: SponsorSlotReservationHandle['reservationKind'] = 'SponsorSlot';
const _nonceBrand: NonceReservationHandle['reservationKind'] = 'Nonce';
const _ledgerBrand: LedgerReservationHandle['reservationKind'] = 'LedgerReservation';
void _slotBrand;
void _nonceBrand;
void _ledgerBrand;
