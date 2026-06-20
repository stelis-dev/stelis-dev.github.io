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
  createGenericSponsorConsumeAdapter,
  projectGenericSponsorResult,
  type GenericExecutionPolicyDependencies,
  type GenericExecutionPolicyOptions,
  type GenericExecutionPolicyState,
  type GenericSponsorErrorFactory,
} from '../src/session/sponsoredExecution/genericExecutionPolicy.js';
import { runPrepareStateMachine } from '../src/session/sponsoredExecution/runner.js';
import type {
  PostConsumeSponsorContext,
  PreConsumeSponsorContext,
} from '../src/session/sponsoredExecution/index.js';
import { reconstructReservationHandles } from '../src/session/sponsoredExecution/reservationHandles.js';
import { SenderSignatureError } from '../src/session/sessionPrimitives.js';
import { PrepareValidationError } from '../src/prepare/replay.js';
import { getFailurePolicy } from '../src/failures.js';
import type {
  GenericPreparedTxEntry,
  PromotionPreparedTxEntry,
} from '../src/store/prepareTypes.js';
import type { RelayerContext } from '../src/context.js';
import type { ExecResult } from '../src/session/sessionTypes.js';

const RECEIPT_ID = `0x${'ab'.repeat(32)}`;
const SENDER = `0x${'11'.repeat(32)}`;
const OTHER_SENDER = `0x${'33'.repeat(32)}`;
const SPONSOR = `0x${'22'.repeat(32)}`;
const SETTLEMENT_TOKEN_TYPE = `0x${'88'.repeat(32)}::deep::DEEP`;
const TX_BYTES = new Uint8Array([1, 2, 3, 4]);
const GAS_USED = {
  computationCost: '1000',
  storageCost: '200',
  storageRebate: '100',
  nonRefundableStorageFee: '0',
};

class TestSponsorError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusHint?: number,
    readonly subcode?: string,
    readonly digest?: string,
  ) {
    super(message);
    this.name = 'TestSponsorError';
  }
}

const errors: GenericSponsorErrorFactory = {
  sponsorValidation: (code, message, statusHint) => new TestSponsorError(code, message, statusHint),
  sponsorBlocked: (retryAfterMs) =>
    new TestSponsorError('BLOCKED', `blocked:${retryAfterMs ?? 'none'}`),
  sponsorPreflight: (reason, subcode) =>
    new TestSponsorError('SPONSOR_PREFLIGHT_FAILED', reason, undefined, subcode),
  sponsorOnchain: (digest, reason, subcode) =>
    new TestSponsorError('SPONSOR_ONCHAIN_FAILED', reason, undefined, subcode, digest),
  sponsorCongestion: (message) => new TestSponsorError('SPONSOR_CONGESTION', message),
};

function makePrepared(overrides: Partial<GenericPreparedTxEntry> = {}): GenericPreparedTxEntry {
  return {
    mode: 'generic',
    issuedAt: 1,
    receiptId: RECEIPT_ID,
    senderAddress: SENDER,
    clientIp: '127.0.0.1',
    txBytesHash: 'a'.repeat(64),
    slotId: 'slot-1',
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
    slotId: 'slot-1',
    sponsorAddress: SPONSOR,
    executionPathKey: 'promotion:p1',
    orderId: null,
    nonce: 0n,
    promotionId: 'promo-1',
    userId: 'user-1',
    reservedGasMist: 1_000n,
  };
}

function makeContext(overrides: Partial<RelayerContext> = {}): RelayerContext {
  return {
    network: 'testnet',
    settlementPayoutRecipientAddress: `0x${'33'.repeat(32)}`,
    configId: `0x${'44'.repeat(32)}`,
    vaultRegistryId: `0x${'55'.repeat(32)}`,
    packageId: `0x${'66'.repeat(32)}`,
    deepbookPackageId: `0x${'77'.repeat(32)}`,
    vaultsTableId: undefined,
    sui: {} as RelayerContext['sui'],
    prepareStore: {
      peek: vi.fn(),
      evictPreparedEntry: vi.fn(),
    } as unknown as RelayerContext['prepareStore'],
    sponsorPool: {
      checkin: vi.fn(),
    } as unknown as RelayerContext['sponsorPool'],
    abuseBlocker: {} as RelayerContext['abuseBlocker'],
    getConfig: vi.fn(),
    invalidateConfigCache: vi.fn(),
    onSponsorResult: undefined,
    ...overrides,
  } as RelayerContext;
}

