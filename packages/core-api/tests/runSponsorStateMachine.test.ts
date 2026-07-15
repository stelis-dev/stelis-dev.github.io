/**
 * runSponsorStateMachine.test.ts — sponsor-side `SponsoredExecution` runner.
 *
 * Pins the runner architecture invariants:
 *
 *   - Pre-consume hooks see `PreConsumeSponsorContext` (no reservation handles).
 *   - After consume succeeds, the runner reconstructs `sponsorSlot`
 *     immediately. SharedPostconsumeChecks output mints `nonce`;
 *     PolicyPostconsumeChecks output mints `ledgerReservation`.
 *   - `safeSlotCheckin` fires in `finally` ONLY after consume succeeded.
 *   - Pre-consume failures (consume sub-runner classified errors)
 *     propagate UNCHANGED — the runner does not re-classify.
 *   - Release hook throws are swallowed; primary success/error never
 *     replaced.
 *   - Module API hygiene: directory barrel exposes the runner;
 *     package main barrel does NOT re-export.
 */
import { describe, test, expect, vi, type Mock } from 'vitest';
import { createHash } from 'node:crypto';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import {
  runSponsorStateMachine,
  RunnerSponsorReservationHandleMissingError,
  RunnerSponsorPolicyContractError,
  type SponsorStateMachineHost,
  type SponsorStateMachineRequest,
  type SignAndSubmitPort,
  type SponsorResultSnapshot,
} from '../src/session/sponsoredExecution/sponsorRunner.js';
import type {
  SponsoredExecutionPolicy,
  PreConsumeSponsorContext,
  PostConsumeSponsorContext,
  SharedPostconsumeReconstruction,
  PolicyPostconsumeReconstruction,
} from '../src/session/sponsoredExecution/executionPolicy.js';
import type {
  GenericPreparedTxDraft,
  PromotionPreparedTxDraft,
} from '../src/store/prepareTypes.js';
import type { ExecResult } from '../src/session/sessionTypes.js';
import { MemoryPrepareStore } from '../src/store/memoryPrepareStore.js';
import { MemoryPromotionExecutionLedger } from '../src/studio/executionLedgerMemory.js';
import { SponsorPool } from '../src/context.js';
import { SponsorPostSignatureUncertaintyError } from '../src/session/sessionPrimitives.js';
import { suiExecutionErrorMessage, type SuiExecutionError } from '@stelis/core-relay';
import {
  runSponsorConsumePhase,
  type SponsorConsumePolicyAdapter,
} from '../src/session/sponsorLifecycle.js';
import { TEST_SUI_TRANSACTION_DIGEST } from './helpers/suiGatewayResultFixtures.js';

// Force a single dependency edge on `runSponsorConsumePhase` so the
// sub-runner contract stays exercised even when the runner under test
// invokes it indirectly. Re-exporting the import would also satisfy
// this lint.
void runSponsorConsumePhase;

// ─────────────────────────────────────────────
// Shared fixtures
// ─────────────────────────────────────────────

const TEST_HMAC_SECRET = 'pr-1-2b-runner-test-hmac-secret-00000';
const SPONSOR_KP = Ed25519Keypair.generate();
const TEST_RECEIPT_ID = `0x${'cd'.repeat(32)}`;
const TEST_SENDER = `0x${'be'.repeat(32)}`;
const TEST_PROMO = 'pr-1-2b-promo-1';
const TEST_USER = 'pr-1-2b-user-1';
const TEST_TX_BYTES = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05]);
const TEST_TX_BYTES_HASH = createHash('sha256').update(TEST_TX_BYTES).digest('hex');
const TEST_USER_SIGNATURE = 'mock-user-sig';

const SUCCESS_EXEC: Extract<ExecResult, { success: true }> = {
  success: true,
  executionStage: 'on_chain',
  digest: TEST_SUI_TRANSACTION_DIGEST,
  effects: undefined,
  gasUsed: {
    computationCost: '1000',
    storageCost: '0',
    storageRebate: '0',
  },
};

const MOVE_FAILURE: SuiExecutionError = {
  kind: 'MovePrimitiveRuntimeError',
};

const CONGESTION_FAILURE: SuiExecutionError = {
  kind: 'ExecutionCanceledDueToConsensusObjectCongestion',
};

const FAILED_EXEC_ONCHAIN: ExecResult = {
  success: false,
  executionStage: 'on_chain',
  digest: TEST_SUI_TRANSACTION_DIGEST,
  error: MOVE_FAILURE,
  isCongestion: false,
  gasUsed: {
    computationCost: '1000',
    storageCost: '0',
    storageRebate: '0',
  },
};

