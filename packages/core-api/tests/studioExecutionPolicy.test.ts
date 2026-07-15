/**
 * studioExecutionPolicy.test.ts - Studio promotion SponsoredExecution
 * SponsoredExecutionPolicy implementation.
 *
 * These tests exercise the hook bodies and adapter helpers directly,
 * keeping the existing Studio route behavior as the target.
 */
import { describe, test, expect, vi } from 'vitest';
import { Transaction } from '@mysten/sui/transactions';
import { toBase58, toBase64 } from '@mysten/sui/utils';
import {
  buildStudioPreparedDraftFields,
  createStudioExecutionPolicy,
  createStudioSignAndSubmitPort,
  createStudioSponsorConsumeAdapter,
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
  PostConsumeSponsorContext,
  PreConsumeSponsorContext,
} from '../src/session/sponsoredExecution/executionPolicy.js';
import { reconstructReservationHandles } from '../src/session/sponsoredExecution/reservationHandles.js';
import {
  SenderSignatureError,
  SponsorPostSignatureUncertaintyError,
} from '../src/session/sessionPrimitives.js';
import type { ExecResult } from '../src/session/sessionTypes.js';
import type { PreparedTxEntry, PromotionPreparedTxEntry } from '../src/store/prepareTypes.js';
import type { PromotionExecutionLedger } from '../src/studio/executionLedger.js';
import type { CreateUsageEventInput, Entitlement, Promotion } from '../src/studio/domain.js';
import type { SponsorPoolAdapter } from '../src/context.js';
import type { OnchainConfig, SuiEndpointSnapshot, SuiExecutionError } from '@stelis/core-relay';
import { canonicalizePromotionTarget } from '../src/studio/promotionTargetPolicy.js';
import {
  bindSuiResultToTransactionBytes,
  congestedSuiExecutionError,
  suiSimulationFailure,
  suiSimulationSuccess,
  TEST_SUI_TRANSACTION_DIGEST,
  unclassifiedSuiExecutionError,
  suiEndpointSnapshotFixture,
} from './helpers/suiGatewayResultFixtures.js';

const { simulateSuiTransactionMock } = vi.hoisted(() => ({
  simulateSuiTransactionMock: vi.fn(),
}));

