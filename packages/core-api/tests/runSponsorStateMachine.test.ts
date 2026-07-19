import { createHash } from 'node:crypto';
import { describe, expect, test, vi } from 'vitest';
import type { SponsorResultMetadata } from '../src/handlers/sponsorResult.js';
import {
  runSponsorStateMachine,
  type SignAndSubmitPort,
  type SponsorReceiptPolicyAdapter,
  type SponsorStateMachineRequest,
} from '../src/session/sponsoredExecution/sponsorRunner.js';
import type { SponsoredExecutionPolicy } from '../src/session/sponsoredExecution/executionPolicy.js';
import { SponsorPostSignatureUncertaintyError } from '../src/session/sessionPrimitives.js';
import type { ExecResult } from '../src/session/sessionTypes.js';
import type {
  GenericPreparedTxEntry,
  PreparedTxEntry,
  PromotionPreparedTxEntry,
} from '../src/store/prepareTypes.js';
import type {
  ExecutingSponsoredExecutionRecord,
  FinalSponsoredExecutionRecord,
  SponsoredExecutionRecoveryContext,
} from '../src/store/sponsoredExecutionRecords.js';
import { storeSponsorResult } from '../src/store/sponsoredExecutionRecords.js';
import type {
  BeginSponsoredExecutionInput,
  BeginSponsoredExecutionResult,
  DiscardPreparedReceiptInput,
  DiscardPreparedReceiptResult,
  FinalizeSponsoredExecutionInput,
  FinalizeSponsoredExecutionResult,
  PromotionReceiptFinalization,
  SponsoredExecutionRecoveryPage,
  SponsoredExecutionStoreAdapter,
} from '../src/store/sponsoredExecutionStore.js';
import { TEST_SUI_TRANSACTION_DIGEST } from './helpers/suiGatewayResultFixtures.js';

const RECEIPT_ID = `0x${'11'.repeat(32)}`;
const SPONSOR_ADDRESS = `0x${'22'.repeat(32)}`;
const SENDER_ADDRESS = `0x${'33'.repeat(32)}`;
const PROMOTION_ID = '123e4567-e89b-42d3-a456-426614174000';
const USER_ID = 'runner-user';
const TX_BYTES = new Uint8Array([1, 2, 3, 4, 5]);
const TX_BYTES_HASH = createHash('sha256').update(TX_BYTES).digest('hex');
const USER_SIGNATURE = 'user-signature';