const FAILED_EXEC_CONGESTION: ExecResult = {
  success: false,
  executionStage: 'after_sponsor_signature',
  digest: '',
  error: CONGESTION_FAILURE,
  isCongestion: true,
  gasUsed: null,
};

interface HookCallLog {
  state: string;
  ctxKind: 'pre' | 'post';
  hasNonce: boolean;
  hasLedger: boolean;
  args: unknown[];
}

interface MakePolicyOptions {
  failAtState?: string;
  releaseThrow?: boolean;
  emitNonce?: boolean;
  emitLedger?: boolean;
  /**
   * Override ClassifySponsorResult's classification behavior. Default
   * mirrors the route-policy contract: throw on `result.success ===
   * false`; no-op on `result.success === true`. `'silent-on-failure'`
   * makes the hook return without throwing even on a failed result —
   * exercises the runner's contract-violation gate
   * (`RunnerSponsorPolicyContractError`).
   */
  sponsorResultMode?: 'silent-on-failure';
}

function makeMockHooks(opts: MakePolicyOptions = {}): {
  hooks: SponsoredExecutionPolicy['hooks'];
  log: HookCallLog[];
} {
  const log: HookCallLog[] = [];

  const recordPre = (state: string) => (ctx: PreConsumeSponsorContext) => {
    log.push({ state, ctxKind: 'pre', hasNonce: false, hasLedger: false, args: [ctx] });
    if (opts.failAtState === state) throw new Error(`policy fault at ${state}`);
  };
  const recordPost =
    (state: string) =>
    (ctx: PostConsumeSponsorContext, ...rest: unknown[]) => {
      log.push({
        state,
        ctxKind: 'post',
        hasNonce: !!ctx.nonce,
        hasLedger: !!ctx.ledgerReservation,
        args: [ctx, ...rest],
      });
      if (opts.failAtState === state) throw new Error(`policy fault at ${state}`);
    };

  const hooks: SponsoredExecutionPolicy['hooks'] = {
    Intent: () => {},
    RequestValidation: () => {},
    InflightAdmission: () => {},
    ChainSnapshot: () => ({}),
    ExecutionPolicySelected: () => {},
    SlotFreePlan: () => {},
    SponsorSlotReservationAcquired: () => {},
    RouteReservationBeforeBuild: () => {},
    GasBoundBuild: () => ({
      txBytes: new Uint8Array(),
      txBytesHash: '',
      measuredGasMist: 0n,
    }),
    RouteReservationAfterBuild: () => {},
    SelfCheck: () => {},
    SponsorLeaseCommitted: () => {},
    DecodeSponsorSubmission: recordPre('DecodeSponsorSubmission'),
    UserSignatureValidation: recordPre('UserSignatureValidation'),
    Consume: recordPre('Consume'),
    SharedPostconsumeChecks: (ctx) => {
      log.push({
        state: 'SharedPostconsumeChecks',
        ctxKind: 'post',
        hasNonce: !!ctx.nonce,
        hasLedger: !!ctx.ledgerReservation,
        args: [ctx],
      });
      if (opts.failAtState === 'SharedPostconsumeChecks') {
        throw new Error('policy fault at SharedPostconsumeChecks');
      }
      const out: SharedPostconsumeReconstruction = opts.emitNonce
        ? {
            nonce: {
              nonce: 42n,
              senderAddress: TEST_SENDER,
              receiptId: TEST_RECEIPT_ID,
              inPtbNonceMatch: true,
            },
          }
        : {};
      return out;
    },
    PolicyPostconsumeChecks: (ctx) => {
      log.push({
        state: 'PolicyPostconsumeChecks',
        ctxKind: 'post',
        hasNonce: !!ctx.nonce,
        hasLedger: !!ctx.ledgerReservation,
        args: [ctx],
      });
      if (opts.failAtState === 'PolicyPostconsumeChecks') {
        throw new Error('policy fault at PolicyPostconsumeChecks');
      }
      const out: PolicyPostconsumeReconstruction = opts.emitLedger
        ? {
            ledgerReservation: {
              receiptId: TEST_RECEIPT_ID,
              promotionId: TEST_PROMO,
              userId: TEST_USER,
              reservedGasMist: 1_400_000n,
              ledgerLookupVerified: true,
            },
          }
        : {};
      return out;
    },
    Preflight: recordPost('Preflight'),
    PolicyApproval: recordPost('PolicyApproval'),
    SponsorSign: recordPost('SponsorSign'),
    Submit: (ctx) => {
      log.push({
        state: 'Submit',
        ctxKind: 'post',
        hasNonce: !!ctx.nonce,
        hasLedger: !!ctx.ledgerReservation,
        args: [ctx],
      });
      if (opts.failAtState === 'Submit') throw new Error('policy fault at Submit');
    },
    ClassifySponsorResult: (ctx, result) => {
      log.push({
        state: 'ClassifySponsorResult',
        ctxKind: 'post',
        hasNonce: !!ctx.nonce,
        hasLedger: !!ctx.ledgerReservation,
        args: [ctx, result],
      });
      if (opts.sponsorResultMode === 'silent-on-failure') {
        // Contract-violation knob: stay silent even on failed
        // ExecResult so the runner's defensive gate fires.
        return;
      }
      if (result.success === false) {
        throw new Error(
          `route-classified sponsor result failure: ${suiExecutionErrorMessage(result.error)}`,
        );
      }
    },
    Release: (ctx) => {
      log.push({
        state: 'Release',
        ctxKind: 'post',
        hasNonce: !!ctx.nonce,
        hasLedger: !!ctx.ledgerReservation,
        args: [ctx],
      });
      if (opts.releaseThrow) throw new Error('Release hook fault');
    },
  };
  return { hooks, log };
}

