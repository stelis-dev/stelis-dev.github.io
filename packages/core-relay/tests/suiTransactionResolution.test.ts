import { RpcError } from '@protobuf-ts/runtime-rpc';
import { createHash } from 'node:crypto';
import { GrpcTypes, type SuiGrpcClient } from '@mysten/sui/grpc';
import { Transaction, TransactionDataBuilder } from '@mysten/sui/transactions';
import { describe, expect, it, vi } from 'vitest';
// The fixture deliberately reuses the installed SDK's current proto converter;
// production code must not maintain a parallel raw-to-TransactionData mirror.
// prettier-ignore
// @ts-expect-error The installed internal module has no exported declaration path.
import { grpcTransactionToTransactionData, transactionDataToGrpcTransaction } from '../../../node_modules/@mysten/sui/dist/client/transaction-resolver.mjs';
import {
  createSuiEndpointSnapshot,
  createChainBoundSuiEndpointSnapshot,
  getSuiRejectedExecutionError,
  SUI_OPERATION_ATTEMPT_TIMEOUT_MS,
  SuiOperationError,
} from '../src/sui/suiOperation.js';
import {
  buildAddressBalanceGasTransaction,
  getAddressBalanceGasTransactionBytes,
  getAddressBalanceGasTransactionTxBytesHash,
  simulateAddressBalanceGasTransaction,
  SuiAddressBalanceGasUnavailableError,
  type AddressBalanceGasTransaction,
} from '../src/sui/suiAddressBalanceGas.js';
import {
  assertRawSuiResolutionIdentity,
  buildSuiTransaction,
} from '../src/sui/suiTransactionResolution.js';

const OBJECT_ID = `0x${'11'.repeat(32)}`;
const PACKAGE_ID = `0x${'22'.repeat(32)}`;
const SENDER = `0x${'33'.repeat(32)}`;
const DIGEST = 'CesHefDJFsgXEipkQmK6zbmWvicG5YLtAKqwZBYN4J6';
const SPONSOR = `0x${'44'.repeat(32)}`;
const GAS_BUDGET = 5_000_000n;

type RawSimulate = (
  request: GrpcTypes.SimulateTransactionRequest,
  options?: { readonly timeout?: number; readonly abort?: AbortSignal },
) => Promise<{ readonly response: GrpcTypes.SimulateTransactionResponse }>;

function endpoint(simulateTransaction: RawSimulate): SuiGrpcClient {
  return {
    network: 'testnet',
    transactionExecutionService: { simulateTransaction },
  } as unknown as SuiGrpcClient;
}

function currentResolution(
  mutate?: (resolved: GrpcTypes.Transaction) => void,
  mutateResponse?: (response: GrpcTypes.SimulateTransactionResponse) => void,
): RawSimulate {
  return async (request) => {
    if (!request.transaction) throw new Error('test fixture requires a transaction');
    const resolved = structuredClone(request.transaction);
    if (!resolved.kind) throw new Error('test fixture requires a transaction kind');
    resolved.kind.kind = GrpcTypes.TransactionKind_Kind.PROGRAMMABLE_TRANSACTION;
    const programmable = programmableTransaction(resolved);
    for (const input of programmable.inputs) {
      if (input.kind === undefined && input.objectId === OBJECT_ID) {
        input.kind = GrpcTypes.Input_InputKind.IMMUTABLE_OR_OWNED;
        input.version = 1n;
        input.digest = DIGEST;
      }
    }
    resolved.gasPayment ??= { objects: [] };
    resolved.gasPayment.objects ??= [];
    resolved.gasPayment.owner ??= resolved.sender;
    resolved.gasPayment.price ??= 1_000n;
    resolved.gasPayment.budget ??= 1_000_000n;
    mutate?.(resolved);
    const transactionDigest = TransactionDataBuilder.getDigestFromBytes(
      TransactionDataBuilder.restore(grpcTransactionToTransactionData(resolved)).build(),
    );
    const includeTransactionDigest = request.readMask?.paths.includes(
      'transaction.effects.transaction_digest',
    );
    const response = GrpcTypes.SimulateTransactionResponse.create({
      transaction: {
        transaction: resolved,
        effects: {
          status: { success: true },
          ...(includeTransactionDigest ? { transactionDigest } : {}),
        },
      },
    });
    mutateResponse?.(response);
    return { response };
  };
}

function currentAddressBalanceResolution(
  mutate?: (resolved: GrpcTypes.Transaction) => void,
): RawSimulate {
  return currentResolution((resolved) => {
    resolved.expiration = {
      kind: GrpcTypes.TransactionExpiration_TransactionExpirationKind.VALID_DURING,
      minEpoch: 7n,
      epoch: 8n,
      chain: DIGEST,
      nonce: 0,
    };
    mutate?.(resolved);
  });
}

function addressBalanceEndpoint(simulateTransaction: RawSimulate, referenceGasPrice: bigint) {
  const getEpoch = vi.fn(
    async (
      _request: { readonly readMask?: { readonly paths?: readonly string[] } },
      _options?: { readonly timeout?: number; readonly abort?: AbortSignal },
    ) => ({
      response: { epoch: { referenceGasPrice } },
    }),
  );
  return {
    client: {
      network: 'testnet',
      ledgerService: { getEpoch },
      transactionExecutionService: { simulateTransaction },
    } as unknown as SuiGrpcClient,
    getEpoch,
  };
}

