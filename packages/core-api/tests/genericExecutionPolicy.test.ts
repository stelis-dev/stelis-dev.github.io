/**
 * genericExecutionPolicy.test.ts - generic SponsoredExecution SponsoredExecutionPolicy
 * implementation.
 *
 * These tests exercise the hook bodies directly and verify that the
 * policy preserves the generic sponsor contracts through injected ports.
 */
import { describe, test, expect, vi } from 'vitest';
import { Transaction } from '@mysten/sui/transactions';
import { toBase58 } from '@mysten/sui/utils';
import {
  createGenericExecutionPolicy,
  createGenericSponsorReceiptPolicy,
  projectGenericSponsorResult,
  type GenericExecutionPolicyDependencies,
  type GenericExecutionPolicyOptions,
  type GenericExecutionPolicyState,
  type GenericSponsorErrorFactory,
  type RevalidateGenericResult,
} from '../src/session/sponsoredExecution/genericExecutionPolicy.js';
import {
  runPrepareStateMachine,
  type PrepareStateMachineHost,
} from '../src/session/sponsoredExecution/runner.js';
import type {
  SponsorSubmissionContext,
  SponsorValidatedContext,
} from '../src/session/sponsoredExecution/executionPolicy.js';
import { reconstructReservationHandles } from '../src/session/sponsoredExecution/reservationHandles.js';
import { SenderSignatureError } from '../src/session/sessionPrimitives.js';
import { PrepareValidationError } from '../src/prepare/replay.js';
import { getFailurePolicy } from '../src/failures.js';
import { SETTLE_MODULE, SETTLE_WITH_CREDIT_FUNCTION, type PtbCommand } from '@stelis/contracts';
import type {
  GenericPreparedTxEntry,
  PromotionPreparedTxEntry,
} from '../src/store/prepareTypes.js';
import type { HostContext } from '../src/context.js';
import type { ExecResult } from '../src/session/sessionTypes.js';
import type { SuiExecutionError } from '@stelis/core-relay';
import { TEST_SUI_TRANSACTION_DIGEST } from './helpers/suiGatewayResultFixtures.js';
import { admitTestClientIp } from './admittedClientIpTestHelpers.js';

const RECEIPT_ID = `0x${'ab'.repeat(32)}`;
const SENDER = `0x${'11'.repeat(32)}`;
const OTHER_SENDER = `0x${'33'.repeat(32)}`;
const SPONSOR = `0x${'22'.repeat(32)}`;
const SETTLEMENT_TOKEN_TYPE = `0x${'88'.repeat(32)}::deep::DEEP`;
const STELIS_PACKAGE_ID = `0x${'66'.repeat(32)}`;
const TX_BYTES = new Uint8Array([1, 2, 3, 4]);
const TEST_ABUSE_BLOCKER = {
  checkIp: vi.fn().mockResolvedValue({ blocked: false }),
  checkSubject: vi.fn().mockResolvedValue({ blocked: false }),
  recordSponsorFailure: vi.fn().mockResolvedValue(undefined),
};
const ADMITTED_CLIENT_IP = await admitTestClientIp(TEST_ABUSE_BLOCKER);
const GAS_USED = {
  computationCost: '1000',
  storageCost: '200',
  storageRebate: '100',
  nonRefundableStorageFee: '0',
};
const MOVE_FAILURE: SuiExecutionError = {
  kind: 'MovePrimitiveRuntimeError',
};

class TestSponsorError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly subcode?: string,
    readonly digest?: string,
    readonly gasUsed?: unknown,
  ) {
    super(message);
    this.name = 'TestSponsorError';
  }
}