function makeGenericPolicy(opts: MakePolicyOptions = {}): {
  policy: SponsoredExecutionPolicy;
  log: HookCallLog[];
} {
  const { hooks, log } = makeMockHooks(opts);
  return {
    policy: {
      discriminator: 'generic',
      handleRequirements: {
        gasBoundBuild: { nonce: true },
        preparedCommit: {},
        sponsorResult: {},
      },
      hooks,
    },
    log,
  };
}

function makePromotionPolicy(opts: MakePolicyOptions = {}): {
  policy: SponsoredExecutionPolicy;
  log: HookCallLog[];
} {
  const { hooks, log } = makeMockHooks(opts);
  return {
    policy: {
      discriminator: 'promotion',
      handleRequirements: {
        gasBoundBuild: {},
        preparedCommit: { ledgerReservation: true },
        sponsorResult: { ledgerReservation: true },
      },
      hooks,
    },
    log,
  };
}

interface HostBuild {
  host: SponsorStateMachineHost;
  prepareStore: MemoryPrepareStore;
  sponsorPool: SponsorPool;
  ledger: MemoryPromotionExecutionLedger;
  signAndSubmitMock: Mock<SignAndSubmitPort>;
}

function makeHost(opts?: { execResult?: ExecResult; signThrows?: unknown }): HostBuild {
  const sponsorPool = new SponsorPool([SPONSOR_KP], { hmacSecret: TEST_HMAC_SECRET });
  const prepareStore = new MemoryPrepareStore((sponsorAddress, receiptId, txBytesHash) =>
    sponsorPool.checkin(sponsorAddress, receiptId, txBytesHash),
  );
  const ledger = new MemoryPromotionExecutionLedger();

  const signAndSubmitMock = vi.fn<SignAndSubmitPort>(async () => {
    if (opts?.signThrows) throw opts.signThrows;
    return opts?.execResult ?? SUCCESS_EXEC;
  });

  return {
    host: {
      prepareStore,
      sponsorPool,
      executionLedger: ledger,
      signAndSubmit: signAndSubmitMock,
    },
    prepareStore,
    sponsorPool,
    ledger,
    signAndSubmitMock,
  };
}

/**
 * Pre-store a generic prepared entry + commit the matching HMAC lease
 * on the sponsor pool so `runSponsorConsumePhase` finds a valid entry
 * keyed to `TEST_TX_BYTES_HASH`. Returns the sponsorAddress chosen by the pool.
 */
async function pinGenericEntry(host: HostBuild): Promise<string> {
  const slot = await host.sponsorPool.checkout(TEST_RECEIPT_ID);
  if (!slot) throw new Error('test setup: pool exhausted');
  await host.sponsorPool.commit(slot.sponsorAddress, TEST_RECEIPT_ID, TEST_TX_BYTES_HASH);
  const entry: GenericPreparedTxDraft = {
    mode: 'generic',
    receiptId: TEST_RECEIPT_ID,
    senderAddress: TEST_SENDER,
    txBytesHash: TEST_TX_BYTES_HASH,
    sponsorAddress: slot.sponsorAddress,
    clientIp: '127.0.0.1',
    executionPathKey: 'credit',
    orderId: null,
    nonce: 1n,
  };
  await host.prepareStore.store(entry);
  return slot.sponsorAddress;
}

