/**
 * studioExecutionPolicy.test.ts - Studio promotion SponsoredExecution
 * SponsoredExecutionPolicy implementation.
 *
 * These tests exercise the hook bodies and adapter helpers directly,
 * keeping the existing Studio route behavior as the target.
 */
import { beforeEach, describe, test, expect, vi } from 'vitest';
import { Transaction } from '@mysten/sui/transactions';
import { toBase58, toBase64 } from '@mysten/sui/utils';
import {
  buildStudioPreparedDraftFields,
  createStudioExecutionPolicy,
  createStudioSignAndSubmitPort,
  createStudioSponsorReceiptPolicy,
  projectStudioSponsorResult,
  type StudioExecutionPolicyDependencies,
  type StudioExecutionPolicyOptions,
  type StudioExecutionPolicyState,
  type StudioPolicyContext,
  type StudioPrepareErrorFactory,
  type StudioSponsorErrorFactory,
} from '../src/session/sponsoredExecution/studioExecutionPolicy.js';
import type { GasBoundBuildInput } from '../src/session/sponsoredExecution/reservationHandles.js';
import type {
  SponsorSubmissionContext,
  SponsorValidatedContext,
} from '../src/session/sponsoredExecution/executionPolicy.js';
import { reconstructReservationHandles } from '../src/session/sponsoredExecution/reservationHandles.js';
import {
  SenderSignatureError,
  SponsorPostSignatureUncertaintyError,
} from '../src/session/sessionPrimitives.js';
import type { ExecResult } from '../src/session/sessionTypes.js';
import type { PreparedTxEntry, PromotionPreparedTxEntry } from '../src/store/prepareTypes.js';
import type { PromotionExecutionLedger } from '../src/studio/executionLedger.js';
import type { Entitlement, Promotion } from '../src/studio/domain.js';
import type { SponsorPoolAdapter } from '../src/context.js';
import { SponsorLeaseExpiredError } from '../src/store/sponsorPoolErrors.js';
import type { OnchainConfig, SuiExecutionError } from '@stelis/core-relay';
import type { AddressBalanceGasTransaction } from '@stelis/core-relay/server';
import { canonicalizePromotionTarget } from '../src/studio/promotionTargetPolicy.js';
import {
  congestedSuiExecutionError,
  suiSimulationFailure,
  suiSimulationSuccess,
  TEST_SUI_TRANSACTION_DIGEST,
  unclassifiedSuiExecutionError,
  suiEndpointSnapshotFixture,
} from './helpers/suiGatewayResultFixtures.js';

const addressBalanceGasMocks = vi.hoisted(() => ({
  build: vi.fn(),
  simulate: vi.fn(),
  builds: new Map<
    object,
    {
      readonly transaction: unknown;
      readonly sponsorAddress: string;
      readonly gasBudget: bigint;
    }
  >(),
}));

vi.mock('@stelis/core-relay/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@stelis/core-relay/server')>()),
  buildAddressBalanceGasTransaction: addressBalanceGasMocks.build,
  simulateAddressBalanceGasTransaction: addressBalanceGasMocks.simulate,
}));

const SUI = suiEndpointSnapshotFixture();

const RECEIPT_ID = `0x${'ab'.repeat(32)}`;
const PROMOTION_ID = 'promo-1';
const USER_ID = 'user-1';
const SENDER = `0x${'11'.repeat(32)}`;
const DEEPBOOK_PACKAGE_ID = `0x${'77'.repeat(32)}`;
const OTHER_SENDER = `0x${'33'.repeat(32)}`;
const SPONSOR = `0x${'22'.repeat(32)}`;
const TX_HASH = 'a'.repeat(64);
const RESERVED_GAS = 2_000_000n;
const GAS_USED = {
  computationCost: '1000',
  storageCost: '500',
  storageRebate: '200',
};
const MOVE_FAILURE: SuiExecutionError = {
  kind: 'MovePrimitiveRuntimeError',
};
const CONGESTION_FAILURE = congestedSuiExecutionError();
const ALLOWED_TARGET = `0x${'88'.repeat(32)}::example::act`;

beforeEach(() => {
  addressBalanceGasMocks.builds.clear();
  addressBalanceGasMocks.build.mockReset().mockImplementation(async (_snapshot, options) => {
    const transaction = Object.freeze({}) as AddressBalanceGasTransaction;
    addressBalanceGasMocks.builds.set(transaction, {
      transaction: options.transaction,
      sponsorAddress: options.sponsorAddress,
      gasBudget: options.gasBudget,
    });
    return transaction;
  });
  addressBalanceGasMocks.simulate.mockReset();
});