const errors: GenericSponsorErrorFactory = {
  sponsorValidation: (code, message) => new TestSponsorError(code, message),
  sponsorBlocked: (retryAfterMs) =>
    new TestSponsorError('BLOCKED', `blocked:${retryAfterMs ?? 'none'}`),
  sponsorPreflight: (reason, subcode) =>
    new TestSponsorError('SPONSOR_PREFLIGHT_FAILED', reason, subcode),
  sponsorOnchain: (digest, reason, subcode, gasUsed) =>
    new TestSponsorError('SPONSOR_ONCHAIN_FAILED', reason, subcode, digest, gasUsed),
  sponsorCongestion: (message, digest) =>
    new TestSponsorError('SPONSOR_CONGESTION', message, undefined, digest),
};

function makePrepared(overrides: Partial<GenericPreparedTxEntry> = {}): GenericPreparedTxEntry {
  return {
    mode: 'generic',
    issuedAt: 1,
    receiptId: RECEIPT_ID,
    senderAddress: SENDER,
    clientIp: '127.0.0.1',
    txBytesHash: 'a'.repeat(64),
    sponsorAddress: SPONSOR,
    executionPathKey: 'credit',
    orderId: 'order-1',
    nonce: 7n,
    ...overrides,
  };
}

function makePromotionEntry(): PromotionPreparedTxEntry {
  return {
    mode: 'promotion',
    issuedAt: 1,
    receiptId: RECEIPT_ID,
    senderAddress: SENDER,
    clientIp: '127.0.0.1',
    txBytesHash: 'a'.repeat(64),
    sponsorAddress: SPONSOR,
    executionPathKey: 'promotion:p1',
    orderId: null,
    promotionId: 'promo-1',
    userId: 'user-1',
    reservedGasMist: 1_000n,
  };
}

function makeContext(overrides: Partial<HostContext> = {}): HostContext {
  return {
    network: 'testnet',
    settlementPayoutRecipientAddress: `0x${'33'.repeat(32)}`,
    configId: `0x${'44'.repeat(32)}`,
    vaultRegistryId: `0x${'55'.repeat(32)}`,
    packageId: STELIS_PACKAGE_ID,
    deepbookPackageId: `0x${'77'.repeat(32)}`,
    vaultsTableId: undefined,
    sui: {} as HostContext['sui'],
    sponsoredExecutionStore: {
      readPreparedReceipt: vi.fn(),
      checkUserQuota: vi.fn(async () => 'ok' as const),
    } as unknown as HostContext['sponsoredExecutionStore'],
    sponsorPool: {
      checkin: vi.fn(),
    } as unknown as HostContext['sponsorPool'],
    abuseBlocker: TEST_ABUSE_BLOCKER,
    getConfig: vi.fn(),
    invalidateConfigCache: vi.fn(),
    onSponsorResult: undefined,
    ...overrides,
  } as HostContext;
}

function creditSettlementCommands(): readonly PtbCommand[] {
  return [
    {
      kind: 'MoveCall',
      packageId: STELIS_PACKAGE_ID,
      module: SETTLE_MODULE,
      function: SETTLE_WITH_CREDIT_FUNCTION,
      typeArguments: [],
      arguments: [],
    },
  ];
}

function makeSponsorOptions(
  input: {
    ctx?: HostContext;
    deps?: Partial<GenericExecutionPolicyDependencies>;
    onSponsorResult?: HostContext['onSponsorResult'];
  } = {},
): GenericExecutionPolicyOptions {
  const ctx = input.ctx ?? makeContext({ onSponsorResult: input.onSponsorResult });
  return {
    hostContext: ctx,
    sponsor: {
      admittedClientIp: ADMITTED_CLIENT_IP,
      txBytes: TX_BYTES,
      userSignature: 'mock-user-signature',
      errors,
    },
    deps: input.deps,
  };
}

function makePrepareOptions(
  input: {
    ctx?: HostContext;
    deps?: Partial<GenericExecutionPolicyDependencies>;
  } = {},
): GenericExecutionPolicyOptions {
  const ctx = input.ctx ?? makeContext();
  return {
    hostContext: ctx,
    prepare: {
      params: {
        txKindBytes: 'mock-tx-kind-bytes',
        senderAddress: SENDER,
        settlementTokenType: SETTLEMENT_TOKEN_TYPE,
        clientIp: '127.0.0.1',
      },
      config: {
        deepbookPackageId: `0x${'77'.repeat(32)}`,
        supportedSettlementSwapPaths: [],
        settlementSwapPathDescriptors: new Map(),
        allowedSettlementSwapPaths: [],
        quotedHostFeeMist: 0n,
      },
    },
    deps: input.deps,
  };
}