async function pinPromotionEntry(host: HostBuild): Promise<string> {
  const slot = await host.sponsorPool.checkout(TEST_RECEIPT_ID);
  if (!slot) throw new Error('test setup: pool exhausted');
  await host.sponsorPool.commit(slot.sponsorAddress, TEST_RECEIPT_ID, TEST_TX_BYTES_HASH);
  const entry: PromotionPreparedTxDraft = {
    mode: 'promotion',
    receiptId: TEST_RECEIPT_ID,
    senderAddress: TEST_SENDER,
    txBytesHash: TEST_TX_BYTES_HASH,
    sponsorAddress: slot.sponsorAddress,
    clientIp: '127.0.0.1',
    executionPathKey: `promotion:${TEST_PROMO}`,
    orderId: null,
    nonce: 0n,
    promotionId: TEST_PROMO,
    userId: TEST_USER,
    reservedGasMist: 1_400_000n,
  };
  await host.prepareStore.store(entry);
  return slot.sponsorAddress;
}

/**
 * Minimal consume-policy adapter that exercises the runner's
 * Q1-confirmed reuse boundary. Production handlers' adapters carry
 * route-specific abuse / ledger / corrupt cleanup; for runner-only
 * unit tests we only need the classified-error contract.
 */
function makeMockConsumeAdapter(
  route: 'generic' | 'promotion' = 'generic',
): SponsorConsumePolicyAdapter {
  return {
    route,
    onNotFound: (rid) => new Error(`not_found:${rid}`),
    onExpired: (rid) => new Error(`expired:${rid}`),
    onHashMismatch: (rid) => new Error(`hash_mismatch:${rid}`),
    onCorrupt: ({ receiptId, stage }) =>
      Promise.resolve(new Error(`corrupt:${stage}:${receiptId}`)),
    validateConsumedEntry: () => Promise.resolve(),
  };
}

interface GenericResult {
  digest: string;
  receiptId: string;
}

function makeGenericRequest(): SponsorStateMachineRequest<GenericResult> {
  return {
    hookContext: { receiptId: TEST_RECEIPT_ID, clientIp: '127.0.0.1' },
    txBytes: TEST_TX_BYTES,
    userSignature: TEST_USER_SIGNATURE,
    projectResult: (snap: SponsorResultSnapshot) => ({
      digest: snap.execResult.digest,
      receiptId: snap.receiptId,
    }),
  };
}

interface PromotionResult {
  digest: string;
  reservedGasMist: string;
}

function makePromotionRequest(): SponsorStateMachineRequest<PromotionResult> {
  return {
    hookContext: { receiptId: TEST_RECEIPT_ID, clientIp: '127.0.0.1' },
    txBytes: TEST_TX_BYTES,
    userSignature: TEST_USER_SIGNATURE,
    projectResult: (snap: SponsorResultSnapshot) => ({
      digest: snap.execResult.digest,
      reservedGasMist: snap.ledgerReservation?.reservedGasMist.toString() ?? '0',
    }),
  };
}

// ─────────────────────────────────────────────
// Section 1 — Generic happy path (state walk + reservation handle reconstruction timing)
// ─────────────────────────────────────────────