function requireAddressBalanceGasBuild(transaction: AddressBalanceGasTransaction): {
  readonly transaction: unknown;
  readonly sponsorAddress: string;
  readonly gasBudget: bigint;
} {
  const build = addressBalanceGasMocks.builds.get(transaction);
  if (!build) {
    throw new TypeError('Test received an address-balance gas transaction outside the builder');
  }
  return build;
}

class TestStudioError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly meta?: {
      readonly gasUsed?: unknown;
      readonly digest?: string;
      readonly subcode?: string;
    },
  ) {
    super(message);
    this.name = 'TestStudioError';
  }
}

const sponsorErrors: StudioSponsorErrorFactory = {
  sponsor: (message, code, meta) => new TestStudioError(code, message, meta),
};

const prepareErrors: StudioPrepareErrorFactory = {
  prepare: (message: string, code: string) => new TestStudioError(code, message),
};

function makePromotionEntry(
  overrides: Partial<PromotionPreparedTxEntry> = {},
): PromotionPreparedTxEntry {
  return {
    mode: 'promotion',
    issuedAt: 1,
    receiptId: RECEIPT_ID,
    senderAddress: SENDER,
    clientIp: '127.0.0.1',
    txBytesHash: TX_HASH,
    sponsorAddress: SPONSOR,
    executionPathKey: `promotion:${PROMOTION_ID}`,
    orderId: null,
    promotionId: PROMOTION_ID,
    userId: USER_ID,
    reservedGasMist: RESERVED_GAS,
    ...overrides,
  };
}

function makeGenericEntry(): PreparedTxEntry {
  return {
    mode: 'generic',
    issuedAt: 1,
    receiptId: RECEIPT_ID,
    senderAddress: SENDER,
    clientIp: '127.0.0.1',
    txBytesHash: TX_HASH,
    sponsorAddress: SPONSOR,
    executionPathKey: 'credit',
    orderId: null,
    nonce: 7n,
  };
}