function makeRevalidation(nonce: bigint): RevalidateGenericResult {
  return {
    builtTx: {} as Transaction,
    commands: creditSettlementCommands(),
    freshConfig: {
      packageId: STELIS_PACKAGE_ID,
      configId: `0x${'44'.repeat(32)}`,
      maxClaimMist: 50_000_000n,
      minSettleMist: 1_000n,
      maxHostFeeMist: 100_000n,
      protocolFlatFeeMist: 10n,
      configVersion: 1n,
      maxSpreadBps: 500n,
    },
    settleArgs: {
      configObjectId: `0x${'44'.repeat(32)}`,
      registryObjectId: `0x${'55'.repeat(32)}`,
      settlementPayoutRecipient: `0x${'33'.repeat(32)}`,
      executionCostClaim: 5_000n,
      policyHash: new Uint8Array(32),
      quotedHostFeeMist: 100n,
      expectedProtocolFeeMist: 10n,
      expectedConfigVersion: 1n,
      orderIdHash: new Uint8Array(32).fill(1),
      nonce,
      receiptId: new Uint8Array(32),
      simGasReported: 1_000n,
      gasVarianceFixedMist: 100n,
      slippageBufferMist: 0n,
      quoteTimestampMs: 1n,
    },
    isNewUserSettle: false,
  };
}

function makeUnreachedPrepareHost() {
  return {
    inflightLimiter: {
      inflight: 0,
      capacity: 1,
      tryAcquire: vi.fn().mockResolvedValue({ release: vi.fn().mockResolvedValue(undefined) }),
    },
    sponsorPool: {
      size: 1,
      primaryAddress: SPONSOR,
      checkout: vi.fn(),
      checkin: vi.fn(),
      leaseStatus: vi.fn().mockResolvedValue({
        leasedSlots: 0,
        freeSlots: 1,
        slots: [{ address: SPONSOR, leased: false }],
      }),
      addresses: vi.fn().mockReturnValue([SPONSOR]),
      sign: vi.fn().mockResolvedValue({ signature: 'unused' }),
    },
    sponsoredExecutionStore: {
      commitPreparedReceipt: vi.fn(),
      readPreparedReceipt: vi.fn(),
      discardPreparedReceipt: vi.fn(),
      beginSponsoredExecution: vi.fn(),
      finalizeSponsoredExecution: vi.fn(),
      readExpiredPreparedReceipts: vi.fn(),
      readDueExecutions: vi.fn(),
      readPendingCallbacks: vi.fn(),
      markCallbackDelivered: vi.fn(),
      checkUserQuota: vi.fn().mockResolvedValue('ok' as const),
      reserveNonce: vi.fn(),
      releaseNonceReservation: vi.fn(),
      dispose: vi.fn(),
    },
  } satisfies PrepareStateMachineHost;
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
  };
}

function makePrepareHookCtx() {
  return {
    receiptId: RECEIPT_ID,
    senderAddress: SENDER,
    clientIp: '127.0.0.1',
  };
}

function makeUnaccountableWithdrawalTx(): Transaction {
  return {
    getData: () => ({
      inputs: [
        {
          $kind: 'FundsWithdrawal',
          FundsWithdrawal: {
            reservation: { $kind: 'UnknownShape', UnknownShape: '5000000' },
            typeArg: { $kind: 'Balance', Balance: SETTLEMENT_TOKEN_TYPE },
            withdrawFrom: { $kind: 'Sender' },
          },
        },
      ],
      commands: [],
    }),
  } as unknown as Transaction;
}