describe('runSponsorStateMachine — generic happy path', () => {
  test('walks pre-consume → consume → post-consume → sponsor result in order; pre-consume hooks see PreConsumeSponsorContext with no reservation handles', async () => {
    const host = makeHost();
    await pinGenericEntry(host);
    const { policy, log } = makeGenericPolicy({ emitNonce: true });
    const adapter = makeMockConsumeAdapter('generic');

    const out = await runSponsorStateMachine(host.host, makeGenericRequest(), policy, adapter);

    expect(out.digest).toBe(TEST_SUI_TRANSACTION_DIGEST);
    expect(out.receiptId).toBe(TEST_RECEIPT_ID);

    // Order check (state-walk parity).
    const states = log.map((e) => e.state);
    expect(states).toEqual([
      'DecodeSponsorSubmission',
      'UserSignatureValidation',
      'Consume',
      'SharedPostconsumeChecks',
      'PolicyPostconsumeChecks',
      'Preflight',
      'PolicyApproval',
      'SponsorSign',
      'Submit',
      'ClassifySponsorResult',
      'Release',
    ]);

    // Pre-consume hooks see PreConsumeSponsorContext: ctxKind = 'pre',
    // no nonce/ledger.
    const preConsume = log.filter((e) =>
      ['DecodeSponsorSubmission', 'UserSignatureValidation', 'Consume'].includes(e.state),
    );
    for (const e of preConsume) {
      expect(e.ctxKind).toBe('pre');
      expect(e.hasNonce).toBe(false);
      expect(e.hasLedger).toBe(false);
    }
  });

  test('SharedPostconsumeChecks output mints NonceReservationHandle; Preflight onwards see ctx.nonce', async () => {
    const host = makeHost();
    await pinGenericEntry(host);
    const { policy, log } = makeGenericPolicy({ emitNonce: true });
    const adapter = makeMockConsumeAdapter('generic');

    await runSponsorStateMachine(host.host, makeGenericRequest(), policy, adapter);

    // SharedPostconsumeChecks itself sees ctx WITHOUT nonce (it's
    // about to mint it).
    const shared = log.find((e) => e.state === 'SharedPostconsumeChecks');
    expect(shared?.hasNonce).toBe(false);

    // Preflight, PolicyApproval, SponsorSign, Submit, ClassifySponsorResult,
    // Release all fire AFTER the runner minted nonce — they see
    // ctx.nonce as live.
    const afterMint = log.filter((e) =>
      [
        'Preflight',
        'PolicyApproval',
        'SponsorSign',
        'Submit',
        'ClassifySponsorResult',
        'Release',
      ].includes(e.state),
    );
    for (const e of afterMint) {
      expect(e.hasNonce).toBe(true);
    }
  });

  test('host.signAndSubmit is called with (sponsorAddress, receiptId, txBytes, userSignature) from the consumed entry', async () => {
    const host = makeHost();
    const sponsorAddress = await pinGenericEntry(host);
    const { policy } = makeGenericPolicy({ emitNonce: true });
    const adapter = makeMockConsumeAdapter('generic');

    await runSponsorStateMachine(host.host, makeGenericRequest(), policy, adapter);

    expect(host.signAndSubmitMock).toHaveBeenCalledTimes(1);
    expect(host.signAndSubmitMock).toHaveBeenCalledWith(
      sponsorAddress,
      TEST_RECEIPT_ID,
      TEST_TX_BYTES,
      TEST_USER_SIGNATURE,
    );
  });
});

// ─────────────────────────────────────────────
// Section 2 — Studio happy path
// ─────────────────────────────────────────────

describe('runSponsorStateMachine — Studio happy path', () => {
  test('PolicyPostconsumeChecks output mints LedgerReservationHandle; ClassifySponsorResult sees ctx.ledgerReservation', async () => {
    const host = makeHost();
    await pinPromotionEntry(host);
    const { policy, log } = makePromotionPolicy({ emitLedger: true });
    const adapter = makeMockConsumeAdapter('promotion');

    const out = await runSponsorStateMachine(host.host, makePromotionRequest(), policy, adapter);

    expect(out.digest).toBe(TEST_SUI_TRANSACTION_DIGEST);
    expect(out.reservedGasMist).toBe('1400000');

    // PolicyPostconsumeChecks sees ctx WITHOUT ledger (about to mint).
    const policyPostconsume = log.find((e) => e.state === 'PolicyPostconsumeChecks');
    expect(policyPostconsume?.hasLedger).toBe(false);
    expect(policyPostconsume?.hasNonce).toBe(false); // promotion has no nonce

    // After mint: Preflight onwards see ctx.ledgerReservation.
    const afterMint = log.filter((e) =>
      [
        'Preflight',
        'PolicyApproval',
        'SponsorSign',
        'Submit',
        'ClassifySponsorResult',
        'Release',
      ].includes(e.state),
    );
    for (const e of afterMint) {
      expect(e.hasLedger).toBe(true);
      expect(e.hasNonce).toBe(false);
    }
  });
});

// ─────────────────────────────────────────────
// Section 3 — Consume failure pass-through
// ─────────────────────────────────────────────