vi.mock('@stelis/core-relay', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@stelis/core-relay')>()),
  simulateSuiTransaction: simulateSuiTransactionMock,
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
    nonce: 0n,
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

function makeContext(
  overrides: Partial<StudioPolicyContext> = {},
  usageRows: CreateUsageEventInput[] = [],
): StudioPolicyContext {
  const ledger = {
    claim: vi.fn(),
    reserve: vi.fn(),
    consume: vi.fn(async () => ({ ok: true, entitlement: makeEntitlement() })),
    release: vi.fn(async () => ({ ok: true, entitlement: makeEntitlement() })),
    getEntitlement: vi.fn(async () => makeEntitlement()),
    getBudgetSummary: vi.fn(),
    getClaimedCount: vi.fn(),
    listClaimedUsers: vi.fn(),
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
    prepareStore: {
      peek: vi.fn(),
      evictPreparedEntry: vi.fn(),
      checkUserQuota: vi.fn(async () => 'ok' as const),
    },
    abuseBlocker: {} as StudioPolicyContext['abuseBlocker'],
    usageStore: {
      append: vi.fn(async (input: CreateUsageEventInput) => {
        usageRows.push(input);
        return { ...input, createdAt: '2026-01-01T00:00:00.000Z' };
      }),
      getByReceipt: vi.fn(),
      getByUser: vi.fn(),
      getByPromotion: vi.fn(),
    },
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

function makePreCtx(): PreConsumeSponsorContext {
  return {
    receiptId: RECEIPT_ID,
    clientIp: '127.0.0.1',
  };
}

function makePostCtx(): PostConsumeSponsorContext {
  return {
    receiptId: RECEIPT_ID,
    clientIp: '127.0.0.1',
    executionStage: 'on_chain',
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
  state.sponsor = {
    txSender: SENDER,
    peeked: makePromotionEntry(),
    peekedPromotion: makePromotionEntry(),
    builtTxForValidation: new Transaction(),
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
  tx.setGasPrice(1);
  const digestBytes = new Uint8Array(32);
  digestBytes.fill(2);
  tx.setGasPayment([
    {
      objectId: `0x${'55'.repeat(32)}`,
      version: '1',
      digest: toBase58(digestBytes),
    },
  ]);
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
      Object.prototype.hasOwnProperty.call(mainBarrel, 'createStudioSponsorConsumeAdapter'),
    ).toBe(false);
  });
});

describe('studio prepare hooks', () => {
  test('RequestValidation enforces Studio identity, eligibility, tx-kind decode, targets, and quota', async () => {
    const txKindBytes = await buildTxKindBytes();
    const checkUserQuota = vi.fn(async () => 'ok' as const);
    const ctx = makeContext({
      prepareStore: {
        peek: vi.fn(),
        evictPreparedEntry: vi.fn(),
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
    simulateSuiTransactionMock.mockImplementationOnce(
      async (_snapshot: SuiEndpointSnapshot, input: { transaction: Uint8Array }) =>
        bindSuiResultToTransactionBytes(
          suiSimulationSuccess(TEST_SUI_TRANSACTION_DIGEST, GAS_USED),
          input.transaction,
        ),
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

    expect(kindTx.getData().gasData.owner).toBe(SPONSOR);
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
    simulateSuiTransactionMock.mockImplementationOnce(
      async (_snapshot: SuiEndpointSnapshot, input: { transaction: Uint8Array }) =>
        bindSuiResultToTransactionBytes(
          suiSimulationFailure(
            TEST_SUI_TRANSACTION_DIGEST,
            unclassifiedSuiExecutionError(),
            GAS_USED,
          ),
          input.transaction,
        ),
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

describe('studio sponsor preconsume', () => {
  test('DecodeSponsorSubmission rejects generic-mode peek non-destructively', async () => {
    const release = vi.fn();
    const ctx = makeContext({
      prepareStore: {
        peek: vi.fn(async () => makeGenericEntry()),
        evictPreparedEntry: vi.fn(),
        checkUserQuota: vi.fn(async () => 'ok' as const),
      },
      executionLedger: {
        ...makeContext().executionLedger,
        release,
      } as unknown as PromotionExecutionLedger,
    });
    const { policy } = createStudioExecutionPolicy(makeSponsorOptions({ ctx }));

    await expect(policy.hooks.DecodeSponsorSubmission(makePreCtx())).rejects.toMatchObject({
      code: 'MODE_MISMATCH',
    });
    expect(release).not.toHaveBeenCalled();
    expect(ctx.prepareStore.evictPreparedEntry).not.toHaveBeenCalled();
  });

  test('UserSignatureValidation records studio-user abuse on canonical sender mismatch', async () => {
    const recordPromotionAbuseEvent = vi.fn();
    const txBytes = await buildTxBytes(OTHER_SENDER);
    const ctx = makeContext({
      prepareStore: {
        peek: vi.fn(async () => makePromotionEntry()),
        evictPreparedEntry: vi.fn(),
        checkUserQuota: vi.fn(async () => 'ok' as const),
      },
    });
    const { policy } = createStudioExecutionPolicy(
      makeSponsorOptions({
        ctx,
        txBytes,
        deps: {
          validatePromotionPreconsumePolicy: vi.fn(async () => ({
            builtTx: Transaction.from(txBytes),
          })) as unknown as StudioExecutionPolicyDependencies['validatePromotionPreconsumePolicy'],
          recordPromotionAbuseEvent:
            recordPromotionAbuseEvent as unknown as StudioExecutionPolicyDependencies['recordPromotionAbuseEvent'],
        },
      }),
    );

    await policy.hooks.DecodeSponsorSubmission(makePreCtx());
    await expect(policy.hooks.UserSignatureValidation(makePreCtx())).rejects.toMatchObject({
      code: 'SENDER_SIGNATURE_INVALID',
    });
    expect(recordPromotionAbuseEvent).toHaveBeenCalledWith(
      expect.anything(),
      '127.0.0.1',
      { kind: 'studio_user', userId: USER_ID },
      'PROMO_SENDER_SIGNATURE_INVALID',
      expect.objectContaining({ detail: 'canonical_sender_mismatch' }),
    );
  });

  test('UserSignatureValidation records studio-user abuse on signature failure', async () => {
    const recordPromotionAbuseEvent = vi.fn();
    const txBytes = await buildTxBytes(SENDER);
    const { policy } = createStudioExecutionPolicy(
      makeSponsorOptions({
        txBytes,
        ctx: makeContext({
          prepareStore: {
            peek: vi.fn(async () => makePromotionEntry()),
            evictPreparedEntry: vi.fn(),
            checkUserQuota: vi.fn(async () => 'ok' as const),
          },
        }),
        deps: {
          validatePromotionPreconsumePolicy: vi.fn(async () => ({
            builtTx: Transaction.from(txBytes),
          })) as unknown as StudioExecutionPolicyDependencies['validatePromotionPreconsumePolicy'],
          verifySenderSignature: vi.fn(async () => {
            throw new SenderSignatureError('bad signature');
          }) as unknown as StudioExecutionPolicyDependencies['verifySenderSignature'],
          recordPromotionAbuseEvent:
            recordPromotionAbuseEvent as unknown as StudioExecutionPolicyDependencies['recordPromotionAbuseEvent'],
        },
      }),
    );

    await policy.hooks.DecodeSponsorSubmission(makePreCtx());
    await expect(policy.hooks.UserSignatureValidation(makePreCtx())).rejects.toMatchObject({
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
});

describe('createStudioSponsorConsumeAdapter', () => {
  test('hash mismatch releases ledger and records studio-user tampering', async () => {
    const releaseLedgerReservationWithLog = vi.fn();
    const recordSponsorFailureForAbuse = vi.fn();
    const state: StudioExecutionPolicyState = {};
    seedSponsorState(state);
    const adapter = createStudioSponsorConsumeAdapter({
      context: makeContext(),
      params: {
        promotionId: PROMOTION_ID,
        receiptId: RECEIPT_ID,
        verifiedIdentity: { userId: USER_ID, senderAddress: SENDER },
        clientIp: '203.0.113.10',
      },
      state,
      errors: sponsorErrors,
      deps: {
        releaseLedgerReservationWithLog:
          releaseLedgerReservationWithLog as unknown as StudioExecutionPolicyDependencies['releaseLedgerReservationWithLog'],
        recordSponsorFailureForAbuse:
          recordSponsorFailureForAbuse as unknown as StudioExecutionPolicyDependencies['recordSponsorFailureForAbuse'],
      },
    });

    const err = await adapter.onHashMismatch(RECEIPT_ID);

    expect(err).toMatchObject({ code: 'TAMPERING_DETECTED' });
    expect(releaseLedgerReservationWithLog).toHaveBeenCalledWith(
      expect.anything(),
      RECEIPT_ID,
      'hash_mismatch',
    );
    expect(recordSponsorFailureForAbuse).toHaveBeenCalledWith(
      expect.anything(),
      '203.0.113.10',
      { kind: 'studio_user', userId: USER_ID },
      'TAMPERING_DETECTED',
      expect.objectContaining({ executionPathKey: `promotion:${PROMOTION_ID}` }),
    );
  });

  test('validateConsumedEntry captures promotion entries and checkins non-promotion race results', async () => {
    const checkin = vi.fn();
    const state: StudioExecutionPolicyState = {};
    seedSponsorState(state, { prepared: undefined });
    const adapter = createStudioSponsorConsumeAdapter({
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
    await adapter.validateConsumedEntry?.(promotion);
    expect(state.sponsor?.prepared).toBe(promotion);

    await expect(adapter.validateConsumedEntry?.(makeGenericEntry())).rejects.toMatchObject({
      code: 'SPONSOR_FAILED',
    });
    expect(checkin).toHaveBeenCalledWith(SPONSOR, RECEIPT_ID, TX_HASH);
  });
});

describe('studio sponsor postconsume hooks', () => {
  test('PolicyPostconsumeChecks verifies active ledger reservation and returns reconstruction inputs', async () => {
    const { policy, state } = createStudioExecutionPolicy(makeSponsorOptions());
    seedSponsorState(state);

    const out = await policy.hooks.PolicyPostconsumeChecks(makePostCtx());

    expect(out?.ledgerReservation).toEqual({
      receiptId: RECEIPT_ID,
      promotionId: PROMOTION_ID,
      userId: USER_ID,
      reservedGasMist: RESERVED_GAS,
      ledgerLookupVerified: true,
    });
  });

  test('SharedPostconsumeChecks maps gas-budget drift to REPREPARE_REQUIRED and releases ledger', async () => {
    const releaseLedgerReservationWithLog = vi.fn();
    const { policy, state } = createStudioExecutionPolicy(
      makeSponsorOptions({
        deps: {
          verifyGasOwner: vi.fn(() => ({ owner: SPONSOR, budget: RESERVED_GAS + 1n })),
          releaseLedgerReservationWithLog:
            releaseLedgerReservationWithLog as unknown as StudioExecutionPolicyDependencies['releaseLedgerReservationWithLog'],
        },
      }),
    );
    seedSponsorState(state);

    await expect(policy.hooks.SharedPostconsumeChecks(makePostCtx())).rejects.toMatchObject({
      code: 'REPREPARE_REQUIRED',
    });
    expect(releaseLedgerReservationWithLog).toHaveBeenCalledWith(
      expect.anything(),
      RECEIPT_ID,
      'gas_budget_parity_mismatch',
    );
    expect(state.sponsor?.sponsorResultOutcome).toBe('validation_failure');
  });

  test('Preflight releases ledger and records studio-user abuse', async () => {
    const releaseLedgerReservationWithLog = vi.fn();
    const recordSponsorFailureForAbuse = vi.fn();
    const { policy, state } = createStudioExecutionPolicy(
      makeSponsorOptions({
        deps: {
          runPreflight: vi.fn(async () => ({
            success: false as const,
            error: MOVE_FAILURE,
          })),
          releaseLedgerReservationWithLog:
            releaseLedgerReservationWithLog as unknown as StudioExecutionPolicyDependencies['releaseLedgerReservationWithLog'],
          recordSponsorFailureForAbuse:
            recordSponsorFailureForAbuse as unknown as StudioExecutionPolicyDependencies['recordSponsorFailureForAbuse'],
        },
      }),
    );
    seedSponsorState(state);

    await expect(policy.hooks.Preflight(makePostCtx())).rejects.toMatchObject({
      code: 'PREFLIGHT_FAILED',
    });
    expect(releaseLedgerReservationWithLog).toHaveBeenCalledWith(
      expect.anything(),
      RECEIPT_ID,
      'preflight_simulation_failed',
    );
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

describe('studio sponsor ClassifySponsorResult, sign port, and Release', () => {
  test('ClassifySponsorResult consumes actual gas on success, projects result, and Release invokes callback', async () => {
    const onSponsorResult = vi.fn();
    const usageRows: CreateUsageEventInput[] = [];
    const consume = vi.fn(async () => ({ ok: true, entitlement: makeEntitlement() }));
    const { policy, state } = createStudioExecutionPolicy(
      makeSponsorOptions({
        ctx: makeContext(
          {
            executionLedger: {
              ...makeContext().executionLedger,
              consume,
            } as unknown as PromotionExecutionLedger,
            onSponsorResult,
          },
          usageRows,
        ),
      }),
    );
    seedSponsorState(state);
    const success: Extract<ExecResult, { success: true }> = {
      success: true,
      executionStage: 'on_chain',
      digest: TEST_SUI_TRANSACTION_DIGEST,
      effects: { status: 'ok' },
      gasUsed: GAS_USED,
    };

    await policy.hooks.ClassifySponsorResult(makePostCtx(), success);
    await policy.hooks.Release(makePostCtx());
    const projected = projectStudioSponsorResult(makeSponsorOptions(), state);

    expect(consume).toHaveBeenCalledWith(RECEIPT_ID, 1300n);
    expect(usageRows[0]).toMatchObject({
      result: 'consumed',
      consumedGasMist: '1300',
      releasedGasMist: (RESERVED_GAS - 1300n).toString(),
    });
    expect(projected).toEqual({
      digest: TEST_SUI_TRANSACTION_DIGEST,
      effects: { status: 'ok' },
      actualGasMist: '1300',
    });
    expect(onSponsorResult).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'success',
        executionStage: 'on_chain',
        route: 'promotion',
        digest: TEST_SUI_TRANSACTION_DIGEST,
        promotionId: PROMOTION_ID,
        userId: USER_ID,
        economics: expect.objectContaining({ economicsStatus: 'known' }),
      }),
    );
    expect(state.sponsor?.sponsorResultEconomics).toMatchObject({
      economicsStatus: 'known',
      recoveredGasMist: '0',
      hostPaidGasMist: '1300',
      hostFeeMist: '0',
      hostNetMist: '-1300',
    });
  });

  test('Release callback failure preserves existing sponsor_handler source', async () => {
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const onSponsorResult = vi.fn(async () => {
        throw new Error('callback exploded');
      });
      const { policy, state } = createStudioExecutionPolicy(
        makeSponsorOptions({
          onSponsorResult,
        }),
      );
      seedSponsorState(state);
      const success: Extract<ExecResult, { success: true }> = {
        success: true,
        executionStage: 'on_chain',
        digest: TEST_SUI_TRANSACTION_DIGEST,
        effects: { status: 'ok' },
        gasUsed: GAS_USED,
      };

      await policy.hooks.ClassifySponsorResult(makePostCtx(), success);
      await policy.hooks.Release(makePostCtx());

      const callbackFailedLog = consoleWarnSpy.mock.calls
        .map((args: unknown[]) => JSON.parse(args[0] as string) as Record<string, unknown>)
        .find((entry) => entry['event'] === 'SPONSOR_RESULT_CALLBACK_FAILED');
      expect(callbackFailedLog).toMatchObject({
        source: 'sponsor_handler',
        route: 'promotion',
        digest: TEST_SUI_TRANSACTION_DIGEST,
        outcome: 'success',
      });
    } finally {
      consoleWarnSpy.mockRestore();
    }
  });

  test('ClassifySponsorResult consumes actual gas and records studio-user abuse on on-chain revert', async () => {
    const consumeLedgerReservationWithLog = vi.fn(async () => ({ ok: true }));
    const recordSponsorFailureForAbuse = vi.fn();
    const usageRows: CreateUsageEventInput[] = [];
    const { policy, state } = createStudioExecutionPolicy(
      makeSponsorOptions({
        ctx: makeContext({}, usageRows),
        deps: {
          consumeLedgerReservationWithLog:
            consumeLedgerReservationWithLog as unknown as StudioExecutionPolicyDependencies['consumeLedgerReservationWithLog'],
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

    await expect(policy.hooks.ClassifySponsorResult(makePostCtx(), failed)).rejects.toMatchObject({
      code: 'ONCHAIN_REVERT',
    });
    expect(consumeLedgerReservationWithLog).toHaveBeenCalledWith(
      expect.anything(),
      RECEIPT_ID,
      1300n,
      'onchain_revert',
      expect.objectContaining({ txDigest: TEST_SUI_TRANSACTION_DIGEST }),
    );
    expect(usageRows[0]).toMatchObject({
      result: 'failed',
      consumedGasMist: '1300',
      releasedGasMist: (RESERVED_GAS - 1300n).toString(),
      failureReason: 'onchain_revert',
    });
    expect(recordSponsorFailureForAbuse).toHaveBeenCalledWith(
      expect.anything(),
      '127.0.0.1',
      { kind: 'studio_user', userId: USER_ID },
      'ONCHAIN_REVERT',
      expect.objectContaining({ executionPathKey: `promotion:${PROMOTION_ID}` }),
    );
    expect(state.sponsor?.sponsorResultOutcome).toBe('onchain_revert');
  });

  test('ClassifySponsorResult releases ledger on congestion and preserves classified congestion error', async () => {
    const releaseLedgerReservationWithLog = vi.fn();
    const { policy, state } = createStudioExecutionPolicy(
      makeSponsorOptions({
        deps: {
          releaseLedgerReservationWithLog:
            releaseLedgerReservationWithLog as unknown as StudioExecutionPolicyDependencies['releaseLedgerReservationWithLog'],
        },
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

    await expect(policy.hooks.ClassifySponsorResult(makePostCtx(), failed)).rejects.toMatchObject({
      code: 'SPONSOR_CONGESTION',
    });
    expect(releaseLedgerReservationWithLog).toHaveBeenCalledWith(
      expect.anything(),
      RECEIPT_ID,
      'congestion',
    );
    expect(state.sponsor?.sponsorResultOutcome).toBe('congestion');
  });

  test('ClassifySponsorResult maps post-success ledger consume failure to CONSUME_FAILED known loss', async () => {
    const consume = vi.fn(async () => ({ ok: false, reason: 'reservation_not_found' as const }));
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { policy, state } = createStudioExecutionPolicy(
      makeSponsorOptions({
        ctx: makeContext({
          executionLedger: {
            ...makeContext().executionLedger,
            consume,
          } as unknown as PromotionExecutionLedger,
        }),
      }),
    );
    seedSponsorState(state);
    const success: Extract<ExecResult, { success: true }> = {
      success: true,
      executionStage: 'on_chain',
      digest: TEST_SUI_TRANSACTION_DIGEST,
      effects: { status: 'ok' },
      gasUsed: GAS_USED,
    };

    await expect(policy.hooks.ClassifySponsorResult(makePostCtx(), success)).rejects.toMatchObject({
      code: 'CONSUME_FAILED',
    });
    expect(consume).toHaveBeenCalledWith(RECEIPT_ID, 1300n);
    expect(state.sponsor?.sponsorResultOutcome).toBe('success');
    expect(state.sponsor?.sponsorResultEconomics).toMatchObject({
      economicsStatus: 'known',
      recoveredGasMist: '0',
      hostPaidGasMist: '1300',
      hostNetMist: '-1300',
      failureReason: 'PROMOTION_LEDGER_CONSUME_FAILED: reservation_not_found',
    });
    const events = consoleErrorSpy.mock.calls.flatMap((args: unknown[]) => {
      try {
        return [JSON.parse(args[0] as string) as Record<string, unknown>];
      } catch {
        return [];
      }
    });
    expect(
      events.filter((entry) => entry.event === 'LEDGER_CONSUME_FAILED_IN_HANDLER'),
    ).toHaveLength(1);
    expect(events.some((entry) => entry.event === 'PROMOTION_LEDGER_CONSUME_FAILED')).toBe(false);
    consoleErrorSpy.mockRestore();
  });

  test('post-success ledger consume throw keeps known gas loss and maps to CONSUME_FAILED', async () => {
    const consume = vi.fn(async () => {
      throw new Error('redis transport down');
    });
    const { policy, state } = createStudioExecutionPolicy(
      makeSponsorOptions({
        ctx: makeContext({
          executionLedger: {
            ...makeContext().executionLedger,
            consume,
          } as unknown as PromotionExecutionLedger,
        }),
      }),
    );
    seedSponsorState(state);
    const success: Extract<ExecResult, { success: true }> = {
      success: true,
      executionStage: 'on_chain',
      digest: TEST_SUI_TRANSACTION_DIGEST,
      effects: { status: 'ok' },
      gasUsed: GAS_USED,
    };
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(policy.hooks.ClassifySponsorResult(makePostCtx(), success)).rejects.toMatchObject({
      code: 'CONSUME_FAILED',
    });
    expect(state.sponsor?.sponsorResultEconomics).toMatchObject({
      economicsStatus: 'known',
      recoveredGasMist: '0',
      hostPaidGasMist: '1300',
      hostNetMist: '-1300',
      failureReason: 'PROMOTION_LEDGER_CONSUME_THREW: redis transport down',
    });

    const events = consoleErrorSpy.mock.calls.flatMap((args: unknown[]) => {
      try {
        return [JSON.parse(args[0] as string) as Record<string, unknown>];
      } catch {
        return [];
      }
    });
    expect(
      events.filter((entry) => entry.event === 'LEDGER_CONSUME_THREW_IN_HANDLER'),
    ).toHaveLength(1);
    expect(events.some((entry) => entry.event === 'PROMOTION_LEDGER_CONSUME_FAILED')).toBe(false);

    consoleErrorSpy.mockRestore();
  });

  test('signAndSubmit port handles post-signature cleanup and preserves typed stage for runner', async () => {
    const consumeLedgerReservationWithLog = vi.fn(async () => ({ ok: true }));
    const usageRows: CreateUsageEventInput[] = [];
    const rawCause = new Error('rpc transport error');
    const expectedDigest = 'expected-sui-transaction-digest';
    const options = makeSponsorOptions({
      ctx: makeContext({}, usageRows),
      deps: {
        signAndSubmit: vi.fn(async () => {
          throw new SponsorPostSignatureUncertaintyError(expectedDigest, rawCause);
        }) as unknown as StudioExecutionPolicyDependencies['signAndSubmit'],
        consumeLedgerReservationWithLog:
          consumeLedgerReservationWithLog as unknown as StudioExecutionPolicyDependencies['consumeLedgerReservationWithLog'],
      },
    });
    const { state } = createStudioExecutionPolicy(options);
    seedSponsorState(state);
    const port = createStudioSignAndSubmitPort(options, state);

    const thrown = await port(SPONSOR, RECEIPT_ID, new Uint8Array([1, 2, 3]), 'sig').catch(
      (err: unknown) => err,
    );
    expect(thrown).toBeInstanceOf(SponsorPostSignatureUncertaintyError);
    expect((thrown as SponsorPostSignatureUncertaintyError).cause).toBe(rawCause);
    expect((thrown as SponsorPostSignatureUncertaintyError).expectedDigest).toBe(expectedDigest);

    expect(consumeLedgerReservationWithLog).toHaveBeenCalledWith(
      expect.anything(),
      RECEIPT_ID,
      RESERVED_GAS,
      'post_signature_uncertainty',
      expect.objectContaining({ txDigest: expectedDigest }),
    );
    expect(usageRows[0]).toMatchObject({
      result: 'failed',
      txDigest: expectedDigest,
      failureReason: 'post_signature_uncertainty',
      consumedGasMist: RESERVED_GAS.toString(),
    });
    expect(state.sponsor?.sponsorResultOutcome).toBe('internal_error');
    expect(state.sponsor?.sponsorResultDigest).toBe(expectedDigest);
    expect(state.sponsor?.sponsorResultEconomics).toMatchObject({
      economicsStatus: 'unknown',
      failureReason: expect.stringContaining('post_signature_uncertainty'),
    });
  });

  test('signAndSubmit port releases ledger on pre-sign lease failures', async () => {
    const releaseLedgerReservationWithLog = vi.fn();
    const leaseErr = new Error('lease expired');
    const options = makeSponsorOptions({
      deps: {
        signAndSubmit: vi.fn(async () => {
          throw leaseErr;
        }) as unknown as StudioExecutionPolicyDependencies['signAndSubmit'],
        releaseLedgerReservationWithLog:
          releaseLedgerReservationWithLog as unknown as StudioExecutionPolicyDependencies['releaseLedgerReservationWithLog'],
      },
    });
    const { state } = createStudioExecutionPolicy(options);
    seedSponsorState(state);
    const port = createStudioSignAndSubmitPort(options, state);

    await expect(port(SPONSOR, RECEIPT_ID, new Uint8Array([1, 2, 3]), 'sig')).rejects.toBe(
      leaseErr,
    );

    expect(releaseLedgerReservationWithLog).toHaveBeenCalledWith(
      expect.anything(),
      RECEIPT_ID,
      'sign_lease_expired',
    );
    expect(state.sponsor?.sponsorResultOutcome).toBe('validation_failure');
  });
});