function makeSubmissionCtx(): SponsorSubmissionContext {
  return {
    receiptId: RECEIPT_ID,
    clientIp: '127.0.0.1',
  };
}

async function buildTxBytesWithSender(sender: string): Promise<Uint8Array> {
  const tx = new Transaction();
  tx.setSender(sender);
  tx.setGasOwner(SPONSOR);
  tx.setGasBudget(5_000);
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

function seedSponsorState(
  state: GenericExecutionPolicyState,
  overrides: Partial<NonNullable<GenericExecutionPolicyState['sponsor']>> = {},
): void {
  state.sponsor = {
    builtTxForValidation: {} as Transaction,
    txSender: SENDER,
    prepared: makePrepared(),
    revalidation: makeRevalidation(7n),
    gasBudget: 10_000n,
    sponsorResultOutcome: 'internal_error',
    sponsorResultOrderIdHash: null,
    sponsorResultEconomics: {
      economicsStatus: 'unknown',
      failureReason: null,
    },
    ...overrides,
  };
}

describe('createGenericExecutionPolicy', () => {
  test('declares generic discriminator and generic handle requirements', () => {
    const { policy } = createGenericExecutionPolicy(makeSponsorOptions());

    expect(policy.discriminator).toBe('generic');
    expect(policy.handleRequirements.gasBoundBuild).toEqual({
      nonce: true,
    });
    expect(policy.handleRequirements.preparedCommit).toEqual({});
    expect(policy.handleRequirements.sponsorResult).toEqual({});
  });

  test('generic prepare rejects unaccountable withdrawal in RequestValidation before resource acquisition', async () => {
    const deserializeUserTxKind = vi.fn().mockResolvedValue(makeUnaccountableWithdrawalTx());
    const recordSponsorFailure = vi.fn().mockResolvedValue(undefined);
    const ctx = makeContext({
      abuseBlocker: {
        recordSponsorFailure,
      } as unknown as HostContext['abuseBlocker'],
    });
    const { policy } = createGenericExecutionPolicy(
      makePrepareOptions({
        ctx,
        deps: {
          deserializeUserTxKind:
            deserializeUserTxKind as GenericExecutionPolicyDependencies['deserializeUserTxKind'],
        },
      }),
    );
    const host = makeUnreachedPrepareHost();
    const preparedDraftFields = vi.fn();
    const projectResponse = vi.fn();
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    try {
      const err = await runPrepareStateMachine(
        host,
        {
          senderAddress: makePrepareHookCtx().senderAddress,
          clientIp: makePrepareHookCtx().clientIp,
          assertSponsorAvailable: vi.fn(async () => undefined),
          preparedDraftFields,
          projectResponse,
        },
        policy,
      ).catch((caught: unknown) => caught);

      expect(err).toBeInstanceOf(PrepareValidationError);
      expect((err as PrepareValidationError).code).toBe('UNACCOUNTABLE_WITHDRAWAL');
      expect(getFailurePolicy('UNACCOUNTABLE_WITHDRAWAL')).toMatchObject({
        classification: 'manipulation',
        abuseImpact: { ip: 'skip', subject: 'skip' },
      });
      expect(deserializeUserTxKind).toHaveBeenCalledTimes(1);
      expect(host.inflightLimiter.tryAcquire).not.toHaveBeenCalled();
      expect(host.sponsorPool.checkout).not.toHaveBeenCalled();
      expect(host.sponsoredExecutionStore.reserveNonce).not.toHaveBeenCalled();
      expect(host.sponsoredExecutionStore.commitPreparedReceipt).not.toHaveBeenCalled();
      expect(preparedDraftFields).not.toHaveBeenCalled();
      expect(projectResponse).not.toHaveBeenCalled();
      expect(recordSponsorFailure).not.toHaveBeenCalled();

      const buildEvents = infoSpy.mock.calls
        .map((args) => {
          try {
            return JSON.parse(String(args[0])) as Record<string, unknown>;
          } catch {
            return null;
          }
        })
        .filter((entry) => entry?.event === 'PREPARE_BUILD_STAGE');
      expect(buildEvents).toHaveLength(0);
    } finally {
      infoSpy.mockRestore();
    }
  });

  test('generic prepare rejects 12 user commands before resource acquisition', async () => {
    const userTx = new Transaction();
    for (let index = 0; index < 12; index++) {
      userTx.moveCall({ target: `0x${'99'.repeat(32)}::example::act` });
    }
    const deserializeUserTxKind = vi.fn().mockResolvedValue(userTx);
    const { policy } = createGenericExecutionPolicy(
      makePrepareOptions({
        deps: {
          deserializeUserTxKind:
            deserializeUserTxKind as GenericExecutionPolicyDependencies['deserializeUserTxKind'],
        },
      }),
    );
    const host = makeUnreachedPrepareHost();

    const err = await runPrepareStateMachine(
      host,
      {
        senderAddress: makePrepareHookCtx().senderAddress,
        clientIp: makePrepareHookCtx().clientIp,
        assertSponsorAvailable: vi.fn(async () => undefined),
        preparedDraftFields: vi.fn(),
        projectResponse: vi.fn(),
      },
      policy,
    ).catch((caught: unknown) => caught);

    expect(err).toBeInstanceOf(PrepareValidationError);
    expect(err).toMatchObject({
      code: 'P1_TOO_MANY_COMMANDS',
      message: 'P1 validation failed: User TransactionKind command count 12 exceeds max 11',
    });
    expect(deserializeUserTxKind).toHaveBeenCalledTimes(1);
    expect(host.inflightLimiter.tryAcquire).not.toHaveBeenCalled();
    expect(host.sponsorPool.checkout).not.toHaveBeenCalled();
    expect(host.sponsoredExecutionStore.reserveNonce).not.toHaveBeenCalled();
    expect(host.sponsoredExecutionStore.commitPreparedReceipt).not.toHaveBeenCalled();
  });

  test('does not widen the package main barrel', async () => {
    const mainBarrel = await import('../src/index.js');
    expect(Object.prototype.hasOwnProperty.call(mainBarrel, 'createGenericExecutionPolicy')).toBe(
      false,
    );
    expect(
      Object.prototype.hasOwnProperty.call(mainBarrel, 'createGenericSponsorReceiptPolicy'),
    ).toBe(false);
  });
});

describe('createGenericSponsorReceiptPolicy', () => {
  test('supplies the current generic prepared entry to policy hooks', async () => {
    const state: GenericExecutionPolicyState = {
      sponsor: {
        sponsorResultOutcome: 'internal_error',
        sponsorResultOrderIdHash: null,
        sponsorResultEconomics: { economicsStatus: 'unknown', failureReason: null },
      },
    };
    const prepared = makePrepared();
    const adapter = createGenericSponsorReceiptPolicy({
      hostContext: makeContext(),
      clientIp: '127.0.0.1',
      state,
      errors,
    });

    await adapter.validatePreparedEntry(prepared);

    expect(state.sponsor?.prepared).toBe(prepared);
  });

  test('rejects promotion entries without mutating lifecycle state', async () => {
    const checkin = vi.fn();
    const adapter = createGenericSponsorReceiptPolicy({
      hostContext: makeContext({
        sponsorPool: { checkin } as unknown as HostContext['sponsorPool'],
      }),
      clientIp: '127.0.0.1',
      state: {
        sponsor: {
          sponsorResultOutcome: 'internal_error',
          sponsorResultOrderIdHash: null,
          sponsorResultEconomics: { economicsStatus: 'unknown', failureReason: null },
        },
      },
      errors,
    });

    let error: unknown;
    try {
      await adapter.validatePreparedEntry(makePromotionEntry());
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: 'MODE_MISMATCH' });
    expect(checkin).not.toHaveBeenCalled();
  });

  test('hash mismatch records IP-only tampering before returning the classified error', async () => {
    const recordSponsorFailureForAbuse = vi.fn();
    const adapter = createGenericSponsorReceiptPolicy({
      hostContext: makeContext(),
      clientIp: '203.0.113.10',
      state: {
        sponsor: {
          sponsorResultOutcome: 'internal_error',
          sponsorResultOrderIdHash: null,
          sponsorResultEconomics: { economicsStatus: 'unknown', failureReason: null },
        },
      },
      errors,
      deps: {
        recordSponsorFailureForAbuse:
          recordSponsorFailureForAbuse as unknown as typeof import('../src/abuseBlocking.js').recordSponsorFailureForAbuse,
      },
    });

    const err = await adapter.onHashMismatch(RECEIPT_ID);

    expect(err).toMatchObject({ code: 'TAMPERING_DETECTED' });
    expect(recordSponsorFailureForAbuse).toHaveBeenCalledWith(
      expect.anything(),
      '203.0.113.10',
      undefined,
      'TAMPERING_DETECTED',
    );
  });
});