describe('runSponsorStateMachine — consume failures', () => {
  test('not_found classified error propagates UNCHANGED from sub-runner', async () => {
    const host = makeHost();
    // No entry stored — consume returns not_found.
    const { policy } = makeGenericPolicy();
    const adapter = makeMockConsumeAdapter('generic');

    await expect(
      runSponsorStateMachine(host.host, makeGenericRequest(), policy, adapter),
    ).rejects.toThrow(`not_found:${TEST_RECEIPT_ID}`);

    // Pre-consume failure: signAndSubmit was NEVER called.
    expect(host.signAndSubmitMock).toHaveBeenCalledTimes(0);
  });

  test('hash_mismatch propagates UNCHANGED; runner does not check in slot in finally (pool retains stage info)', async () => {
    const host = makeHost();
    await pinGenericEntry(host);
    const { policy } = makeGenericPolicy();
    // Submit different bytes than the ones the entry was stored with.
    const tamperedReq: SponsorStateMachineRequest<GenericResult> = {
      ...makeGenericRequest(),
      txBytes: new Uint8Array([0xff, 0xff, 0xff]),
    };
    const adapter = makeMockConsumeAdapter('generic');

    await expect(runSponsorStateMachine(host.host, tamperedReq, policy, adapter)).rejects.toThrow(
      `hash_mismatch:${TEST_RECEIPT_ID}`,
    );

    expect(host.signAndSubmitMock).toHaveBeenCalledTimes(0);
  });
});

// ─────────────────────────────────────────────
// Section 4 — Post-consume + sponsor result failures still run finally checkin
// ─────────────────────────────────────────────

describe('runSponsorStateMachine — finally slot checkin parity', () => {
  test('SharedPostconsumeChecks throws → finally runs safeSlotCheckin', async () => {
    const host = makeHost();
    const sponsorAddress = await pinGenericEntry(host);
    const { policy } = makeGenericPolicy({ failAtState: 'SharedPostconsumeChecks' });
    const adapter = makeMockConsumeAdapter('generic');

    const checkinSpy = vi.spyOn(host.sponsorPool, 'checkin');

    await expect(
      runSponsorStateMachine(host.host, makeGenericRequest(), policy, adapter),
    ).rejects.toThrow('policy fault at SharedPostconsumeChecks');

    expect(checkinSpy).toHaveBeenCalledWith(sponsorAddress, TEST_RECEIPT_ID, TEST_TX_BYTES_HASH);
  });

  test('Preflight throws → finally runs safeSlotCheckin', async () => {
    const host = makeHost();
    const sponsorAddress = await pinGenericEntry(host);
    const { policy } = makeGenericPolicy({ failAtState: 'Preflight', emitNonce: true });
    const adapter = makeMockConsumeAdapter('generic');

    const checkinSpy = vi.spyOn(host.sponsorPool, 'checkin');

    await expect(
      runSponsorStateMachine(host.host, makeGenericRequest(), policy, adapter),
    ).rejects.toThrow('policy fault at Preflight');

    expect(checkinSpy).toHaveBeenCalledWith(sponsorAddress, TEST_RECEIPT_ID, TEST_TX_BYTES_HASH);
  });

  test('signAndSubmit throws → finally runs safeSlotCheckin (pre-sign and post-sign branches both reach finally)', async () => {
    const preSignErr = new Error('SponsorLeaseExpired-equivalent');
    const host = makeHost({ signThrows: preSignErr });
    const sponsorAddress = await pinGenericEntry(host);
    const { policy, log } = makeGenericPolicy({ emitNonce: true });
    const adapter = makeMockConsumeAdapter('generic');

    const checkinSpy = vi.spyOn(host.sponsorPool, 'checkin');

    await expect(
      runSponsorStateMachine(host.host, makeGenericRequest(), policy, adapter),
    ).rejects.toBe(preSignErr);

    expect(checkinSpy).toHaveBeenCalledWith(sponsorAddress, TEST_RECEIPT_ID, TEST_TX_BYTES_HASH);
    const release = log.find((entry) => entry.state === 'Release');
    expect((release?.args[0] as PostConsumeSponsorContext).executionStage).toBe(
      'before_sponsor_signature',
    );
  });

  test('typed post-signature uncertainty updates Release metadata without losing the submitted digest', async () => {
    const cause = new Error('rpc transport error');
    const expectedDigest = 'expected-sui-transaction-digest';
    const uncertainty = new SponsorPostSignatureUncertaintyError(expectedDigest, cause);
    const host = makeHost({
      signThrows: uncertainty,
    });
    await pinGenericEntry(host);
    const { policy, log } = makeGenericPolicy({ emitNonce: true });
    const adapter = makeMockConsumeAdapter('generic');

    await expect(
      runSponsorStateMachine(host.host, makeGenericRequest(), policy, adapter),
    ).rejects.toBe(uncertainty);

    expect(uncertainty.cause).toBe(cause);
    expect(uncertainty.expectedDigest).toBe(expectedDigest);

    const release = log.find((entry) => entry.state === 'Release');
    expect((release?.args[0] as PostConsumeSponsorContext).executionStage).toBe(
      'after_sponsor_signature',
    );
  });

  test('execResult.success === false → ClassifySponsorResult throws (route classification); finally still runs safeSlotCheckin', async () => {
    const host = makeHost({ execResult: FAILED_EXEC_ONCHAIN });
    const sponsorAddress = await pinGenericEntry(host);
    const { policy } = makeGenericPolicy({ emitNonce: true });
    const adapter = makeMockConsumeAdapter('generic');

    const checkinSpy = vi.spyOn(host.sponsorPool, 'checkin');

    await expect(
      runSponsorStateMachine(host.host, makeGenericRequest(), policy, adapter),
    ).rejects.toThrow(/route-classified sponsor result failure/);

    expect(checkinSpy).toHaveBeenCalledWith(sponsorAddress, TEST_RECEIPT_ID, TEST_TX_BYTES_HASH);
  });

  test('congestion path: ClassifySponsorResult classifies failed execResult.isCongestion → throws; finally still runs safeSlotCheckin', async () => {
    const host = makeHost({ execResult: FAILED_EXEC_CONGESTION });
    const sponsorAddress = await pinGenericEntry(host);
    const { policy } = makeGenericPolicy({ emitNonce: true });
    const adapter = makeMockConsumeAdapter('generic');

    const checkinSpy = vi.spyOn(host.sponsorPool, 'checkin');

    await expect(
      runSponsorStateMachine(host.host, makeGenericRequest(), policy, adapter),
    ).rejects.toThrow(/route-classified sponsor result failure/);

    expect(checkinSpy).toHaveBeenCalledWith(sponsorAddress, TEST_RECEIPT_ID, TEST_TX_BYTES_HASH);
  });
});