function makeSponsorOptions(
  input: {
    ctx?: RelayerContext;
    deps?: Partial<GenericExecutionPolicyDependencies>;
    onSponsorResult?: RelayerContext['onSponsorResult'];
  } = {},
): GenericExecutionPolicyOptions {
  const ctx = input.ctx ?? makeContext({ onSponsorResult: input.onSponsorResult });
  return {
    relayerContext: ctx,
    sponsor: {
      txBytes: TX_BYTES,
      userSignature: 'mock-user-signature',
      errors,
    },
    deps: input.deps,
  };
}

function makePrepareOptions(
  input: {
    ctx?: RelayerContext;
    deps?: Partial<GenericExecutionPolicyDependencies>;
  } = {},
): GenericExecutionPolicyOptions {
  const ctx = input.ctx ?? makeContext();
  return {
    relayerContext: ctx,
    prepare: {
      params: {
        txKindBytes: 'mock-tx-kind-bytes',
        senderAddress: SENDER,
        settlementTokenType: SETTLEMENT_TOKEN_TYPE,
        clientIp: '127.0.0.1',
        txKindBytesHash: 'a'.repeat(64),
        prepareAuthorizationTimestampMs: 1,
        prepareAuthorizationRequestNonce: 'nonce',
        prepareAuthorizationSignature: 'signature',
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

function makePostCtx(): PostConsumeSponsorContext {
  return {
    receiptId: RECEIPT_ID,
    clientIp: '127.0.0.1',
    sponsorSlot: reconstructReservationHandles.sponsorSlot({
      slotId: 'slot-1',
      sponsorAddress: SPONSOR,
      receiptId: RECEIPT_ID,
      hmacCommitVerified: true,
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

function makePreCtx(): PreConsumeSponsorContext {
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
    txSender: SENDER,
    peeked: makePrepared(),
    prepared: makePrepared(),
    revalidation: {
      builtTx: {} as Transaction,
      freshConfig: {
        protocolFlatFeeMist: 10n,
      } as NonNullable<GenericExecutionPolicyState['sponsor']>['revalidation']['freshConfig'],
      settleArgs: {
        nonce: 7n,
        executionCostClaim: 5_000n,
        quotedHostFeeMist: 100n,
        orderIdHash: new Uint8Array(32).fill(1),
      } as NonNullable<GenericExecutionPolicyState['sponsor']>['revalidation']['settleArgs'],
      isNewUserSettle: false,
    },
    gasBudget: 10_000n,
    preflightGasUsed: GAS_USED,
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
      sponsorSlot: true,
      nonce: true,
    });
    expect(policy.handleRequirements.preparedCommit).toEqual({
      sponsorSlot: true,
      nonce: true,
    });
    expect(policy.handleRequirements.sponsorResult).toEqual({ sponsorSlot: true });
    expect(policy.hooks.RouteReservationAfterBuild).toBeDefined();
  });

  test('generic prepare rejects unaccountable withdrawal in RequestValidation before resource acquisition', async () => {
    const deserializeUserTxKind = vi.fn().mockResolvedValue(makeUnaccountableWithdrawalTx());
    const recordSponsorFailure = vi.fn().mockResolvedValue(undefined);
    const ctx = makeContext({
      abuseBlocker: {
        recordSponsorFailure,
      } as unknown as RelayerContext['abuseBlocker'],
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
    const host = {
      inflightLimiter: {
        tryAcquire: vi.fn().mockResolvedValue({ release: vi.fn().mockResolvedValue(undefined) }),
      },
      sponsorPool: {
        checkout: vi.fn(),
        commit: vi.fn(),
        checkin: vi.fn(),
      },
      prepareStore: {
        reserveNonce: vi.fn(),
        releaseReservation: vi.fn(),
        store: vi.fn(),
      },
    };
    const preparedCommitInputs = vi.fn();
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    try {
      const err = await runPrepareStateMachine(
        host,
        {
          hookContext: makePrepareHookCtx(),
          preparedCommitInputs,
        },
        policy,
      ).catch((caught: unknown) => caught);

      expect(err).toBeInstanceOf(PrepareValidationError);
      expect((err as PrepareValidationError).code).toBe('UNACCOUNTABLE_WITHDRAWAL');
      expect((err as PrepareValidationError).statusHint).toBeUndefined();
      expect(getFailurePolicy('UNACCOUNTABLE_WITHDRAWAL')).toMatchObject({
        classification: 'manipulation',
        httpStatus: 422,
        abuseImpact: { ip: 'skip', subject: 'skip' },
      });
      expect(deserializeUserTxKind).toHaveBeenCalledTimes(1);
      expect(host.inflightLimiter.tryAcquire).not.toHaveBeenCalled();
      expect(host.sponsorPool.checkout).not.toHaveBeenCalled();
      expect(host.prepareStore.reserveNonce).not.toHaveBeenCalled();
      expect(host.prepareStore.store).not.toHaveBeenCalled();
      expect(preparedCommitInputs).not.toHaveBeenCalled();
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

  test('does not widen the package main barrel', async () => {
    const mainBarrel = await import('@stelis/core-api');
    expect(Object.prototype.hasOwnProperty.call(mainBarrel, 'createGenericExecutionPolicy')).toBe(
      false,
    );
    expect(
      Object.prototype.hasOwnProperty.call(mainBarrel, 'createGenericSponsorConsumeAdapter'),
    ).toBe(false);
  });
});

describe('createGenericSponsorConsumeAdapter', () => {
  test('captures the consumed generic entry for postconsume hooks', async () => {
    const state: GenericExecutionPolicyState = {
      sponsor: {
        sponsorResultOutcome: 'internal_error',
        sponsorResultOrderIdHash: null,
        sponsorResultEconomics: { economicsStatus: 'unknown', failureReason: null },
      },
    };
    const prepared = makePrepared();
    const adapter = createGenericSponsorConsumeAdapter({
      relayerContext: makeContext(),
      clientIp: '127.0.0.1',
      state,
      errors,
    });

    await adapter.validateConsumedEntry?.(prepared);

    expect(state.sponsor?.prepared).toBe(prepared);
  });

  test('rejects promotion entries and checkins their committed slot', async () => {
    const checkin = vi.fn();
    const ctx = makeContext({
      sponsorPool: { checkin } as unknown as RelayerContext['sponsorPool'],
    });
    const adapter = createGenericSponsorConsumeAdapter({
      relayerContext: ctx,
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

    await expect(adapter.validateConsumedEntry?.(makePromotionEntry())).rejects.toMatchObject({
      code: 'MODE_MISMATCH',
    });
    expect(checkin).toHaveBeenCalledWith('slot-1', RECEIPT_ID, 'a'.repeat(64));
  });

  test('hash mismatch records IP-only tampering before returning the classified error', async () => {
    const recordSponsorFailureForAbuse = vi.fn();
    const adapter = createGenericSponsorConsumeAdapter({
      relayerContext: makeContext(),
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

describe('generic sponsor preconsume priority', () => {
  test('DecodeSponsorSubmission stores promotion-mode peek without MODE_MISMATCH', async () => {
    const promotionEntry = makePromotionEntry();
    const peek = vi.fn(async () => promotionEntry);
    const txBytes = await buildTxBytesWithSender(SENDER);
    const options = makeSponsorOptions({
      ctx: makeContext({
        prepareStore: {
          peek,
          evictPreparedEntry: vi.fn(),
        } as unknown as RelayerContext['prepareStore'],
      }),
      deps: { verifySenderSignature: vi.fn() },
    });
    const direct = createGenericExecutionPolicy({
      ...options,
      sponsor: {
        txBytes,
        userSignature: 'unused',
        errors,
      },
    });

    await expect(
      direct.policy.hooks.DecodeSponsorSubmission(makePreCtx()),
    ).resolves.toBeUndefined();
    expect(direct.state.sponsor?.peeked).toBe(promotionEntry);
  });

  test('promotion-mode peek preserves signature failure priority before consume', async () => {
    const recordSponsorFailureForAbuse = vi.fn();
    const verifySenderSignature = vi.fn(async () => {
      throw new SenderSignatureError('bad signature');
    });
    const txBytes = await buildTxBytesWithSender(SENDER);
    const { policy } = createGenericExecutionPolicy({
      ...makeSponsorOptions({
        ctx: makeContext({
          prepareStore: {
            peek: vi.fn(async () => makePromotionEntry()),
            evictPreparedEntry: vi.fn(),
          } as unknown as RelayerContext['prepareStore'],
        }),
        deps: {
          verifySenderSignature:
            verifySenderSignature as unknown as GenericExecutionPolicyDependencies['verifySenderSignature'],
          recordSponsorFailureForAbuse:
            recordSponsorFailureForAbuse as unknown as typeof import('../src/abuseBlocking.js').recordSponsorFailureForAbuse,
        },
      }),
      sponsor: {
        txBytes,
        userSignature: 'bad-user-signature',
        errors,
      },
    });

    await policy.hooks.DecodeSponsorSubmission(makePreCtx());
    await expect(policy.hooks.UserSignatureValidation(makePreCtx())).rejects.toMatchObject({
      code: 'SENDER_SIGNATURE_INVALID',
    });
    expect(recordSponsorFailureForAbuse).toHaveBeenCalledWith(
      expect.anything(),
      '127.0.0.1',
      undefined,
      'SENDER_SIGNATURE_INVALID',
    );
  });

  test('promotion-mode peek preserves session mismatch priority before consume', async () => {
    const recordSponsorFailureForAbuse = vi.fn();
    const txBytes = await buildTxBytesWithSender(OTHER_SENDER);
    const { policy } = createGenericExecutionPolicy({
      ...makeSponsorOptions({
        ctx: makeContext({
          prepareStore: {
            peek: vi.fn(async () => makePromotionEntry()),
            evictPreparedEntry: vi.fn(),
          } as unknown as RelayerContext['prepareStore'],
        }),
        deps: {
          verifySenderSignature: vi.fn(async () => undefined),
          recordSponsorFailureForAbuse:
            recordSponsorFailureForAbuse as unknown as typeof import('../src/abuseBlocking.js').recordSponsorFailureForAbuse,
        },
      }),
      sponsor: {
        txBytes,
        userSignature: 'valid-for-other-sender',
        errors,
      },
    });

    await policy.hooks.DecodeSponsorSubmission(makePreCtx());
    await expect(policy.hooks.UserSignatureValidation(makePreCtx())).rejects.toMatchObject({
      code: 'RECEIPT_SESSION_MISMATCH',
    });
    expect(recordSponsorFailureForAbuse).toHaveBeenCalledWith(
      expect.anything(),
      '127.0.0.1',
      undefined,
      'RECEIPT_SESSION_MISMATCH',
    );
  });
});

describe('generic sponsor postconsume hooks', () => {
  test('SharedPostconsumeChecks verifies nonce equality and returns reconstruction inputs', async () => {
    const recordSponsorFailureForAbuse = vi.fn();
    const { policy, state } = createGenericExecutionPolicy(
      makeSponsorOptions({
        deps: {
          checkBlockedRequest: vi.fn(async () => ({ blocked: false })),
          revalidateGenericSponsorPolicy: vi.fn(async () => ({
            builtTx: {} as Transaction,
            freshConfig: { protocolFlatFeeMist: 10n },
            settleArgs: { nonce: 7n },
            isNewUserSettle: false,
          })),
          verifyGasOwner: vi.fn(() => ({ owner: SPONSOR, budget: 10_000n })),
          recordSponsorFailureForAbuse:
            recordSponsorFailureForAbuse as unknown as typeof import('../src/abuseBlocking.js').recordSponsorFailureForAbuse,
        },
      }),
    );
    seedSponsorState(state, { revalidation: undefined });

    const out = await policy.hooks.SharedPostconsumeChecks(makePostCtx());

    expect(out?.nonce).toEqual({
      nonce: 7n,
      senderAddress: SENDER,
      receiptId: RECEIPT_ID,
      inPtbNonceMatch: true,
    });
    expect(recordSponsorFailureForAbuse).not.toHaveBeenCalled();
  });

  test('SharedPostconsumeChecks maps S-14 nonce mismatch to REPREPARE_REQUIRED without abuse', async () => {
    const recordSponsorFailureForAbuse = vi.fn();
    const { policy, state } = createGenericExecutionPolicy(
      makeSponsorOptions({
        deps: {
          checkBlockedRequest: vi.fn(async () => ({ blocked: false })),
          revalidateGenericSponsorPolicy: vi.fn(async () => ({
            builtTx: {} as Transaction,
            freshConfig: { protocolFlatFeeMist: 10n },
            settleArgs: { nonce: 8n },
            isNewUserSettle: false,
          })),
          verifyGasOwner: vi.fn(() => ({ owner: SPONSOR, budget: 10_000n })),
          recordSponsorFailureForAbuse:
            recordSponsorFailureForAbuse as unknown as typeof import('../src/abuseBlocking.js').recordSponsorFailureForAbuse,
        },
      }),
    );
    seedSponsorState(state, { revalidation: undefined });

    await expect(policy.hooks.SharedPostconsumeChecks(makePostCtx())).rejects.toMatchObject({
      code: 'REPREPARE_REQUIRED',
    });
    expect(recordSponsorFailureForAbuse).not.toHaveBeenCalled();
  });

  test('Preflight records address-level abuse and throws the route preflight error', async () => {
    const recordSponsorFailureForAbuse = vi.fn();
    const { policy, state } = createGenericExecutionPolicy(
      makeSponsorOptions({
        deps: {
          runPreflight: vi.fn(async () => ({ success: false, reason: 'MoveAbort(110)' })),
          recordSponsorFailureForAbuse:
            recordSponsorFailureForAbuse as unknown as typeof import('../src/abuseBlocking.js').recordSponsorFailureForAbuse,
        },
      }),
    );
    seedSponsorState(state);

    await expect(policy.hooks.Preflight(makePostCtx())).rejects.toMatchObject({
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

describe('generic sponsor ClassifySponsorResult and Release', () => {
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
      digest: '0xdead',
      reason: 'MoveAbort(101)',
      isCongestion: false,
      gasUsed: GAS_USED,
    };

    await expect(policy.hooks.ClassifySponsorResult(makePostCtx(), failed)).rejects.toMatchObject({
      code: 'SPONSOR_ONCHAIN_FAILED',
      digest: '0xdead',
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

  test('success path records economics, projects the generic response, and Release invokes sponsor result callback', async () => {
    const onSponsorResult = vi.fn();
    const { policy, state } = createGenericExecutionPolicy(
      makeSponsorOptions({
        onSponsorResult,
      }),
    );
    seedSponsorState(state);
    const success: Extract<ExecResult, { success: true }> = {
      success: true,
      digest: '0xok',
      effects: { status: 'ok' },
      gasUsed: GAS_USED,
    };

    await policy.hooks.ClassifySponsorResult(makePostCtx(), success);
    await policy.hooks.Release(makePostCtx());
    const projected = projectGenericSponsorResult(makeSponsorOptions(), state);

    expect(projected).toEqual({
      digest: '0xok',
      effects: { status: 'ok' },
      executionCostClaim: '5000',
      orderId: 'order-1',
    });
    expect(onSponsorResult).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'success',
        route: 'generic',
        digest: '0xok',
        receiptId: RECEIPT_ID,
        senderAddress: SENDER,
        economics: expect.objectContaining({ economicsStatus: 'known' }),
      }),
    );
  });

  test('Release callback failure preserves existing sponsor_handler source', async () => {
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const onSponsorResult = vi.fn(async () => {
        throw new Error('callback exploded');
      });
      const { policy, state } = createGenericExecutionPolicy(
        makeSponsorOptions({
          onSponsorResult,
        }),
      );
      seedSponsorState(state);
      const success: Extract<ExecResult, { success: true }> = {
        success: true,
        digest: '0xok',
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
        route: 'generic',
        digest: '0xok',
        outcome: 'success',
      });
    } finally {
      consoleWarnSpy.mockRestore();
    }
  });
});