describe('generic sponsor validation', () => {
  test('reuses the one decoded transaction for every generic sponsor validation', async () => {
    const txBytes = await buildTxBytesWithSender(SENDER);
    const revalidateGenericSponsorPolicy = vi.fn<
      GenericExecutionPolicyDependencies['revalidateGenericSponsorPolicy']
    >(async (_context, _prepared, builtTx) => ({
      ...makeRevalidation(7n),
      builtTx,
    }));
    const verifyGasOwner = vi.fn<GenericExecutionPolicyDependencies['verifyGasOwner']>(() => ({
      owner: SPONSOR,
      budget: 10_000n,
    }));
    const options = {
      ...makeSponsorOptions({
        deps: {
          verifySenderSignature: vi.fn(async () => undefined),
          checkBlockedSubject: vi.fn(async () => ({ blocked: false })),
          revalidateGenericSponsorPolicy,
          verifyGasOwner,
        },
      }),
      sponsor: {
        admittedClientIp: ADMITTED_CLIENT_IP,
        txBytes,
        userSignature: 'valid-user-signature',
        errors,
      },
    } satisfies GenericExecutionPolicyOptions;
    const { policy, state } = createGenericExecutionPolicy(options);
    const transactionFrom = vi.spyOn(Transaction, 'from');

    try {
      await policy.hooks.DecodeSponsorSubmission(makeSubmissionCtx());
      const decoded = state.sponsor?.builtTxForValidation;
      expect(decoded).toBeInstanceOf(Transaction);

      await policy.hooks.UserSignatureValidation(makeSubmissionCtx());
      await createGenericSponsorReceiptPolicy({
        hostContext: options.hostContext,
        clientIp: '127.0.0.1',
        state,
        errors,
        deps: options.deps,
      }).validatePreparedEntry(makePrepared());
      await policy.hooks.SharedSponsorChecks(makeValidatedCtx());

      expect(transactionFrom).toHaveBeenCalledTimes(1);
      expect(revalidateGenericSponsorPolicy.mock.calls[0]?.[2]).toBe(decoded);
      expect(verifyGasOwner.mock.calls[0]?.[0]).toBe(decoded);
    } finally {
      transactionFrom.mockRestore();
    }
  });

  test('records signature failure without requiring a prepared entry', async () => {
    const recordSponsorFailureForAbuse = vi.fn();
    const verifySenderSignature = vi.fn(async () => {
      throw new SenderSignatureError('bad signature');
    });
    const txBytes = await buildTxBytesWithSender(SENDER);
    const options = {
      ...makeSponsorOptions({
        deps: {
          verifySenderSignature:
            verifySenderSignature as unknown as GenericExecutionPolicyDependencies['verifySenderSignature'],
          recordSponsorFailureForAbuse:
            recordSponsorFailureForAbuse as unknown as typeof import('../src/abuseBlocking.js').recordSponsorFailureForAbuse,
        },
      }),
      sponsor: {
        admittedClientIp: ADMITTED_CLIENT_IP,
        txBytes,
        userSignature: 'bad-user-signature',
        errors,
      },
    } satisfies GenericExecutionPolicyOptions;
    const { policy } = createGenericExecutionPolicy(options);

    await policy.hooks.DecodeSponsorSubmission(makeSubmissionCtx());
    await expect(policy.hooks.UserSignatureValidation(makeSubmissionCtx())).rejects.toMatchObject({
      code: 'SENDER_SIGNATURE_INVALID',
    });
    expect(recordSponsorFailureForAbuse).toHaveBeenCalledWith(
      expect.anything(),
      '127.0.0.1',
      undefined,
      'SENDER_SIGNATURE_INVALID',
    );
  });

  test('admits the signed sender before comparing it with the prepared entry', async () => {
    const recordSponsorFailureForAbuse = vi.fn();
    const txBytes = await buildTxBytesWithSender(OTHER_SENDER);
    const options = {
      ...makeSponsorOptions({
        deps: {
          verifySenderSignature: vi.fn(async () => undefined),
          checkBlockedSubject: vi.fn(async () => ({ blocked: false })),
          recordSponsorFailureForAbuse:
            recordSponsorFailureForAbuse as unknown as typeof import('../src/abuseBlocking.js').recordSponsorFailureForAbuse,
        },
      }),
      sponsor: {
        admittedClientIp: ADMITTED_CLIENT_IP,
        txBytes,
        userSignature: 'valid-for-other-sender',
        errors,
      },
    } satisfies GenericExecutionPolicyOptions;
    const { policy, state } = createGenericExecutionPolicy(options);
    await createGenericSponsorReceiptPolicy({
      hostContext: options.hostContext,
      clientIp: '127.0.0.1',
      state,
      errors,
      deps: options.deps,
    }).validatePreparedEntry(makePrepared());

    await policy.hooks.DecodeSponsorSubmission(makeSubmissionCtx());
    await expect(
      policy.hooks.UserSignatureValidation(makeSubmissionCtx()),
    ).resolves.toBeUndefined();
    await expect(policy.hooks.SharedSponsorChecks(makeValidatedCtx())).rejects.toMatchObject({
      code: 'RECEIPT_SESSION_MISMATCH',
    });
    expect(recordSponsorFailureForAbuse).toHaveBeenCalledWith(
      expect.anything(),
      '127.0.0.1',
      { kind: 'address', address: OTHER_SENDER },
      'RECEIPT_SESSION_MISMATCH',
    );
  });
});