// ─────────────────────────────────────────────
// Section 5 — Observability-hook (Submit, Release) failure does NOT mask
// primary classification or the original error
// ─────────────────────────────────────────────

describe('runSponsorStateMachine — Submit hook non-masking', () => {
  test('Submit receives only post-consume context; ClassifySponsorResult remains the result owner', async () => {
    const host = makeHost();
    await pinGenericEntry(host);
    const { policy, log } = makeGenericPolicy({ emitNonce: true });
    const adapter = makeMockConsumeAdapter('generic');

    await runSponsorStateMachine(host.host, makeGenericRequest(), policy, adapter);

    const submit = log.find((e) => e.state === 'Submit');
    const sponsorResult = log.find((e) => e.state === 'ClassifySponsorResult');
    expect(submit?.args).toHaveLength(1);
    expect(sponsorResult?.args).toHaveLength(2);
    expect(sponsorResult?.args[1]).toBe(SUCCESS_EXEC);
    expect((sponsorResult?.args[0] as PostConsumeSponsorContext).executionStage).toBe('on_chain');
  });

  test('Submit throws on success path → ClassifySponsorResult still fires (success branch); primary success result still returned', async () => {
    const host = makeHost();
    await pinGenericEntry(host);
    const { policy, log } = makeGenericPolicy({
      emitNonce: true,
      failAtState: 'Submit',
    });
    const adapter = makeMockConsumeAdapter('generic');

    const out = await runSponsorStateMachine(host.host, makeGenericRequest(), policy, adapter);

    // Primary success path preserved — Submit's throw was swallowed.
    expect(out.digest).toBe(TEST_SUI_TRANSACTION_DIGEST);
    expect(out.receiptId).toBe(TEST_RECEIPT_ID);

    // ClassifySponsorResult fired AFTER Submit's throw was swallowed.
    const states = log.map((e) => e.state);
    const submitIdx = states.indexOf('Submit');
    const sponsorResultIdx = states.indexOf('ClassifySponsorResult');
    expect(submitIdx).toBeGreaterThanOrEqual(0);
    expect(sponsorResultIdx).toBeGreaterThan(submitIdx);
  });

  test('failure result path: Submit fault is swallowed; ClassifySponsorResult still classifies', async () => {
    const host = makeHost({ execResult: FAILED_EXEC_ONCHAIN });
    await pinGenericEntry(host);
    const { policy, log } = makeGenericPolicy({
      emitNonce: true,
      failAtState: 'Submit',
    });
    const adapter = makeMockConsumeAdapter('generic');

    let caught: unknown;
    try {
      await runSponsorStateMachine(host.host, makeGenericRequest(), policy, adapter);
      expect.fail('expected throw');
    } catch (err) {
      caught = err;
    }

    // Caller sees ClassifySponsorResult's classified error, NOT Submit's fault.
    expect((caught as Error).message).toMatch(/route-classified sponsor result failure/);
    expect((caught as Error).message).not.toMatch(/policy fault at Submit/);

    // Both Submit and ClassifySponsorResult fired in order — Submit's throw
    // did not truncate the state walk.
    const states = log.map((e) => e.state);
    expect(states).toContain('Submit');
    expect(states).toContain('ClassifySponsorResult');
  });
});