function makePromotion(overrides: Partial<Promotion> = {}): Promotion {
  return {
    promotionId: PROMOTION_ID,
    type: 'gas_sponsorship',
    displayName: 'Test',
    description: '',
    status: 'active',
    maxParticipants: 10,
    perUserGasAllowanceMist: '100000000',
    claimDeadlineAt: null,
    postClaimUseWindowMs: 0,
    startAt: null,
    pauseReason: null,
    archiveReason: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeEntitlement(overrides: Partial<Entitlement> = {}): Entitlement {
  return {
    promotionId: PROMOTION_ID,
    userId: USER_ID,
    claimedAt: '2026-01-01T00:00:00.000Z',
    useUntilAt: null,
    remainingGasAllowanceMist: '100000000',
    consumedGasAllowanceMist: '0',
    status: 'active',
    activeReservationReceiptId: RECEIPT_ID,
    activeReservationAmountMist: RESERVED_GAS.toString(),
    lastUsedAt: null,
    ...overrides,
  };
}

function makeContext(overrides: Partial<StudioPolicyContext> = {}): StudioPolicyContext {
  const ledger = {
    claim: vi.fn(),
    reserve: vi.fn(),
    consume: vi.fn(async () => ({ ok: true, entitlement: makeEntitlement() })),
    release: vi.fn(async () => ({ ok: true, entitlement: makeEntitlement() })),
    getEntitlement: vi.fn(async () => makeEntitlement()),
    getPromotionLedgerStatus: vi.fn(),
    sweepExpiredReservations: vi.fn(),
    dispose: vi.fn(),
  } as unknown as PromotionExecutionLedger;

  return {
    sui: SUI,
    packageId: `0x${'66'.repeat(32)}`,
    deepbookPackageId: DEEPBOOK_PACKAGE_ID,
    promotionStore: {
      get: vi.fn(async () => makePromotion()),
    } as unknown as StudioPolicyContext['promotionStore'],
    executionLedger: ledger,
    sponsorPool: {
      checkin: vi.fn(),
      sign: vi.fn(),
    } as unknown as SponsorPoolAdapter,
    sponsoredExecutionStore: {
      checkUserQuota: vi.fn(async () => 'ok' as const),
    },
    abuseBlocker: {} as StudioPolicyContext['abuseBlocker'],
    globalAllowedTargets: new Set([canonicalizePromotionTarget(ALLOWED_TARGET)]),
    getConfig: vi.fn(),
    onSponsorResult: undefined,
    ...overrides,
  };
}

function makeSponsorOptions(
  input: {
    readonly ctx?: StudioPolicyContext;
    readonly txBytes?: Uint8Array;
    readonly deps?: Partial<StudioExecutionPolicyDependencies>;
    readonly onSponsorResult?: StudioPolicyContext['onSponsorResult'];
  } = {},
): StudioExecutionPolicyOptions {
  const ctx = input.ctx ?? makeContext({ onSponsorResult: input.onSponsorResult });
  return {
    context: ctx,
    sponsor: {
      params: {
        promotionId: PROMOTION_ID,
        receiptId: RECEIPT_ID,
        verifiedIdentity: { userId: USER_ID, senderAddress: SENDER },
        clientIp: '127.0.0.1',
      },
      txBytes: input.txBytes ?? new Uint8Array([1, 2, 3]),
      userSignature: 'mock-user-signature',
      errors: sponsorErrors,
    },
    deps: input.deps,
  };
}

function makePrepareOptions(input: {
  readonly ctx?: StudioPolicyContext;
  readonly txKindBytes: string;
  readonly deps?: Partial<StudioExecutionPolicyDependencies>;
}): StudioExecutionPolicyOptions {
  return {
    context: input.ctx ?? makeContext(),
    prepare: {
      params: {
        promotionId: PROMOTION_ID,
        senderAddress: SENDER,
        txKindBytes: input.txKindBytes,
        verifiedIdentity: { userId: USER_ID, senderAddress: SENDER },
        clientIp: '127.0.0.1',
      },
      errors: prepareErrors,
    },
    deps: input.deps,
  };
}

function makeSubmissionCtx(): SponsorSubmissionContext {
  return {
    receiptId: RECEIPT_ID,
    clientIp: '127.0.0.1',
  };
}

function makeValidatedCtx(
  executionStage: SponsorValidatedContext['executionStage'] = 'before_sponsor_signature',
): SponsorValidatedContext {
  return {
    receiptId: RECEIPT_ID,
    clientIp: '127.0.0.1',
    executionStage,
    sponsorSlot: reconstructReservationHandles.sponsorSlot({
      sponsorAddress: SPONSOR,
      receiptId: RECEIPT_ID,
    }),
    ledgerReservation: reconstructReservationHandles.ledgerReservation({
      receiptId: RECEIPT_ID,
      promotionId: PROMOTION_ID,
      userId: USER_ID,
      reservedGasMist: RESERVED_GAS,
      ledgerLookupVerified: true,
    }),
  };
}

function seedSponsorState(
  state: StudioExecutionPolicyState,
  overrides: Partial<NonNullable<StudioExecutionPolicyState['sponsor']>> = {},
): void {
  const builtTxForValidation = new Transaction();
  builtTxForValidation.setSender(SENDER);
  state.sponsor = {
    txSender: SENDER,
    peekedPromotion: makePromotionEntry(),
    builtTxForValidation,
    prepared: makePromotionEntry(),
    sponsorResultOutcome: 'internal_error',
    sponsorResultEconomics: { economicsStatus: 'unknown', failureReason: null },
    ...overrides,
  };
}

async function buildTxBytes(sender: string, gasBudget = RESERVED_GAS): Promise<Uint8Array> {
  const tx = new Transaction();
  tx.setSender(sender);
  tx.setGasOwner(SPONSOR);
  tx.setGasBudget(gasBudget);
  tx.setGasPrice(1);
  const digestBytes = new Uint8Array(32);
  digestBytes.fill(1);
  tx.setGasPayment([
    {
      objectId: `0x${'44'.repeat(32)}`,
      version: '1',
      digest: toBase58(digestBytes),
    },
  ]);
  return tx.build({ onlyTransactionKind: false });
}

async function buildTxKindBytes(): Promise<string> {
  const tx = new Transaction();
  tx.moveCall({ target: ALLOWED_TARGET as `${string}::${string}::${string}` });
  return toBase64(await tx.build({ onlyTransactionKind: true }));
}

function makeBuildReadyTransaction(): Transaction {
  const tx = new Transaction();
  tx.moveCall({ target: ALLOWED_TARGET as `${string}::${string}::${string}` });
  return tx;
}

describe('createStudioExecutionPolicy', () => {
  test('declares promotion discriminator and Studio handle requirements', () => {
    const { policy } = createStudioExecutionPolicy(makeSponsorOptions());

    expect(policy.discriminator).toBe('promotion');
    expect(policy.handleRequirements.gasBoundBuild).toEqual({});
    expect(policy.handleRequirements.preparedCommit).toEqual({
      ledgerReservation: true,
    });
    expect(policy.handleRequirements.sponsorResult).toEqual({
      ledgerReservation: true,
    });
  });

  test('does not widen the package main barrel', async () => {
    const mainBarrel = await import('../src/index.js');
    expect(Object.prototype.hasOwnProperty.call(mainBarrel, 'createStudioExecutionPolicy')).toBe(
      false,
    );
    expect(
      Object.prototype.hasOwnProperty.call(mainBarrel, 'createStudioSponsorReceiptPolicy'),
    ).toBe(false);
  });
});

describe('studio prepare hooks', () => {
  test('RequestValidation enforces Studio identity, eligibility, tx-kind decode, targets, and quota', async () => {
    const txKindBytes = await buildTxKindBytes();
    const checkUserQuota = vi.fn(async () => 'ok' as const);
    const ctx = makeContext({
      sponsoredExecutionStore: {
        checkUserQuota,
      },
    });
    const { policy, state } = createStudioExecutionPolicy(makePrepareOptions({ ctx, txKindBytes }));

    await policy.hooks.RequestValidation({
      receiptId: RECEIPT_ID,
      senderAddress: SENDER,
      clientIp: '127.0.0.1',
    });

    expect(state.prepare?.kindTx).toBeDefined();
    expect(checkUserQuota).toHaveBeenCalledWith(USER_ID);
  });

  test('GasBoundBuild returns measured gas and policy exposes only route-owned draft fields', async () => {
    const txKindBytes = await buildTxKindBytes();
    const kindTx = makeBuildReadyTransaction();
    addressBalanceGasMocks.simulate.mockImplementationOnce(
      async (transaction: AddressBalanceGasTransaction) => {
        requireAddressBalanceGasBuild(transaction);
        return suiSimulationSuccess(GAS_USED);
      },
    );
    const ctx = makeContext({
      getConfig: vi.fn(async () => ({ maxClaimMist: 10_000_000n }) as OnchainConfig),
    });
    const options = makePrepareOptions({
      ctx,
      txKindBytes,
      deps: {
        deserializeUserTxKind: vi.fn(async () => kindTx),
      },
    });
    const { policy, state } = createStudioExecutionPolicy(options);

    await policy.hooks.RequestValidation({
      receiptId: RECEIPT_ID,
      senderAddress: SENDER,
      clientIp: '127.0.0.1',
    });
    await policy.hooks.ChainSnapshot({
      receiptId: RECEIPT_ID,
      senderAddress: SENDER,
      clientIp: '127.0.0.1',
    });
    const gasInput: GasBoundBuildInput = {
      reservationHandles: {
        sponsorSlot: reconstructReservationHandles.sponsorSlot({
          sponsorAddress: SPONSOR,
          receiptId: RECEIPT_ID,
        }),
      },
    };
    const buildResult = await policy.hooks.GasBoundBuild(
      {
        receiptId: RECEIPT_ID,
        senderAddress: SENDER,
        clientIp: '127.0.0.1',
      },
      gasInput,
    );

    const buildCalls = [...addressBalanceGasMocks.builds.entries()];
    expect(buildCalls).toHaveLength(2);
    expect(buildCalls[0]?.[1]).toEqual({
      transaction: kindTx,
      sponsorAddress: SPONSOR,
      gasBudget: 10_000_000n,
    });
    expect(addressBalanceGasMocks.simulate).toHaveBeenCalledWith(buildCalls[0]?.[0]);
    expect(buildCalls[1]?.[1]).toEqual({
      transaction: kindTx,
      sponsorAddress: SPONSOR,
      gasBudget: 101_300n,
    });
    expect(buildResult.addressBalanceGasTransaction).toBe(buildCalls[1]?.[0]);
    expect(kindTx.getData().gasData).toEqual({
      budget: null,
      owner: null,
      payment: null,
      price: null,
    });
    expect(buildResult.measuredGasMist).toBe(101_300n);
    const draftFields = buildStudioPreparedDraftFields(options, state);
    expect(draftFields).toEqual({
      executionPathKey: `promotion:${PROMOTION_ID}`,
      orderId: null,
    });
  });

  test('GasBoundBuild rejects a validated simulation failure with the specific boundary error', async () => {
    const txKindBytes = await buildTxKindBytes();
    const kindTx = makeBuildReadyTransaction();
    addressBalanceGasMocks.simulate.mockImplementationOnce(
      async (transaction: AddressBalanceGasTransaction) => {
        requireAddressBalanceGasBuild(transaction);
        return suiSimulationFailure(unclassifiedSuiExecutionError(), GAS_USED);
      },
    );
    const ctx = makeContext({
      getConfig: vi.fn(async () => ({ maxClaimMist: 10_000_000n }) as OnchainConfig),
    });
    const { policy } = createStudioExecutionPolicy(
      makePrepareOptions({
        ctx,
        txKindBytes,
        deps: {
          deserializeUserTxKind: vi.fn(async () => kindTx),
        },
      }),
    );
    const hookContext = {
      receiptId: RECEIPT_ID,
      senderAddress: SENDER,
      clientIp: '127.0.0.1',
    } as const;

    await policy.hooks.RequestValidation(hookContext);
    await policy.hooks.ChainSnapshot(hookContext);

    await expect(
      policy.hooks.GasBoundBuild(hookContext, {
        reservationHandles: {
          sponsorSlot: reconstructReservationHandles.sponsorSlot({
            sponsorAddress: SPONSOR,
            receiptId: RECEIPT_ID,
          }),
        },
      }),
    ).rejects.toMatchObject({
      code: 'DRY_RUN_FAILED',
      message: 'Dry-run failed: Sui execution failed (InvariantViolation)',
    });
  });
});

describe('studio sponsor validation', () => {
  test('UserSignatureValidation records studio-user abuse on canonical sender mismatch', async () => {
    const recordPromotionAbuseEvent = vi.fn();
    const txBytes = await buildTxBytes(OTHER_SENDER);
    const options = makeSponsorOptions({
      txBytes,
      deps: {
        verifySenderSignature: vi.fn(async () => undefined),
        validatePromotionSponsorSubmissionPolicy: vi.fn(async () => undefined),
        recordPromotionAbuseEvent:
          recordPromotionAbuseEvent as unknown as StudioExecutionPolicyDependencies['recordPromotionAbuseEvent'],
      },
    });
    const { policy } = createStudioExecutionPolicy(options);

    await policy.hooks.DecodeSponsorSubmission(makeSubmissionCtx());
    await expect(policy.hooks.UserSignatureValidation(makeSubmissionCtx())).rejects.toMatchObject({
      code: 'SENDER_SIGNATURE_INVALID',
    });
    expect(recordPromotionAbuseEvent).toHaveBeenCalledWith(
      expect.anything(),
      '127.0.0.1',
      { kind: 'studio_user', userId: USER_ID },
      'PROMO_SENDER_SIGNATURE_INVALID',
      expect.objectContaining({ detail: 'verified_identity_sender_mismatch' }),
    );
  });

  test('UserSignatureValidation records studio-user abuse on signature failure', async () => {
    const recordPromotionAbuseEvent = vi.fn();
    const txBytes = await buildTxBytes(SENDER);
    const options = makeSponsorOptions({
      txBytes,
      deps: {
        verifySenderSignature: vi.fn(async () => {
          throw new SenderSignatureError('bad signature');
        }) as unknown as StudioExecutionPolicyDependencies['verifySenderSignature'],
        recordPromotionAbuseEvent:
          recordPromotionAbuseEvent as unknown as StudioExecutionPolicyDependencies['recordPromotionAbuseEvent'],
      },
    });
    const { policy } = createStudioExecutionPolicy(options);

    await policy.hooks.DecodeSponsorSubmission(makeSubmissionCtx());
    await expect(policy.hooks.UserSignatureValidation(makeSubmissionCtx())).rejects.toMatchObject({
      code: 'SENDER_SIGNATURE_INVALID',
    });
    expect(recordPromotionAbuseEvent).toHaveBeenCalledWith(
      expect.anything(),
      '127.0.0.1',
      { kind: 'studio_user', userId: USER_ID },
      'PROMO_SENDER_SIGNATURE_INVALID',
      expect.objectContaining({ detail: 'sender_signature_invalid' }),
    );
  });

  test('decodes once and reuses that Transaction for signature, prepared policy, and gas checks', async () => {
    const txBytes = await buildTxBytes(SENDER);
    const validatePromotionSponsorSubmissionPolicy = vi.fn<
      StudioExecutionPolicyDependencies['validatePromotionSponsorSubmissionPolicy']
    >(async () => undefined);
    const validatePromotionPreparedPolicy = vi.fn<
      StudioExecutionPolicyDependencies['validatePromotionPreparedPolicy']
    >(async () => undefined);
    const verifySenderSignature = vi.fn<StudioExecutionPolicyDependencies['verifySenderSignature']>(
      async () => undefined,
    );
    const verifyGasOwner = vi.fn<StudioExecutionPolicyDependencies['verifyGasOwner']>(() => ({
      owner: SPONSOR,
      budget: RESERVED_GAS,
    }));
    const options = makeSponsorOptions({
      txBytes,
      deps: {
        validatePromotionSponsorSubmissionPolicy,
        validatePromotionPreparedPolicy,
        verifySenderSignature,
        verifyGasOwner,
      },
    });
    const { policy, state } = createStudioExecutionPolicy(options);
    const transactionFrom = vi.spyOn(Transaction, 'from');

    try {
      await policy.hooks.DecodeSponsorSubmission(makeSubmissionCtx());
      const decoded = state.sponsor?.builtTxForValidation;
      expect(decoded).toBeInstanceOf(Transaction);

      await policy.hooks.UserSignatureValidation(makeSubmissionCtx());
      await createStudioSponsorReceiptPolicy({
        context: options.context,
        params: options.sponsor!.params,
        state,
        errors: sponsorErrors,
        deps: options.deps,
      }).validatePreparedEntry(makePromotionEntry());
      await policy.hooks.SharedSponsorChecks(makeValidatedCtx());

      expect(transactionFrom).toHaveBeenCalledTimes(1);
      expect(validatePromotionSponsorSubmissionPolicy.mock.calls[0]?.[2]).toBe(decoded);
      expect(validatePromotionPreparedPolicy.mock.calls[0]?.[3]).toBe(decoded);
      expect(verifyGasOwner.mock.calls[0]?.[0]).toBe(decoded);
      expect(verifySenderSignature).toHaveBeenCalledWith(txBytes, 'mock-user-signature', SENDER);
    } finally {
      transactionFrom.mockRestore();
    }
  });
});

describe('createStudioSponsorReceiptPolicy', () => {
  test('hash mismatch records studio-user tampering without mutating the ledger', async () => {
    const recordSponsorFailureForAbuse = vi.fn();
    const state: StudioExecutionPolicyState = {};
    seedSponsorState(state);
    const context = makeContext();
    const adapter = createStudioSponsorReceiptPolicy({
      context,
      params: {
        promotionId: PROMOTION_ID,
        receiptId: RECEIPT_ID,
        verifiedIdentity: { userId: USER_ID, senderAddress: SENDER },
        clientIp: '203.0.113.10',
      },
      state,
      errors: sponsorErrors,
      deps: {
        recordSponsorFailureForAbuse:
          recordSponsorFailureForAbuse as unknown as StudioExecutionPolicyDependencies['recordSponsorFailureForAbuse'],
      },
    });

    const err = await adapter.onHashMismatch(RECEIPT_ID);

    expect(err).toMatchObject({ code: 'TAMPERING_DETECTED' });
    expect(context.executionLedger.consume).not.toHaveBeenCalled();
    expect(context.executionLedger.release).not.toHaveBeenCalled();
    expect(recordSponsorFailureForAbuse).toHaveBeenCalledWith(
      expect.anything(),
      '203.0.113.10',
      { kind: 'studio_user', userId: USER_ID },
      'TAMPERING_DETECTED',
      expect.objectContaining({ executionPathKey: `promotion:${PROMOTION_ID}` }),
    );
  });

  test('captures promotion entries and rejects generic entries without lifecycle mutation', async () => {
    const checkin = vi.fn();
    const state: StudioExecutionPolicyState = {};
    seedSponsorState(state, { prepared: undefined });
    const adapter = createStudioSponsorReceiptPolicy({
      context: makeContext({
        sponsorPool: {
          checkin,
          sign: vi.fn(),
        } as unknown as SponsorPoolAdapter,
      }),
      params: {
        promotionId: PROMOTION_ID,
        receiptId: RECEIPT_ID,
        verifiedIdentity: { userId: USER_ID, senderAddress: SENDER },
        clientIp: '127.0.0.1',
      },
      state,
      errors: sponsorErrors,
    });

    const promotion = makePromotionEntry();
    await adapter.validatePreparedEntry(promotion);
    expect(state.sponsor?.prepared).toBe(promotion);

    let error: unknown;
    try {
      await adapter.validatePreparedEntry(makeGenericEntry());
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: 'MODE_MISMATCH' });
    expect(checkin).not.toHaveBeenCalled();
  });
});

describe('studio sponsor read-only checks', () => {
  test('PolicySponsorChecks verifies active ledger reservation and returns reconstruction inputs', async () => {
    const { policy, state } = createStudioExecutionPolicy(makeSponsorOptions());
    seedSponsorState(state);

    const out = await policy.hooks.PolicySponsorChecks(makeValidatedCtx());

    expect(out?.ledgerReservation).toEqual({
      receiptId: RECEIPT_ID,
      promotionId: PROMOTION_ID,
      userId: USER_ID,
      reservedGasMist: RESERVED_GAS,
      ledgerLookupVerified: true,
    });
  });

  test('SharedSponsorChecks maps gas-budget drift to REPREPARE_REQUIRED without lifecycle mutation', async () => {
    const { policy, state } = createStudioExecutionPolicy(
      makeSponsorOptions({
        deps: {
          verifyGasOwner: vi.fn(() => ({ owner: SPONSOR, budget: RESERVED_GAS + 1n })),
        },
      }),
    );
    seedSponsorState(state);

    await expect(policy.hooks.SharedSponsorChecks(makeValidatedCtx())).rejects.toMatchObject({
      code: 'REPREPARE_REQUIRED',
    });
    expect(state.sponsor?.sponsorResultOutcome).toBe('validation_failure');
  });

  test('Preflight classifies and records studio-user abuse without lifecycle mutation', async () => {
    const recordSponsorFailureForAbuse = vi.fn();
    const { policy, state } = createStudioExecutionPolicy(
      makeSponsorOptions({
        deps: {
          runPreflight: vi.fn(async () => ({
            success: false as const,
            error: MOVE_FAILURE,
          })),
          recordSponsorFailureForAbuse:
            recordSponsorFailureForAbuse as unknown as StudioExecutionPolicyDependencies['recordSponsorFailureForAbuse'],
        },
      }),
    );
    seedSponsorState(state);

    await expect(policy.hooks.Preflight(makeValidatedCtx())).rejects.toMatchObject({
      code: 'PREFLIGHT_FAILED',
    });
    expect(recordSponsorFailureForAbuse).toHaveBeenCalledWith(
      expect.anything(),
      '127.0.0.1',
      { kind: 'studio_user', userId: USER_ID },
      'PREFLIGHT_FAILED',
      expect.objectContaining({ executionPathKey: `promotion:${PROMOTION_ID}` }),
    );
    expect(state.sponsor?.sponsorResultOutcome).toBe('preflight_failure');
  });
});

describe('studio sponsor result classification and sign port', () => {
  test('ClassifySponsorResult records success economics and projects the route result without lifecycle mutation', async () => {
    const context = makeContext();
    const { policy, state } = createStudioExecutionPolicy(makeSponsorOptions({ ctx: context }));
    seedSponsorState(state);
    const success: Extract<ExecResult, { success: true }> = {
      success: true,
      executionStage: 'on_chain',
      digest: TEST_SUI_TRANSACTION_DIGEST,
      effects: { status: 'ok' },
      gasUsed: GAS_USED,
    };

    await policy.hooks.ClassifySponsorResult(makeValidatedCtx('on_chain'), success);
    const projected = projectStudioSponsorResult(makeSponsorOptions(), state);

    expect(context.executionLedger.consume).not.toHaveBeenCalled();
    expect(context.executionLedger.release).not.toHaveBeenCalled();
    expect(projected).toEqual({
      digest: TEST_SUI_TRANSACTION_DIGEST,
      effects: { status: 'ok' },
      actualGasMist: '1300',
    });
    expect(state.sponsor?.sponsorResultEconomics).toMatchObject({
      economicsStatus: 'known',
      recoveredGasMist: '0',
      hostPaidGasMist: '1300',
      hostFeeMist: '0',
      hostNetMist: '-1300',
    });
  });

  test('ClassifySponsorResult records studio-user abuse and known gas loss on on-chain revert', async () => {
    const recordSponsorFailureForAbuse = vi.fn();
    const context = makeContext();
    const { policy, state } = createStudioExecutionPolicy(
      makeSponsorOptions({
        ctx: context,
        deps: {
          recordSponsorFailureForAbuse:
            recordSponsorFailureForAbuse as unknown as StudioExecutionPolicyDependencies['recordSponsorFailureForAbuse'],
        },
      }),
    );
    seedSponsorState(state);
    const failed: ExecResult = {
      success: false,
      executionStage: 'on_chain',
      digest: TEST_SUI_TRANSACTION_DIGEST,
      error: MOVE_FAILURE,
      isCongestion: false,
      gasUsed: GAS_USED,
    };

    await expect(
      policy.hooks.ClassifySponsorResult(makeValidatedCtx('on_chain'), failed),
    ).rejects.toMatchObject({ code: 'ONCHAIN_REVERT' });
    expect(context.executionLedger.consume).not.toHaveBeenCalled();
    expect(context.executionLedger.release).not.toHaveBeenCalled();
    expect(recordSponsorFailureForAbuse).toHaveBeenCalledWith(
      expect.anything(),
      '127.0.0.1',
      { kind: 'studio_user', userId: USER_ID },
      'ONCHAIN_REVERT',
      expect.objectContaining({ executionPathKey: `promotion:${PROMOTION_ID}` }),
    );
    expect(state.sponsor?.sponsorResultOutcome).toBe('onchain_revert');
    expect(state.sponsor?.sponsorResultEconomics).toMatchObject({
      economicsStatus: 'known',
      recoveredGasMist: '0',
      hostPaidGasMist: '1300',
      hostNetMist: '-1300',
    });
  });

  test('ClassifySponsorResult preserves classified congestion without lifecycle mutation', async () => {
    const context = makeContext();
    const { policy, state } = createStudioExecutionPolicy(
      makeSponsorOptions({
        ctx: context,
      }),
    );
    seedSponsorState(state);
    const failed: ExecResult = {
      success: false,
      executionStage: 'after_sponsor_signature',
      digest: '',
      error: CONGESTION_FAILURE,
      isCongestion: true,
      gasUsed: null,
    };

    await expect(
      policy.hooks.ClassifySponsorResult(makeValidatedCtx('after_sponsor_signature'), failed),
    ).rejects.toMatchObject({ code: 'SPONSOR_CONGESTION' });
    expect(context.executionLedger.consume).not.toHaveBeenCalled();
    expect(context.executionLedger.release).not.toHaveBeenCalled();
    expect(state.sponsor?.sponsorResultOutcome).toBe('congestion');
  });

  test('signAndSubmit port preserves post-signature uncertainty for runner recovery', async () => {
    const rawCause = new Error('rpc transport error');
    const expectedDigest = 'expected-sui-transaction-digest';
    const signAndSubmit = vi.fn(
      async (..._args: Parameters<StudioExecutionPolicyDependencies['signAndSubmit']>) => {
        throw new SponsorPostSignatureUncertaintyError(expectedDigest, rawCause);
      },
    );
    const options = makeSponsorOptions({
      ctx: makeContext(),
      deps: {
        signAndSubmit:
          signAndSubmit as unknown as StudioExecutionPolicyDependencies['signAndSubmit'],
      },
    });
    const { state } = createStudioExecutionPolicy(options);
    seedSponsorState(state);
    const port = createStudioSignAndSubmitPort(options, state);

    const submittedBytes = new Uint8Array([1, 2, 3]);
    const thrown = await port(SPONSOR, RECEIPT_ID, submittedBytes, 'sig', expectedDigest).catch(
      (err: unknown) => err,
    );
    expect(thrown).toBeInstanceOf(SponsorPostSignatureUncertaintyError);
    expect((thrown as SponsorPostSignatureUncertaintyError).cause).toBe(rawCause);
    expect((thrown as SponsorPostSignatureUncertaintyError).expectedDigest).toBe(expectedDigest);

    expect(signAndSubmit).toHaveBeenCalledTimes(1);
    expect(signAndSubmit.mock.calls[0]?.[4]).toBe(submittedBytes);
  });

  test('signAndSubmit port maps a strict lease failure without mutating the ledger', async () => {
    const leaseErr = new SponsorLeaseExpiredError(SPONSOR);
    const context = makeContext();
    const options = makeSponsorOptions({
      ctx: context,
      deps: {
        signAndSubmit: vi.fn(async () => {
          throw leaseErr;
        }) as unknown as StudioExecutionPolicyDependencies['signAndSubmit'],
      },
    });
    const { state } = createStudioExecutionPolicy(options);
    seedSponsorState(state);
    const port = createStudioSignAndSubmitPort(options, state);

    await expect(
      port(SPONSOR, RECEIPT_ID, new Uint8Array([1, 2, 3]), 'sig', TEST_SUI_TRANSACTION_DIGEST),
    ).rejects.toMatchObject({ code: 'LEASE_EXPIRED' });
    expect(context.executionLedger.consume).not.toHaveBeenCalled();
    expect(context.executionLedger.release).not.toHaveBeenCalled();
    expect(state.sponsor?.sponsorResultOutcome).toBe('validation_failure');
  });
});