describe('generic sponsor read-only checks', () => {
  test('SharedSponsorChecks verifies nonce equality and returns reconstruction inputs', async () => {
    const recordSponsorFailureForAbuse = vi.fn();
    const { policy, state } = createGenericExecutionPolicy(
      makeSponsorOptions({
        deps: {
          checkBlockedSubject: vi.fn(async () => ({ blocked: false })),
          revalidateGenericSponsorPolicy: vi.fn(async () => makeRevalidation(7n)),
          verifyGasOwner: vi.fn(() => ({ owner: SPONSOR, budget: 10_000n })),
          recordSponsorFailureForAbuse:
            recordSponsorFailureForAbuse as unknown as typeof import('../src/abuseBlocking.js').recordSponsorFailureForAbuse,
        },
      }),
    );
    seedSponsorState(state, { revalidation: undefined });

    const out = await policy.hooks.SharedSponsorChecks(makeValidatedCtx());

    expect(out?.nonce).toEqual({
      nonce: 7n,
      senderAddress: SENDER,
      receiptId: RECEIPT_ID,
      inPtbNonceMatch: true,
    });
    expect(recordSponsorFailureForAbuse).not.toHaveBeenCalled();
  });

  test('SharedSponsorChecks maps S-14 nonce mismatch to REPREPARE_REQUIRED without abuse', async () => {
    const recordSponsorFailureForAbuse = vi.fn();
    const { policy, state } = createGenericExecutionPolicy(
      makeSponsorOptions({
        deps: {
          checkBlockedSubject: vi.fn(async () => ({ blocked: false })),
          revalidateGenericSponsorPolicy: vi.fn(async () => makeRevalidation(8n)),
          verifyGasOwner: vi.fn(() => ({ owner: SPONSOR, budget: 10_000n })),
          recordSponsorFailureForAbuse:
            recordSponsorFailureForAbuse as unknown as typeof import('../src/abuseBlocking.js').recordSponsorFailureForAbuse,
        },
      }),
    );
    seedSponsorState(state, { revalidation: undefined });

    await expect(policy.hooks.SharedSponsorChecks(makeValidatedCtx())).rejects.toMatchObject({
      code: 'REPREPARE_REQUIRED',
    });
    expect(recordSponsorFailureForAbuse).not.toHaveBeenCalled();
  });

  test('Preflight records address-level abuse and throws the route preflight error', async () => {
    const recordSponsorFailureForAbuse = vi.fn();
    const { policy, state } = createGenericExecutionPolicy(
      makeSponsorOptions({
        deps: {
          runPreflight: vi.fn(async () => ({
            success: false as const,
            error: MOVE_FAILURE,
          })),
          recordSponsorFailureForAbuse:
            recordSponsorFailureForAbuse as unknown as typeof import('../src/abuseBlocking.js').recordSponsorFailureForAbuse,
        },
      }),
    );
    seedSponsorState(state);

    await expect(policy.hooks.Preflight(makeValidatedCtx())).rejects.toMatchObject({
      code: 'SPONSOR_PREFLIGHT_FAILED',
    });
    expect(recordSponsorFailureForAbuse).toHaveBeenCalledWith(
      expect.anything(),
      '127.0.0.1',
      { kind: 'address', address: SENDER },
      'PREFLIGHT_FAILED',
      expect.objectContaining({ executionPathKey: 'credit' }),
    );
  });
});