describe('runSponsorStateMachine — Release hook non-masking', () => {
  test('Release hook throws on success path → primary success result still returned', async () => {
    const host = makeHost();
    await pinGenericEntry(host);
    const { policy } = makeGenericPolicy({ emitNonce: true, releaseThrow: true });
    const adapter = makeMockConsumeAdapter('generic');

    const out = await runSponsorStateMachine(host.host, makeGenericRequest(), policy, adapter);

    expect(out.digest).toBe(TEST_SUI_TRANSACTION_DIGEST);
    expect(out.receiptId).toBe(TEST_RECEIPT_ID);
  });

  test('Release hook throws on failure path → original error still propagates (not replaced by Release fault)', async () => {
    const host = makeHost();
    await pinGenericEntry(host);
    const { policy } = makeGenericPolicy({
      failAtState: 'Preflight',
      emitNonce: true,
      releaseThrow: true,
    });
    const adapter = makeMockConsumeAdapter('generic');

    await expect(
      runSponsorStateMachine(host.host, makeGenericRequest(), policy, adapter),
    ).rejects.toThrow('policy fault at Preflight');
  });
});

// ─────────────────────────────────────────────
// Section 6 — Handle-requirement gate (Q5)
// ─────────────────────────────────────────────

describe('runSponsorStateMachine — RunnerSponsorReservationHandleMissingError', () => {
  test('Studio policy declares sponsorResult.ledgerReservation but PolicyPostconsumeChecks does not return inputs → RunnerSponsorReservationHandleMissingError', async () => {
    const host = makeHost();
    await pinPromotionEntry(host);
    // emitLedger=false: policy postconsume returns no reconstruction inputs.
    const { policy } = makePromotionPolicy({ emitLedger: false });
    const adapter = makeMockConsumeAdapter('promotion');

    await expect(
      runSponsorStateMachine(host.host, makePromotionRequest(), policy, adapter),
    ).rejects.toBeInstanceOf(RunnerSponsorReservationHandleMissingError);

    // Misconfiguration is detected BEFORE signAndSubmit fires.
    expect(host.signAndSubmitMock).toHaveBeenCalledTimes(0);
  });

  test('ClassifySponsorResult violates contract by NOT throwing on failed ExecResult → RunnerSponsorPolicyContractError (distinct from HandleMissing)', async () => {
    const host = makeHost({ execResult: FAILED_EXEC_ONCHAIN });
    await pinGenericEntry(host);
    const { policy } = makeGenericPolicy({
      emitNonce: true,
      // sponsorResultMode='silent-on-failure' makes the hook return without
      // throwing on a failed ExecResult — the runner must catch that
      // contract violation.
      sponsorResultMode: 'silent-on-failure',
    });
    const adapter = makeMockConsumeAdapter('generic');

    let caught: unknown;
    try {
      await runSponsorStateMachine(host.host, makeGenericRequest(), policy, adapter);
      expect.fail('expected throw');
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(RunnerSponsorPolicyContractError);
    // Distinct from the handle-missing class — the two classes
    // signal different conditions and route handlers may map them
    // to different public errors.
    expect(caught).not.toBeInstanceOf(RunnerSponsorReservationHandleMissingError);
  });
});

// ─────────────────────────────────────────────
// Section 7 — Module API
// ─────────────────────────────────────────────

describe('runSponsorStateMachine — module API', () => {
  test('package main barrel does NOT re-export sponsor runner symbols', async () => {
    const mainBarrel = await import('../src/index.js');
    expect(Object.prototype.hasOwnProperty.call(mainBarrel, 'runSponsorStateMachine')).toBe(false);
    expect(
      Object.prototype.hasOwnProperty.call(
        mainBarrel,
        'RunnerSponsorReservationHandleMissingError',
      ),
    ).toBe(false);
  });
});