function programmableTransaction(
  transaction: GrpcTypes.Transaction,
): GrpcTypes.ProgrammableTransaction {
  const data = transaction.kind?.data;
  if (data?.oneofKind !== 'programmableTransaction') {
    throw new Error('test fixture requires a programmable transaction');
  }
  return data.programmableTransaction;
}

function responseTransaction(
  response: GrpcTypes.SimulateTransactionResponse,
): GrpcTypes.Transaction {
  const transaction = response.transaction?.transaction;
  if (!transaction) throw new Error('test fixture requires a resolved transaction');
  return transaction;
}

function firstMoveCall(transaction: GrpcTypes.Transaction): GrpcTypes.MoveCall {
  const command = programmableTransaction(transaction).commands[0]?.command;
  if (command?.oneofKind !== 'moveCall') {
    throw new Error('test fixture requires a first MoveCall');
  }
  return command.moveCall;
}

function transaction(): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PACKAGE_ID}::example::read`,
    arguments: [tx.object(OBJECT_ID)],
  });
  tx.setSender(SENDER);
  return tx;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('exact current Sui transaction resolution', () => {
  it('rejects an unsupported present raw input kind at the pre-RPC identity boundary', () => {
    const request = transactionDataToGrpcTransaction(transaction().getData());
    const input = programmableTransaction(request).inputs[0]!;
    input.kind = GrpcTypes.Input_InputKind.INPUT_KIND_UNKNOWN;

    expect(() => assertRawSuiResolutionIdentity(request, request)).toThrow(
      'unsupported current input kind',
    );
  });

  it('validates an unresolved raw object before allowing the resolver RPC request', () => {
    const request = transactionDataToGrpcTransaction(transaction().getData());
    const input = programmableTransaction(request).inputs[0]!;
    input.objectId = 'not-a-sui-address';

    expect(() => assertRawSuiResolutionIdentity(request, request)).toThrow(
      'expected a Sui address',
    );
  });

  it('compares provider-normalized command addresses and type tags by transaction meaning', () => {
    const tx = new Transaction();
    const coin = tx.moveCall({
      target: '0x2::coin::zero',
      typeArguments: ['0x2::sui::SUI'],
    });
    tx.transferObjects([coin], SENDER);
    tx.setSender(SENDER);
    const request = transactionDataToGrpcTransaction(tx.getData());
    const uppercaseOwner = `0x${'AB'.repeat(32)}`;
    const lowercaseOwner = `0x${'ab'.repeat(32)}`;
    const uppercaseObject = `0x${'CD'.repeat(32)}`;
    const lowercaseObject = `0x${'cd'.repeat(32)}`;
    request.gasPayment ??= { objects: [] };
    request.gasPayment.owner = uppercaseOwner;
    request.gasPayment.objects = [{ objectId: uppercaseObject, version: 1n, digest: DIGEST }];
    const resolved = structuredClone(request);
    const normalizedSystemAddress = `0x${'0'.repeat(63)}2`;
    firstMoveCall(resolved).package = normalizedSystemAddress;
    firstMoveCall(resolved).typeArguments = [`${normalizedSystemAddress}::sui::SUI`];
    resolved.gasPayment!.owner = lowercaseOwner;
    resolved.gasPayment!.objects[0]!.objectId = lowercaseObject;

    expect(() => assertRawSuiResolutionIdentity(request, resolved)).not.toThrow();
  });

  it('injects the actual attempt boundary and retries a transport failure in endpoint order', async () => {
    const unavailable = vi.fn<RawSimulate>(async (_request, options) => {
      expect(options?.timeout).toBe(SUI_OPERATION_ATTEMPT_TIMEOUT_MS);
      expect(options?.abort).toBeInstanceOf(AbortSignal);
      throw new RpcError('provider detail', 'UNAVAILABLE');
    });
    const current = vi.fn<RawSimulate>(currentResolution());

    const bytes = await buildSuiTransaction(
      createSuiEndpointSnapshot([endpoint(unavailable), endpoint(current)]),
      { transaction: transaction() },
    );

    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(unavailable).toHaveBeenCalledTimes(1);
    expect(current).toHaveBeenCalledTimes(1);
    expect(current.mock.calls[0]?.[1]).toMatchObject({
      timeout: expect.any(Number),
      abort: expect.any(AbortSignal),
    });
  });

  it('fails over a raw resolver response that changes the requested PTB commands', async () => {
    const tampered = vi.fn<RawSimulate>(
      currentResolution((resolved) => {
        firstMoveCall(resolved).function = 'tampered';
      }),
    );
    const current = vi.fn<RawSimulate>(currentResolution());

    await expect(
      buildSuiTransaction(createSuiEndpointSnapshot([endpoint(tampered), endpoint(current)]), {
        transaction: transaction(),
      }),
    ).resolves.toBeInstanceOf(Uint8Array);
    expect(tampered).toHaveBeenCalledTimes(1);
    expect(current).toHaveBeenCalledTimes(1);
  });

  it('fails over an opposing raw command oneof instead of accepting SDK normalization', async () => {
    const malformed = vi.fn<RawSimulate>(
      currentResolution((resolved) => {
        const command = programmableTransaction(resolved).commands[0]!.command as unknown as Record<
          string,
          unknown
        >;
        command.transferObjects = {
          objects: [],
          address: { kind: GrpcTypes.Argument_ArgumentKind.GAS },
        };
      }),
    );
    const current = vi.fn<RawSimulate>(currentResolution());

    await expect(
      buildSuiTransaction(createSuiEndpointSnapshot([endpoint(malformed), endpoint(current)]), {
        transaction: transaction(),
      }),
    ).resolves.toBeInstanceOf(Uint8Array);
    expect(malformed).toHaveBeenCalledTimes(1);
    expect(current).toHaveBeenCalledTimes(1);
  });

  it('fails over a consumed resolver u64 outside the protobuf range', async () => {
    const malformed = vi.fn<RawSimulate>(
      currentResolution(undefined, (response) => {
        responseTransaction(response).gasPayment!.budget = 1n << 64n;
      }),
    );
    const current = vi.fn<RawSimulate>(currentResolution());

    await expect(
      buildSuiTransaction(createSuiEndpointSnapshot([endpoint(malformed), endpoint(current)]), {
        transaction: transaction(),
      }),
    ).resolves.toBeInstanceOf(Uint8Array);
    expect(malformed).toHaveBeenCalledTimes(1);
    expect(current).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      boundary: 'command oneof wrapper',
      mutateResolved: undefined,
      mutateResponse: (response: GrpcTypes.SimulateTransactionResponse) => {
        const command = programmableTransaction(responseTransaction(response)).commands[0]!.command;
        (command as unknown as Record<string, unknown>).unsupportedField = {};
      },
    },
    {
      boundary: 'MoveCall payload',
      mutateResolved: undefined,
      mutateResponse: (response: GrpcTypes.SimulateTransactionResponse) => {
        const moveCall = firstMoveCall(responseTransaction(response));
        (moveCall as unknown as Record<string, unknown>).unsupportedField = 'example';
      },
    },
    {
      boundary: 'resolver argument',
      mutateResolved: undefined,
      mutateResponse: (response: GrpcTypes.SimulateTransactionResponse) => {
        const argument = firstMoveCall(responseTransaction(response)).arguments[0]!;
        (argument as unknown as Record<string, unknown>).unsupportedField = 0;
      },
    },
  ])(
    'fails over an unsupported key at the raw $boundary',
    async ({ mutateResolved, mutateResponse }) => {
      const malformed = vi.fn<RawSimulate>(currentResolution(mutateResolved, mutateResponse));
      const current = vi.fn<RawSimulate>(currentResolution());

      await expect(
        buildSuiTransaction(createSuiEndpointSnapshot([endpoint(malformed), endpoint(current)]), {
          transaction: transaction(),
        }),
      ).resolves.toBeInstanceOf(Uint8Array);
      expect(malformed).toHaveBeenCalledTimes(1);
      expect(current).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    {
      boundary: 'simulation response wrapper',
      mutateResponse: (response: GrpcTypes.SimulateTransactionResponse) => {
        (response as unknown as Record<string, unknown>).providerDetail = true;
      },
    },
    {
      boundary: 'executed-transaction wrapper',
      mutateResponse: (response: GrpcTypes.SimulateTransactionResponse) => {
        (response.transaction as unknown as Record<string, unknown>).providerDetail = 1n;
      },
    },
  ])('ignores an additive provider field at the raw $boundary', async ({ mutateResponse }) => {
    const accepted = vi.fn<RawSimulate>(currentResolution(undefined, mutateResponse));
    const unused = vi.fn<RawSimulate>(currentResolution());

    await expect(
      buildSuiTransaction(createSuiEndpointSnapshot([endpoint(accepted), endpoint(unused)]), {
        transaction: transaction(),
      }),
    ).resolves.toBeInstanceOf(Uint8Array);
    expect(accepted).toHaveBeenCalledTimes(1);
    expect(unused).not.toHaveBeenCalled();
  });

  it.each([
    {
      boundary: 'commandOutputs omission',
      mutateResponse: (response: GrpcTypes.SimulateTransactionResponse) => {
        delete (response as unknown as Record<string, unknown>).commandOutputs;
      },
    },
    {
      boundary: 'signatures omission',
      mutateResponse: (response: GrpcTypes.SimulateTransactionResponse) => {
        delete (response.transaction as unknown as Record<string, unknown>).signatures;
      },
    },
    {
      boundary: 'malformed balanceChanges',
      mutateResponse: (response: GrpcTypes.SimulateTransactionResponse) => {
        (response.transaction as unknown as Record<string, unknown>).balanceChanges = {};
      },
    },
  ])('ignores a discarded $boundary in the raw resolution response', async ({ mutateResponse }) => {
    const accepted = vi.fn<RawSimulate>(currentResolution(undefined, mutateResponse));
    const unused = vi.fn<RawSimulate>(currentResolution());

    await expect(
      buildSuiTransaction(createSuiEndpointSnapshot([endpoint(accepted), endpoint(unused)]), {
        transaction: transaction(),
      }),
    ).resolves.toBeInstanceOf(Uint8Array);
    expect(accepted).toHaveBeenCalledTimes(1);
    expect(unused).not.toHaveBeenCalled();
  });

  it.each([
    {
      boundary: 'unrequested command outputs',
      mutateResponse: (response: GrpcTypes.SimulateTransactionResponse) => {
        response.commandOutputs = [
          GrpcTypes.CommandResult.create({ returnValues: [], mutatedByRef: [] }),
        ];
      },
    },
    {
      boundary: 'unrequested signatures',
      mutateResponse: (response: GrpcTypes.SimulateTransactionResponse) => {
        response.transaction!.signatures = [GrpcTypes.UserSignature.create({})];
      },
    },
    {
      boundary: 'unrequested balance changes',
      mutateResponse: (response: GrpcTypes.SimulateTransactionResponse) => {
        response.transaction!.balanceChanges = [
          GrpcTypes.BalanceChange.create({
            address: SENDER,
            coinType: '0x2::sui::SUI',
            amount: '1',
          }),
        ];
      },
    },
  ])('ignores valid but $boundary', async ({ mutateResponse }) => {
    const accepted = vi.fn<RawSimulate>(currentResolution(undefined, mutateResponse));
    const unused = vi.fn<RawSimulate>(currentResolution());

    await expect(
      buildSuiTransaction(createSuiEndpointSnapshot([endpoint(accepted), endpoint(unused)]), {
        transaction: transaction(),
      }),
    ).resolves.toBeInstanceOf(Uint8Array);
    expect(accepted).toHaveBeenCalledTimes(1);
    expect(unused).not.toHaveBeenCalled();
  });

  it('ignores malformed command-output and provider-only resolution fields', async () => {
    const accepted = vi.fn<RawSimulate>(
      currentResolution(undefined, (response) => {
        response.commandOutputs = [{} as GrpcTypes.CommandResult];
        Object.assign(response, {
          suggestedGasPrice: 'malformed',
          providerDetail: 'ignored',
        });
        Object.assign(response.transaction!.effects!, {
          gasUsed: 'malformed',
          eventsDigest: 'malformed',
          providerDetail: 'ignored',
        });
      }),
    );
    const unused = vi.fn<RawSimulate>(currentResolution());

    await expect(
      buildSuiTransaction(createSuiEndpointSnapshot([endpoint(accepted), endpoint(unused)]), {
        transaction: transaction(),
      }),
    ).resolves.toBeInstanceOf(Uint8Array);
    expect(accepted).toHaveBeenCalledTimes(1);
    expect(unused).not.toHaveBeenCalled();
  });

  it('accepts current primitive and vector TypeTags in commands', async () => {
    const tx = new Transaction();
    tx.moveCall({
      target: `${PACKAGE_ID}::example::typed`,
      typeArguments: ['u64', 'vector<u8>'],
      arguments: [],
    });
    tx.makeMoveVec({ type: 'u64', elements: [] });
    tx.setSender(SENDER);

    await expect(
      buildSuiTransaction(createSuiEndpointSnapshot([endpoint(currentResolution())]), {
        transaction: tx,
      }),
    ).resolves.toBeInstanceOf(Uint8Array);
  });

  it('rejects normalized duplicate gas-payment object identities', async () => {
    const duplicate = vi.fn<RawSimulate>(
      currentResolution((resolved) => {
        resolved.gasPayment!.objects = [
          { objectId: '0x1', version: 1n, digest: DIGEST },
          { objectId: `0x${'0'.repeat(63)}1`, version: 2n, digest: DIGEST },
        ];
      }),
    );
    const current = vi.fn<RawSimulate>(currentResolution());

    await expect(
      buildSuiTransaction(createSuiEndpointSnapshot([endpoint(duplicate), endpoint(current)]), {
        transaction: transaction(),
      }),
    ).resolves.toBeInstanceOf(Uint8Array);
    expect(duplicate).toHaveBeenCalledTimes(1);
    expect(current).toHaveBeenCalledTimes(1);
  });

  it('preserves the exact raw Receiving input and rejects opposing fields', async () => {
    const receivingTx = new Transaction();
    receivingTx.moveCall({
      target: `${PACKAGE_ID}::example::receive`,
      arguments: [receivingTx.receivingRef({ objectId: OBJECT_ID, version: '1', digest: DIGEST })],
    });
    receivingTx.setSender(SENDER);
    const opposing = vi.fn<RawSimulate>(
      currentResolution((resolved) => {
        const input = programmableTransaction(resolved).inputs[0]!;
        expect(input.kind).toBe(GrpcTypes.Input_InputKind.RECEIVING);
        input.mutable = false;
      }),
    );
    const current = vi.fn<RawSimulate>(async (request) => {
      const input = programmableTransaction(request.transaction!).inputs[0]!;
      expect(input.kind).toBe(GrpcTypes.Input_InputKind.RECEIVING);
      return currentResolution()(request);
    });

    await expect(
      buildSuiTransaction(createSuiEndpointSnapshot([endpoint(opposing), endpoint(current)]), {
        transaction: receivingTx,
      }),
    ).resolves.toBeInstanceOf(Uint8Array);
    expect(opposing).toHaveBeenCalledTimes(1);
    expect(current).toHaveBeenCalledTimes(1);
  });

  it('preserves requested shared mutability even without a preset shared version', async () => {
    const tx = new Transaction();
    tx.moveCall({
      target: `${PACKAGE_ID}::example::shared`,
      arguments: [
        tx.object({
          $kind: 'UnresolvedObject',
          UnresolvedObject: { objectId: OBJECT_ID, mutable: true },
        }),
      ],
    });
    tx.setSender(SENDER);
    const resolveShared = (mutable: boolean) =>
      currentResolution((resolved) => {
        const input = programmableTransaction(resolved).inputs[0]!;
        input.kind = GrpcTypes.Input_InputKind.SHARED;
        input.version = 1n;
        input.mutable = mutable;
        input.digest = undefined;
      });
    const changed = vi.fn<RawSimulate>(resolveShared(false));
    const current = vi.fn<RawSimulate>(resolveShared(true));

    await expect(
      buildSuiTransaction(createSuiEndpointSnapshot([endpoint(changed), endpoint(current)]), {
        transaction: tx,
      }),
    ).resolves.toBeInstanceOf(Uint8Array);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(current).toHaveBeenCalledTimes(1);
  });

  it('preserves a parsed raw Move abort without retrying another endpoint', async () => {
    const rejected = vi.fn<RawSimulate>(async (request) => {
      const success = await currentResolution()(request);
      success.response.transaction!.effects!.status = {
        success: false,
        error: {
          kind: 13,
          errorDetails: {
            oneofKind: 'abort',
            abort: {
              abortCode: 7n,
              location: { package: PACKAGE_ID, module: 'example' },
            },
          },
        },
      };
      return success;
    });
    const unused = vi.fn<RawSimulate>(currentResolution());

    const failure = buildSuiTransaction(
      createSuiEndpointSnapshot([endpoint(rejected), endpoint(unused)]),
      { transaction: transaction() },
    );
    let thrown: unknown;
    try {
      await failure;
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SuiOperationError);
    expect(thrown).toMatchObject({ kind: 'rpc_rejected' });
    expect(thrown).not.toHaveProperty('cause');
    expect(String(thrown)).not.toContain('example.invalid');
    expect(getSuiRejectedExecutionError(thrown)).toMatchObject({
      kind: 'MoveAbort',
      moveAbort: { abortCode: '7' },
    });
    expect(unused).not.toHaveBeenCalled();
  });

  it('binds a failed resolver status to the resolved digest before classifying it', async () => {
    const mismatched = vi.fn<RawSimulate>(async (request) => {
      const response = await currentResolution()(request);
      response.response.transaction!.effects!.transactionDigest = DIGEST;
      response.response.transaction!.effects!.status = {
        success: false,
        error: {
          kind: GrpcTypes.ExecutionError_ExecutionErrorKind.INSUFFICIENT_GAS,
          errorDetails: { oneofKind: undefined },
        },
      };
      return response;
    });
    const current = vi.fn<RawSimulate>(currentResolution());

    await expect(
      buildSuiTransaction(createSuiEndpointSnapshot([endpoint(mismatched), endpoint(current)]), {
        transaction: transaction(),
      }),
    ).resolves.toBeInstanceOf(Uint8Array);
    expect(mismatched).toHaveBeenCalledTimes(1);
    expect(current).toHaveBeenCalledTimes(1);
  });

  it('rejects residual UnresolvedPure before any endpoint RPC', async () => {
    const data = transaction().getData();
    const input = data.inputs.length;
    data.inputs.push({ $kind: 'UnresolvedPure', UnresolvedPure: { value: { untyped: true } } });
    const command = data.commands[0];
    if (command?.$kind !== 'MoveCall') throw new Error('fixture requires MoveCall');
    command.MoveCall.arguments.push({ $kind: 'Input', Input: input, type: 'pure' });
    const tx = Transaction.from(JSON.stringify(data));
    const simulate = vi.fn<RawSimulate>(currentResolution());

    await expect(
      buildSuiTransaction(createSuiEndpointSnapshot([endpoint(simulate)]), {
        transaction: tx,
      }),
    ).rejects.toMatchObject({ kind: 'invalid_request' });
    expect(simulate).not.toHaveBeenCalled();
  });

  it('does not treat a caller-created rejection as structured execution authority', () => {
    const forged = new SuiOperationError('rpc_rejected', {
      operation: 'resolve_transaction',
      attempt: 1,
      maxAttempts: 1,
    });

    expect(getSuiRejectedExecutionError(forged)).toBeUndefined();
  });

  it('shape-validates but does not treat kind-only execution failure as admission', async () => {
    const failedKindResolution = vi.fn<RawSimulate>(async (request) => {
      const response = await currentResolution()(request);
      response.response.transaction!.effects!.status = {
        success: false,
        error: {
          description: 'kind-only execution is not admission',
          kind: 13,
          errorDetails: {
            oneofKind: 'abort',
            abort: { abortCode: 9n },
          },
        },
      };
      return response;
    });

    await expect(
      buildSuiTransaction(createSuiEndpointSnapshot([endpoint(failedKindResolution)]), {
        transaction: transaction(),
        onlyTransactionKind: true,
      }),
    ).resolves.toBeInstanceOf(Uint8Array);
  });

  it('does not retry a resolver programming TypeError wrapped by the current SDK', async () => {
    const invalid = vi.fn<RawSimulate>(async () => {
      throw new TypeError('programming detail');
    });
    const unused = vi.fn<RawSimulate>(currentResolution());

    await expect(
      buildSuiTransaction(createSuiEndpointSnapshot([endpoint(invalid), endpoint(unused)]), {
        transaction: transaction(),
      }),
    ).rejects.toMatchObject({ kind: 'invalid_request' });
    expect(unused).not.toHaveBeenCalled();
  });

  it('rejects a preset sender identity changed by the raw resolver', async () => {
    const tx = transaction();
    tx.setGasOwner(SENDER);
    tx.setGasBudget(1_000_000);
    tx.setGasPrice(1_000);
    tx.setGasPayment([]);
    const changed = vi.fn<RawSimulate>(
      currentResolution((resolved) => {
        resolved.sender = `0x${'44'.repeat(32)}`;
      }),
    );

    await expect(
      buildSuiTransaction(createSuiEndpointSnapshot([endpoint(changed)]), {
        transaction: tx,
      }),
    ).rejects.toMatchObject({ kind: 'malformed_response' });
  });

  it('rejects a sparse raw resolver command array instead of skipping the missing command', async () => {
    const sparse = vi.fn<RawSimulate>(
      currentResolution((resolved) => {
        programmableTransaction(resolved).commands = new Array(1);
      }),
    );
    const current = vi.fn<RawSimulate>(currentResolution());

    await expect(
      buildSuiTransaction(createSuiEndpointSnapshot([endpoint(sparse), endpoint(current)]), {
        transaction: transaction(),
      }),
    ).resolves.toBeInstanceOf(Uint8Array);
    expect(sparse).toHaveBeenCalledTimes(1);
    expect(current).toHaveBeenCalledTimes(1);
  });

  it('forwards caller abort to the actual raw resolution request', async () => {
    const controller = new AbortController();
    let actualSignal: AbortSignal | undefined;
    const pending = vi.fn<RawSimulate>(
      (_request, options) =>
        new Promise((_resolve, reject) => {
          actualSignal = options?.abort;
          options?.abort?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
        }),
    );
    const operation = buildSuiTransaction(createSuiEndpointSnapshot([endpoint(pending)]), {
      transaction: transaction(),
      signal: controller.signal,
    });

    await vi.waitFor(() => expect(actualSignal).toBeInstanceOf(AbortSignal));
    controller.abort();
    await expect(operation).rejects.toMatchObject({ kind: 'aborted' });
    expect(actualSignal?.aborted).toBe(true);
  });

  it('builds an entry snapshot that caller mutation cannot change while resolution awaits', async () => {
    const gate = deferred<void>();
    const resolving = vi.fn<RawSimulate>(async (request) => {
      await gate.promise;
      return currentResolution()(request);
    });
    const original = transaction();
    const operation = buildSuiTransaction(createSuiEndpointSnapshot([endpoint(resolving)]), {
      transaction: original,
    });

    await vi.waitFor(() => expect(resolving).toHaveBeenCalledTimes(1));
    original.moveCall({ target: `${PACKAGE_ID}::example::late_mutation`, arguments: [] });
    gate.resolve();

    const bytes = await operation;
    expect(TransactionDataBuilder.fromBytes(bytes).snapshot().commands).toHaveLength(1);
    expect(original.getData().commands).toHaveLength(2);
  });

  it('rejects a non-boolean onlyTransactionKind argument before any RPC', () => {
    const simulate = vi.fn<RawSimulate>(currentResolution());
    expect(() =>
      buildSuiTransaction(createSuiEndpointSnapshot([endpoint(simulate)]), {
        transaction: transaction(),
        onlyTransactionKind: null as never,
      }),
    ).toThrow('onlyTransactionKind must be a boolean');
    expect(simulate).not.toHaveBeenCalled();
  });
});

describe('address-balance gas transaction authority', () => {
  function snapshot(client: SuiGrpcClient) {
    return createChainBoundSuiEndpointSnapshot([client], DIGEST);
  }

  function transactionWithoutSender(): Transaction {
    const tx = new Transaction();
    tx.moveCall({
      target: `${PACKAGE_ID}::example::read`,
      arguments: [tx.object(OBJECT_ID)],
    });
    return tx;
  }

  it.each([
    ['missing sender', () => transactionWithoutSender()],
    [
      'gas owner',
      () => {
        const tx = transaction();
        tx.setGasOwner(SPONSOR);
        return tx;
      },
    ],
    [
      'gas price',
      () => {
        const tx = transaction();
        tx.setGasPrice(1_000n);
        return tx;
      },
    ],
    [
      'gas budget',
      () => {
        const tx = transaction();
        tx.setGasBudget(GAS_BUDGET);
        return tx;
      },
    ],
    [
      'gas payment',
      () => {
        const tx = transaction();
        tx.setGasPayment([]);
        return tx;
      },
    ],
    [
      'expiration',
      () => {
        const tx = transaction();
        tx.setExpiration({ Epoch: 8 });
        return tx;
      },
    ],
  ])('rejects a source with preset %s before either RPC', async (_name, makeTransaction) => {
    const simulate = vi.fn<RawSimulate>(currentAddressBalanceResolution());
    const endpoint = addressBalanceEndpoint(simulate, 1_000n);

    await expect(
      buildAddressBalanceGasTransaction(snapshot(endpoint.client), {
        transaction: makeTransaction(),
        sponsorAddress: SPONSOR,
        gasBudget: GAS_BUDGET,
      }),
    ).rejects.toThrow('requires a sender and no preset gas or expiration fields');
    expect(endpoint.getEpoch).not.toHaveBeenCalled();
    expect(simulate).not.toHaveBeenCalled();
  });

  it('builds one exact address-balance envelope without mutating the source transaction', async () => {
    const simulate = vi.fn<RawSimulate>(currentAddressBalanceResolution());
    const endpoint = addressBalanceEndpoint(simulate, 1_234n);
    const source = transaction();

    const sealed = await buildAddressBalanceGasTransaction(snapshot(endpoint.client), {
      transaction: source,
      sponsorAddress: SPONSOR,
      gasBudget: GAS_BUDGET,
    });

    expect(endpoint.getEpoch).toHaveBeenCalledTimes(1);
    expect(endpoint.getEpoch.mock.calls[0]?.[0]).toEqual({
      readMask: { paths: ['reference_gas_price'] },
    });
    expect(simulate).toHaveBeenCalledTimes(1);
    const resolutionRequest = simulate.mock.calls[0]![0];
    expect(resolutionRequest.doGasSelection).toBe(true);
    expect(resolutionRequest.transaction?.gasPayment).toMatchObject({
      owner: SPONSOR,
      price: 1_234n,
      budget: GAS_BUDGET,
    });
    expect(resolutionRequest.transaction?.gasPayment?.objects).toEqual([]);

    const bytes = getAddressBalanceGasTransactionBytes(sealed);
    const data = TransactionDataBuilder.fromBytes(bytes).snapshot();
    expect(data.gasData.owner).toBe(SPONSOR);
    expect(BigInt(data.gasData.price!)).toBe(1_234n);
    expect(BigInt(data.gasData.budget!)).toBe(GAS_BUDGET);
    expect(data.gasData.payment).toEqual([]);
    expect(data.expiration?.$kind).toBe('ValidDuring');
    if (data.expiration?.$kind !== 'ValidDuring') throw new Error('expected ValidDuring');
    expect(BigInt(data.expiration.ValidDuring.minEpoch!)).toBe(7n);
    expect(BigInt(data.expiration.ValidDuring.maxEpoch!)).toBe(8n);
    expect(data.expiration.ValidDuring.chain).toBe(DIGEST);
    expect(data.expiration.ValidDuring.nonce).toBe(0);
    expect(data.expiration.ValidDuring.minTimestamp).toBeNull();
    expect(data.expiration.ValidDuring.maxTimestamp).toBeNull();

    expect(source.getData().gasData).toMatchObject({
      owner: null,
      price: null,
      budget: null,
      payment: null,
    });
    expect(source.getData().expiration).toBeNull();
    expect(getAddressBalanceGasTransactionTxBytesHash(sealed)).toBe(
      createHash('sha256').update(bytes).digest('hex'),
    );
    const firstByte = bytes[0]!;
    bytes[0] ^= 0xff;
    expect(getAddressBalanceGasTransactionBytes(sealed)[0]).toBe(firstByte);

    const forged = Object.freeze({}) as AddressBalanceGasTransaction;
    expect(() => getAddressBalanceGasTransactionBytes(forged)).toThrow(
      'not created by its builder',
    );
    expect(() => getAddressBalanceGasTransactionTxBytesHash(forged)).toThrow(
      'not created by its builder',
    );
    expect(() => simulateAddressBalanceGasTransaction(forged)).toThrow(
      'not created by its builder',
    );
  });

  it('rejects Coin fallback and repeats price plus resolution on the next endpoint', async () => {
    const firstSimulate = vi.fn<RawSimulate>(
      currentAddressBalanceResolution((resolved) => {
        resolved.gasPayment!.objects = [{ objectId: OBJECT_ID, version: 1n, digest: DIGEST }];
      }),
    );
    const secondSimulate = vi.fn<RawSimulate>(currentAddressBalanceResolution());
    const first = addressBalanceEndpoint(firstSimulate, 1_000n);
    const second = addressBalanceEndpoint(secondSimulate, 2_000n);

    const sealed = await buildAddressBalanceGasTransaction(
      createChainBoundSuiEndpointSnapshot([first.client, second.client], DIGEST),
      {
        transaction: transaction(),
        sponsorAddress: SPONSOR,
        gasBudget: GAS_BUDGET,
      },
    );

    expect(first.getEpoch).toHaveBeenCalledTimes(1);
    expect(firstSimulate).toHaveBeenCalledTimes(1);
    expect(second.getEpoch).toHaveBeenCalledTimes(1);
    expect(secondSimulate).toHaveBeenCalledTimes(1);
    const data = TransactionDataBuilder.fromBytes(
      getAddressBalanceGasTransactionBytes(sealed),
    ).snapshot();
    expect(data.gasData.payment).toEqual([]);
    expect(BigInt(data.gasData.price!)).toBe(2_000n);
  });

  it('classifies Coin fallback as sponsor capacity when no endpoint returns address-balance gas', async () => {
    const simulate = vi.fn<RawSimulate>(
      currentAddressBalanceResolution((resolved) => {
        resolved.gasPayment!.objects = [{ objectId: OBJECT_ID, version: 1n, digest: DIGEST }];
      }),
    );
    const endpoint = addressBalanceEndpoint(simulate, 1_000n);

    await expect(
      buildAddressBalanceGasTransaction(snapshot(endpoint.client), {
        transaction: transaction(),
        sponsorAddress: SPONSOR,
        gasBudget: GAS_BUDGET,
      }),
    ).rejects.toBeInstanceOf(SuiAddressBalanceGasUnavailableError);
  });

  it.each([
    [
      'wrong gas owner',
      (resolved: GrpcTypes.Transaction) => {
        resolved.gasPayment!.owner = SENDER;
      },
    ],
    [
      'wrong gas price',
      (resolved: GrpcTypes.Transaction) => {
        resolved.gasPayment!.price = 2_000n;
      },
    ],
    [
      'wrong gas budget',
      (resolved: GrpcTypes.Transaction) => {
        resolved.gasPayment!.budget = GAS_BUDGET + 1n;
      },
    ],
    [
      'missing expiration',
      (resolved: GrpcTypes.Transaction) => {
        resolved.expiration = undefined;
      },
    ],
    [
      'wrong expiration kind',
      (resolved: GrpcTypes.Transaction) => {
        resolved.expiration = {
          kind: GrpcTypes.TransactionExpiration_TransactionExpirationKind.EPOCH,
          epoch: 8n,
        };
      },
    ],
    [
      'wrong chain',
      (resolved: GrpcTypes.Transaction) => {
        resolved.expiration!.chain = TransactionDataBuilder.getDigestFromBytes(
          new Uint8Array([1, 2, 3]),
        );
      },
    ],
    [
      'non-unit epoch span',
      (resolved: GrpcTypes.Transaction) => {
        resolved.expiration!.epoch = 9n;
      },
    ],
    [
      'timestamp bounds',
      (resolved: GrpcTypes.Transaction) => {
        resolved.expiration!.minTimestamp = { seconds: 1n, nanos: 0 };
        resolved.expiration!.maxTimestamp = { seconds: 2n, nanos: 0 };
      },
    ],
  ])('rejects a returned transaction with %s', async (_name, mutate) => {
    const simulate = vi.fn<RawSimulate>(currentAddressBalanceResolution(mutate));
    const endpoint = addressBalanceEndpoint(simulate, 1_000n);

    await expect(
      buildAddressBalanceGasTransaction(snapshot(endpoint.client), {
        transaction: transaction(),
        sponsorAddress: SPONSOR,
        gasBudget: GAS_BUDGET,
      }),
    ).rejects.toMatchObject({ kind: 'malformed_response' });
  });

  it('simulates only through the sealed value and its originating endpoint snapshot', async () => {
    const resolve = currentAddressBalanceResolution();
    const simulate = vi.fn<RawSimulate>(async (request, options) => {
      const bcs = request.transaction?.bcs?.value;
      if (!bcs) return resolve(request, options);
      const digest = TransactionDataBuilder.getDigestFromBytes(bcs);
      expect(request.readMask?.paths).toEqual([
        'transaction.transaction.digest',
        'transaction.effects.status',
        'transaction.effects.gas_used',
      ]);
      return {
        response: GrpcTypes.SimulateTransactionResponse.create({
          transaction: {
            transaction: { digest },
            effects: {
              status: { success: true },
              gasUsed: {
                computationCost: 3n,
                storageCost: 2n,
                storageRebate: 1n,
                nonRefundableStorageFee: 0n,
              },
            },
          },
        }),
      };
    });
    const endpoint = addressBalanceEndpoint(simulate, 1_000n);
    const sealed = await buildAddressBalanceGasTransaction(snapshot(endpoint.client), {
      transaction: transaction(),
      sponsorAddress: SPONSOR,
      gasBudget: GAS_BUDGET,
    });

    await expect(simulateAddressBalanceGasTransaction(sealed)).resolves.toEqual({
      outcome: 'success',
      effects: {
        gasUsed: {
          computationCost: '3',
          storageCost: '2',
          storageRebate: '1',
          nonRefundableStorageFee: '0',
        },
      },
    });
    expect(simulate).toHaveBeenCalledTimes(2);
  });
});