describe('generic sponsor result classification', () => {
  test('ClassifySponsorResult classifies on-chain revert and records address-level abuse', async () => {
    const recordSponsorFailureForAbuse = vi.fn();
    const { policy, state } = createGenericExecutionPolicy(
      makeSponsorOptions({
        deps: {
          recordSponsorFailureForAbuse:
            recordSponsorFailureForAbuse as unknown as typeof import('../src/abuseBlocking.js').recordSponsorFailureForAbuse,
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
    ).rejects.toMatchObject({
      code: 'SPONSOR_ONCHAIN_FAILED',
      digest: TEST_SUI_TRANSACTION_DIGEST,
    });
    expect(recordSponsorFailureForAbuse).toHaveBeenCalledWith(
      expect.anything(),
      '127.0.0.1',
      { kind: 'address', address: SENDER },
      'ONCHAIN_REVERT',
      expect.objectContaining({ executionPathKey: 'credit' }),
    );
    expect(state.sponsor?.sponsorResultOutcome).toBe('onchain_revert');
  });

  test('success path records economics and projects the generic response without lifecycle mutation', async () => {
    const { policy, state } = createGenericExecutionPolicy(makeSponsorOptions());
    seedSponsorState(state);
    const success: Extract<ExecResult, { success: true }> = {
      success: true,
      executionStage: 'on_chain',
      digest: TEST_SUI_TRANSACTION_DIGEST,
      effects: { status: 'ok' },
      gasUsed: GAS_USED,
    };

    await policy.hooks.ClassifySponsorResult(makeValidatedCtx('on_chain'), success);
    const projected = projectGenericSponsorResult(makeSponsorOptions(), state);

    expect(projected).toEqual({
      digest: TEST_SUI_TRANSACTION_DIGEST,
      effects: { status: 'ok' },
      executionCostClaim: '5000',
      orderId: 'order-1',
    });
    expect(state.sponsor?.sponsorResultEconomics).toMatchObject({
      economicsStatus: 'known',
      recoveredGasMist: '5000',
      hostPaidGasMist: '1100',
    });
  });
});