const SUCCESS_RESULT: Extract<ExecResult, { success: true }> = {
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

const ONCHAIN_FAILURE: Extract<ExecResult, { success: false; isCongestion: false }> = {
  success: false,
  executionStage: 'on_chain',
  digest: TEST_SUI_TRANSACTION_DIGEST,
  error: { kind: 'MovePrimitiveRuntimeError' },
  isCongestion: false,
  gasUsed: {
    computationCost: '1000',
    storageCost: '0',
    storageRebate: '0',
  },
};

const CONGESTION_RESULT: Extract<ExecResult, { success: false; isCongestion: true }> = {
  success: false,
  executionStage: 'after_sponsor_signature',
  digest: TEST_SUI_TRANSACTION_DIGEST,
  error: { kind: 'ExecutionCanceledDueToConsensusObjectCongestion' },
  isCongestion: true,
  gasUsed: null,
};

const GENERIC_PREPARED: GenericPreparedTxEntry = {
  mode: 'generic',
  receiptId: RECEIPT_ID,
  senderAddress: SENDER_ADDRESS,
  txBytesHash: TX_BYTES_HASH,
  sponsorAddress: SPONSOR_ADDRESS,
  clientIp: '127.0.0.1',
  executionPathKey: 'generic:test',
  orderId: null,
  nonce: 7n,
  issuedAt: 1_000,
};

const PROMOTION_PREPARED: PromotionPreparedTxEntry = {
  mode: 'promotion',
  receiptId: RECEIPT_ID,
  senderAddress: SENDER_ADDRESS,
  txBytesHash: TX_BYTES_HASH,
  sponsorAddress: SPONSOR_ADDRESS,
  clientIp: '127.0.0.1',
  executionPathKey: 'promotion:test',
  orderId: null,
  promotionId: PROMOTION_ID,
  userId: USER_ID,
  reservedGasMist: 1_400_000n,
  issuedAt: 1_000,
};

type StoreState = 'prepared' | 'executing' | 'final';

interface StoreOptions {
  readonly beginResult?: Exclude<BeginSponsoredExecutionResult, { status: 'executing' }>;
  readonly discardStateChanged?: boolean;
  readonly finalizeMode?: 'finalized' | 'already_final' | 'state_changed';
  readonly alterAlreadyFinalResult?: boolean;
  readonly markDeliveredError?: Error;
}

/**
 * Runner-only lifecycle fake. It deliberately implements state changes rather
 * than returning pre-programmed mocks so the tests can assert which durable
 * state exists at every policy and signing boundary.
 */
class LifecycleStore implements SponsoredExecutionStoreAdapter {
  state: StoreState = 'prepared';
  execution: ExecutingSponsoredExecutionRecord | null = null;
  final: FinalSponsoredExecutionRecord | null = null;
  readonly events: string[] = [];
  readonly beginInputs: BeginSponsoredExecutionInput[] = [];
  readonly discardInputs: DiscardPreparedReceiptInput[] = [];
  readonly finalizeInputs: FinalizeSponsoredExecutionInput[] = [];
  readonly promotionFinalizations: PromotionReceiptFinalization[] = [];
  markDeliveredCalls = 0;

  constructor(
    readonly prepared: PreparedTxEntry,
    private readonly options: StoreOptions = {},
  ) {}

  async commitPreparedReceipt(): Promise<PreparedTxEntry> {
    throw new Error('commitPreparedReceipt is outside the sponsor runner test boundary');
  }

  async readPreparedReceipt(receiptId: string): Promise<PreparedTxEntry | null> {
    this.events.push('read');
    return this.state === 'prepared' && receiptId === this.prepared.receiptId
      ? this.prepared
      : null;
  }

  async beginSponsoredExecution(
    input: BeginSponsoredExecutionInput,
  ): Promise<BeginSponsoredExecutionResult> {
    this.events.push('begin');
    this.beginInputs.push(input);
    if (this.options.beginResult) return this.options.beginResult;
    if (this.state !== 'prepared') return { status: 'state_changed' };
    const execution: ExecutingSponsoredExecutionRecord = {
      state: 'executing',
      receiptId: this.prepared.receiptId,
      sponsorAddress: this.prepared.sponsorAddress,
      txBytesHash: this.prepared.txBytesHash,
      transactionDigest: TEST_SUI_TRANSACTION_DIGEST,
      deadlineMs: this.prepared.issuedAt + input.executionBudgetMs,
      recovery: input.recovery,
    };
    this.execution = execution;
    this.state = 'executing';
    return { status: 'executing', prepared: this.prepared, execution };
  }

  async discardPreparedReceipt(
    input: DiscardPreparedReceiptInput,
  ): Promise<DiscardPreparedReceiptResult> {
    this.events.push('discard');
    this.discardInputs.push(input);
    if (this.options.discardStateChanged || this.state !== 'prepared') {
      return { status: 'state_changed' };
    }
    const record = this.makeFinal(input.result);
    this.final = record;
    this.state = 'final';
    return { status: 'discarded', record };
  }

  async finalizeSponsoredExecution(
    input: FinalizeSponsoredExecutionInput,
  ): Promise<FinalizeSponsoredExecutionResult> {
    this.events.push('finalize');
    this.finalizeInputs.push(input);
    this.promotionFinalizations.push(input.promotion);
    if (this.options.finalizeMode === 'state_changed') return { status: 'state_changed' };

    const metadata = this.options.alterAlreadyFinalResult
      ? { ...input.result, outcome: 'internal_error' as const }
      : input.result;
    const record = this.makeFinal(metadata);
    this.final = record;
    this.state = 'final';
    return {
      status: this.options.finalizeMode === 'already_final' ? 'already_final' : 'finalized',
      record,
    };
  }

  async markCallbackDelivered(expected: FinalSponsoredExecutionRecord): Promise<boolean> {
    this.events.push('callback-delivered');
    this.markDeliveredCalls += 1;
    if (this.options.markDeliveredError) throw this.options.markDeliveredError;
    if (this.final !== expected || expected.callbackDelivery !== 'pending') return false;
    this.final = { ...expected, callbackDelivery: 'delivered' };
    return true;
  }

  async readExpiredPreparedReceipts(): Promise<SponsoredExecutionRecoveryPage<PreparedTxEntry>> {
    return { records: [], nextCursor: null };
  }

  async readDueExecutions(): Promise<
    SponsoredExecutionRecoveryPage<ExecutingSponsoredExecutionRecord>
  > {
    return { records: [], nextCursor: null };
  }

  async readPendingCallbacks(): Promise<
    SponsoredExecutionRecoveryPage<FinalSponsoredExecutionRecord>
  > {
    return { records: [], nextCursor: null };
  }

  async checkUserQuota(): Promise<'ok'> {
    return 'ok';
  }

  async reserveNonce(): Promise<bigint> {
    return 1n;
  }

  async releaseNonceReservation(): Promise<void> {}

  async dispose(): Promise<void> {}

  private makeFinal(metadata: SponsorResultMetadata): FinalSponsoredExecutionRecord {
    return {
      state: 'final',
      receiptId: this.prepared.receiptId,
      sponsorAddress: this.prepared.sponsorAddress,
      transactionDigest: metadata.digest ?? null,
      finalizedAtMs: 2_000,
      callbackDelivery: 'pending',
      result: storeSponsorResult(metadata),
    };
  }
}

interface PolicyControl {
  readonly store: LifecycleStore;
  readonly failAt?: 'UserSignatureValidation' | 'Preflight';
  classifiedResult: ExecResult | null;
  readonly classificationError: Error;
}

function commonPrepareHooks() {
  return {
    Intent: () => undefined,
    RequestValidation: () => undefined,
    ChainSnapshot: () => ({}),
    GasBoundBuild: () => {
      throw new Error('GasBoundBuild is outside the sponsor runner test boundary');
    },
  } as const;
}

function assertPrepared(control: PolicyControl, event: string): void {
  control.store.events.push(event);
  expect(control.store.state).toBe('prepared');
}

function assertBeforePreparedRead(control: PolicyControl, event: string): void {
  control.store.events.push(event);
  expect(control.store.events).not.toContain('read');
  expect(control.store.state).toBe('prepared');
}

function classify(control: PolicyControl, result: ExecResult): void {
  control.store.events.push('classify');
  control.classifiedResult = result;
  if (!result.success) throw control.classificationError;
}

function makeGenericPolicy(control: PolicyControl): SponsoredExecutionPolicy<'generic'> {
  return {
    discriminator: 'generic',
    handleRequirements: {
      gasBoundBuild: { nonce: true },
      preparedCommit: {},
      sponsorResult: {},
    },
    hooks: {
      ...commonPrepareHooks(),
      ChainSnapshot: () => ({ nonceAcquire: { onchainLastNonce: 0n } }),
      DecodeSponsorSubmission: () => assertBeforePreparedRead(control, 'decode'),
      UserSignatureValidation: () => {
        assertBeforePreparedRead(control, 'signature-validation');
        if (control.failAt === 'UserSignatureValidation') throw new Error('signature rejected');
      },
      SharedSponsorChecks: () => {
        assertPrepared(control, 'shared-checks');
        return {
          nonce: {
            nonce: GENERIC_PREPARED.nonce,
            senderAddress: SENDER_ADDRESS,
            receiptId: RECEIPT_ID,
            inPtbNonceMatch: true,
          },
        };
      },
      PolicySponsorChecks: () => {
        assertPrepared(control, 'policy-checks');
        return {};
      },
      Preflight: () => {
        assertPrepared(control, 'preflight');
        if (control.failAt === 'Preflight') throw new Error('preflight rejected');
      },
      ClassifySponsorResult: (_context, result) => classify(control, result),
    },
  };
}

function makePromotionPolicy(control: PolicyControl): SponsoredExecutionPolicy<'promotion'> {
  return {
    discriminator: 'promotion',
    handleRequirements: {
      gasBoundBuild: {},
      preparedCommit: { ledgerReservation: true },
      sponsorResult: { ledgerReservation: true },
    },
    hooks: {
      ...commonPrepareHooks(),
      ChainSnapshot: () => ({}),
      DecodeSponsorSubmission: () => assertBeforePreparedRead(control, 'decode'),
      UserSignatureValidation: () => {
        assertBeforePreparedRead(control, 'signature-validation');
        if (control.failAt === 'UserSignatureValidation') throw new Error('signature rejected');
      },
      SharedSponsorChecks: () => {
        assertPrepared(control, 'shared-checks');
        return {};
      },
      PolicySponsorChecks: () => {
        assertPrepared(control, 'policy-checks');
        return {
          ledgerReservation: {
            receiptId: RECEIPT_ID,
            promotionId: PROMOTION_ID,
            userId: USER_ID,
            reservedGasMist: PROMOTION_PREPARED.reservedGasMist,
            ledgerLookupVerified: true,
          },
        };
      },
      Preflight: () => {
        assertPrepared(control, 'preflight');
        if (control.failAt === 'Preflight') throw new Error('preflight rejected');
      },
      ClassifySponsorResult: (_context, result) => classify(control, result),
    },
  };
}

function receiptPolicy(route: PreparedTxEntry['mode']): SponsorReceiptPolicyAdapter {
  return {
    route,
    onNotFound: () => new Error('receipt not found'),
    onExpired: () => new Error('receipt expired'),
    onHashMismatch: () => new Error('transaction bytes changed'),
    onPromotionNotActive: () => new Error('promotion not active'),
    onSponsorUnavailable: () => new Error('sponsor unavailable'),
    onStateChanged: () => new Error('receipt state changed'),
    onCorrupt: () => new Error('receipt corrupt'),
    validatePreparedEntry: (entry) => {
      if (entry.mode !== route) throw new Error('receipt mode changed');
    },
  };
}

function metadataBuilder(
  prepared: PreparedTxEntry,
  control: PolicyControl,
): SponsorStateMachineRequest<{ digest: string }>['buildResultMetadata'] {
  return (executionStage) => {
    const result = control.classifiedResult;
    const outcome = result
      ? result.success
        ? 'success'
        : result.isCongestion
          ? 'congestion'
          : 'onchain_revert'
      : control.failAt === 'Preflight'
        ? 'preflight_failure'
        : 'validation_failure';
    const known = result !== null && (result.success || !result.isCongestion);
    return {
      sponsorAddress: prepared.sponsorAddress,
      outcome,
      executionStage,
      route: prepared.mode,
      ...(result?.digest ? { digest: result.digest } : {}),
      receiptId: prepared.receiptId,
      senderAddress: prepared.senderAddress,
      executionPathKey: prepared.executionPathKey,
      orderIdHash: null,
      promotionId: prepared.mode === 'promotion' ? prepared.promotionId : null,
      userId: prepared.mode === 'promotion' ? prepared.userId : null,
      economics: known
        ? {
            economicsStatus: 'known',
            recoveredGasMist: '0',
            hostPaidGasMist: '1000',
            hostFeeMist: '0',
            hostNetMist: '-1000',
            grossGasMist: '1000',
            storageRebateMist: '0',
            protocolFeeMist: null,
            failureReason: result?.success ? null : 'on-chain failure',
          }
        : {
            economicsStatus: 'unknown',
            failureReason: outcome,
          },
    };
  };
}

function recoveryContext(prepared: PreparedTxEntry): SponsoredExecutionRecoveryContext {
  if (prepared.mode === 'promotion') {
    return {
      route: 'promotion',
      senderAddress: prepared.senderAddress,
      executionPathKey: prepared.executionPathKey,
      promotionId: prepared.promotionId,
      userId: prepared.userId,
      reservedGasMist: prepared.reservedGasMist.toString(),
    };
  }
  return {
    route: 'generic',
    senderAddress: prepared.senderAddress,
    executionPathKey: prepared.executionPathKey,
    orderIdHash: null,
    recoveredGasMist: '0',
    hostFeeMist: '0',
    protocolFeeMist: '0',
  };
}

function requestFor(
  prepared: PreparedTxEntry,
  control: PolicyControl,
  stateChangedError = new Error('durable receipt state changed'),
): SponsorStateMachineRequest<{ digest: string }> {
  return {
    hookContext: { receiptId: prepared.receiptId, clientIp: prepared.clientIp },
    txBytes: TX_BYTES,
    userSignature: USER_SIGNATURE,
    buildRecoveryContext: () => recoveryContext(prepared),
    buildResultMetadata: metadataBuilder(prepared, control),
    stateChangedError: () => stateChangedError,
    projectResult: (snapshot) => ({ digest: snapshot.execResult.digest }),
  };
}

function buildHarness(
  prepared: PreparedTxEntry,
  options: StoreOptions & {
    readonly result?: ExecResult;
    readonly signError?: unknown;
    readonly callbackError?: Error;
    readonly failAt?: PolicyControl['failAt'];
    readonly sponsorAvailable?: boolean;
  } = {},
) {
  const store = new LifecycleStore(prepared, options);
  const control: PolicyControl = {
    store,
    failAt: options.failAt,
    classifiedResult: null,
    classificationError: new Error('route classified execution failure'),
  };
  const signAndSubmit = vi.fn<SignAndSubmitPort>(
    async (_sponsor, _receipt, bytes, _signature, expectedDigest) => {
      store.events.push('sign-and-submit');
      expect(store.state).toBe('executing');
      expect(bytes).toBe(TX_BYTES);
      expect(expectedDigest).toBe(TEST_SUI_TRANSACTION_DIGEST);
      if (options.signError) throw options.signError;
      return options.result ?? SUCCESS_RESULT;
    },
  );
  const onSponsorResult = vi.fn(async () => {
    store.events.push('callback');
    if (options.callbackError) throw options.callbackError;
  });
  return {
    store,
    control,
    signAndSubmit,
    onSponsorResult,
    host: {
      store,
      signAndSubmit,
      endpointCount: 2,
      onSponsorResult,
      isSponsorAddressAvailable: vi.fn().mockResolvedValue(options.sponsorAvailable ?? true),
    },
    policy: prepared.mode === 'generic' ? makeGenericPolicy(control) : makePromotionPolicy(control),
    receiptPolicy: receiptPolicy(prepared.mode),
    request: requestFor(prepared, control),
  };
}

describe('runSponsorStateMachine durable lifecycle', () => {
  test('authenticates original bytes before reading the prepared record and submits the identical bytes', async () => {
    const harness = buildHarness(GENERIC_PREPARED);

    await expect(
      runSponsorStateMachine(harness.host, harness.request, harness.policy, harness.receiptPolicy),
    ).resolves.toEqual({ digest: TEST_SUI_TRANSACTION_DIGEST });

    expect(harness.store.events).toEqual([
      'decode',
      'signature-validation',
      'read',
      'shared-checks',
      'policy-checks',
      'preflight',
      'begin',
      'sign-and-submit',
      'classify',
      'finalize',
      'callback',
      'callback-delivered',
    ]);
    expect(harness.store.beginInputs).toHaveLength(1);
    expect(harness.store.beginInputs[0]?.txBytes).toBe(TX_BYTES);
    expect(harness.signAndSubmit).toHaveBeenCalledTimes(1);
    expect(harness.signAndSubmit.mock.calls[0]?.[2]).toBe(TX_BYTES);
    expect(harness.signAndSubmit.mock.calls[0]?.[4]).toBe(TEST_SUI_TRANSACTION_DIGEST);
    expect(harness.store.finalizeInputs).toHaveLength(1);
  });

  test('does not read the prepared record when user signature validation fails', async () => {
    const harness = buildHarness(GENERIC_PREPARED, {
      failAt: 'UserSignatureValidation',
    });

    await expect(
      runSponsorStateMachine(harness.host, harness.request, harness.policy, harness.receiptPolicy),
    ).rejects.toThrow('signature rejected');

    expect(harness.store.events).toEqual(['decode', 'signature-validation']);
    expect(harness.host.isSponsorAddressAvailable).not.toHaveBeenCalled();
    expect(harness.store.beginInputs).toHaveLength(0);
    expect(harness.signAndSubmit).not.toHaveBeenCalled();
  });

  test('keeps the prepared receipt intact when its assigned sponsor is unavailable', async () => {
    const harness = buildHarness(GENERIC_PREPARED, { sponsorAvailable: false });

    await expect(
      runSponsorStateMachine(harness.host, harness.request, harness.policy, harness.receiptPolicy),
    ).rejects.toThrow('sponsor unavailable');

    expect(harness.store.state).toBe('prepared');
    expect(harness.host.isSponsorAddressAvailable).toHaveBeenCalledOnce();
    expect(harness.host.isSponsorAddressAvailable).toHaveBeenCalledWith(
      GENERIC_PREPARED.sponsorAddress,
    );
    expect(harness.store.beginInputs).toHaveLength(0);
    expect(harness.store.discardInputs).toHaveLength(0);
    expect(harness.signAndSubmit).not.toHaveBeenCalled();
  });

  test('atomically discards a prepared receipt rejected by preflight and delivers the durable final callback without signing', async () => {
    const harness = buildHarness(GENERIC_PREPARED, { failAt: 'Preflight' });

    await expect(
      runSponsorStateMachine(harness.host, harness.request, harness.policy, harness.receiptPolicy),
    ).rejects.toThrow('preflight rejected');

    expect(harness.store.events).toEqual([
      'decode',
      'signature-validation',
      'read',
      'shared-checks',
      'policy-checks',
      'preflight',
      'discard',
      'callback',
      'callback-delivered',
    ]);
    expect(harness.store.discardInputs).toHaveLength(1);
    expect(harness.store.beginInputs).toHaveLength(0);
    expect(harness.store.finalizeInputs).toHaveLength(0);
    expect(harness.signAndSubmit).not.toHaveBeenCalled();
    expect(harness.store.final?.result.outcome).toBe('preflight_failure');
    expect(harness.store.final?.callbackDelivery).toBe('delivered');
  });

  test('leaves the receipt executing after a typed post-signature uncertainty and never submits a second time', async () => {
    const uncertainty = new SponsorPostSignatureUncertaintyError(
      TEST_SUI_TRANSACTION_DIGEST,
      new Error('transport response lost'),
    );
    const harness = buildHarness(GENERIC_PREPARED, { signError: uncertainty });

    await expect(
      runSponsorStateMachine(harness.host, harness.request, harness.policy, harness.receiptPolicy),
    ).rejects.toBe(uncertainty);

    expect(harness.store.state).toBe('executing');
    expect(harness.store.execution).not.toBeNull();
    expect(harness.signAndSubmit).toHaveBeenCalledTimes(1);
    expect(harness.store.finalizeInputs).toHaveLength(0);
    expect(harness.store.discardInputs).toHaveLength(0);
    expect(harness.onSponsorResult).not.toHaveBeenCalled();
  });

  test.each([
    {
      name: 'success consumes exact paid gas',
      result: SUCCESS_RESULT,
      expected: { operation: 'consume', chargedMist: 1000n },
      rejects: false,
    },
    {
      name: 'on-chain revert consumes exact paid gas',
      result: ONCHAIN_FAILURE,
      expected: { operation: 'consume', chargedMist: 1000n },
      rejects: true,
    },
    {
      name: 'congestion releases the reservation',
      result: CONGESTION_RESULT,
      expected: { operation: 'release' },
      rejects: true,
    },
  ] as const)('$name', async ({ result, expected, rejects }) => {
    const harness = buildHarness(PROMOTION_PREPARED, { result });
    const run = runSponsorStateMachine(
      harness.host,
      harness.request,
      harness.policy,
      harness.receiptPolicy,
    );

    if (rejects) await expect(run).rejects.toBe(harness.control.classificationError);
    else await expect(run).resolves.toEqual({ digest: TEST_SUI_TRANSACTION_DIGEST });

    expect(harness.store.promotionFinalizations).toEqual([expected]);
    expect(harness.store.finalizeInputs).toHaveLength(1);
    expect(harness.signAndSubmit).toHaveBeenCalledTimes(1);
  });

  test('keeps callback delivery pending when the host callback throws', async () => {
    const harness = buildHarness(GENERIC_PREPARED, {
      callbackError: new Error('callback unavailable'),
    });

    await expect(
      runSponsorStateMachine(harness.host, harness.request, harness.policy, harness.receiptPolicy),
    ).resolves.toEqual({ digest: TEST_SUI_TRANSACTION_DIGEST });

    expect(harness.onSponsorResult).toHaveBeenCalledTimes(1);
    expect(harness.store.markDeliveredCalls).toBe(0);
    expect(harness.store.final?.callbackDelivery).toBe('pending');
  });

  test('keeps the primary result successful when the delivery marker write fails', async () => {
    const harness = buildHarness(GENERIC_PREPARED, {
      markDeliveredError: new Error('callback marker Redis unavailable'),
    });

    await expect(
      runSponsorStateMachine(harness.host, harness.request, harness.policy, harness.receiptPolicy),
    ).resolves.toEqual({ digest: TEST_SUI_TRANSACTION_DIGEST });

    expect(harness.onSponsorResult).toHaveBeenCalledTimes(1);
    expect(harness.store.markDeliveredCalls).toBe(1);
    expect(harness.store.final?.callbackDelivery).toBe('pending');
  });

  test('accepts a matching already-final CAS result without a second submission', async () => {
    const harness = buildHarness(GENERIC_PREPARED, { finalizeMode: 'already_final' });

    await expect(
      runSponsorStateMachine(harness.host, harness.request, harness.policy, harness.receiptPolicy),
    ).resolves.toEqual({ digest: TEST_SUI_TRANSACTION_DIGEST });

    expect(harness.store.finalizeInputs).toHaveLength(1);
    expect(harness.signAndSubmit).toHaveBeenCalledTimes(1);
    expect(harness.onSponsorResult).toHaveBeenCalledTimes(1);
  });

  test('fails closed when an already-final CAS result belongs to a different outcome', async () => {
    const stateChanged = new Error('state changed sentinel');
    const store = new LifecycleStore(GENERIC_PREPARED, {
      finalizeMode: 'already_final',
      alterAlreadyFinalResult: true,
    });
    const control: PolicyControl = {
      store,
      classifiedResult: null,
      classificationError: new Error('route classified execution failure'),
    };
    const signAndSubmit = vi.fn<SignAndSubmitPort>(async () => SUCCESS_RESULT);
    const request = requestFor(GENERIC_PREPARED, control, stateChanged);

    await expect(
      runSponsorStateMachine(
        {
          store,
          signAndSubmit,
          endpointCount: 1,
          onSponsorResult: async () => {},
          isSponsorAddressAvailable: async () => true,
        },
        request,
        makeGenericPolicy(control),
        receiptPolicy('generic'),
      ),
    ).rejects.toBe(stateChanged);

    expect(signAndSubmit).toHaveBeenCalledTimes(1);
    expect(store.markDeliveredCalls).toBe(0);
  });

  test.each([
    { status: 'mode_mismatch', actualMode: 'promotion' } as const,
    { status: 'state_changed' } as const,
  ])('fails closed when begin reports $status', async (beginResult) => {
    const stateChanged = new Error('state changed sentinel');
    const store = new LifecycleStore(GENERIC_PREPARED, {
      beginResult,
      discardStateChanged: beginResult.status === 'state_changed',
    });
    const control: PolicyControl = {
      store,
      classifiedResult: null,
      classificationError: new Error('route classified execution failure'),
    };
    const signAndSubmit = vi.fn<SignAndSubmitPort>(async () => SUCCESS_RESULT);

    const run = runSponsorStateMachine(
      {
        store,
        signAndSubmit,
        endpointCount: 1,
        onSponsorResult: async () => {},
        isSponsorAddressAvailable: async () => true,
      },
      requestFor(GENERIC_PREPARED, control, stateChanged),
      makeGenericPolicy(control),
      receiptPolicy('generic'),
    );
    if (beginResult.status === 'state_changed') {
      await expect(run).rejects.toBe(stateChanged);
    } else {
      await expect(run).rejects.toThrow('receipt state changed');
    }

    expect(signAndSubmit).not.toHaveBeenCalled();
    expect(store.finalizeInputs).toHaveLength(0);
  });
});
