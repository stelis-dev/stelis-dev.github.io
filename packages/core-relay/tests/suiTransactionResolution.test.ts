import { RpcError } from '@protobuf-ts/runtime-rpc';
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
  getSuiRejectedExecutionError,
  SUI_OPERATION_ATTEMPT_TIMEOUT_MS,
  SuiOperationError,
} from '../src/sui/suiOperation.js';
import {
  assertRawSuiResolutionIdentity,
  buildSuiTransaction,
} from '../src/sui/suiTransactionResolution.js';

const OBJECT_ID = `0x${'11'.repeat(32)}`;
const PACKAGE_ID = `0x${'22'.repeat(32)}`;
const SENDER = `0x${'33'.repeat(32)}`;
const DIGEST = 'CesHefDJFsgXEipkQmK6zbmWvicG5YLtAKqwZBYN4J6';

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

  it.each([
    {
      boundary: 'simulation response wrapper',
      mutateResolved: undefined,
      mutateResponse: (response: GrpcTypes.SimulateTransactionResponse) => {
        (response as unknown as Record<string, unknown>).legacyResult = true;
      },
    },
    {
      boundary: 'executed-transaction wrapper',
      mutateResolved: undefined,
      mutateResponse: (response: GrpcTypes.SimulateTransactionResponse) => {
        (response.transaction as unknown as Record<string, unknown>).legacyCheckpoint = 1n;
      },
    },
    {
      boundary: 'command oneof wrapper',
      mutateResolved: undefined,
      mutateResponse: (response: GrpcTypes.SimulateTransactionResponse) => {
        const command = programmableTransaction(responseTransaction(response)).commands[0]!.command;
        (command as unknown as Record<string, unknown>).legacyCommand = {};
      },
    },
    {
      boundary: 'MoveCall payload',
      mutateResolved: undefined,
      mutateResponse: (response: GrpcTypes.SimulateTransactionResponse) => {
        const moveCall = firstMoveCall(responseTransaction(response));
        (moveCall as unknown as Record<string, unknown>).legacyTarget = 'example';
      },
    },
    {
      boundary: 'resolver argument',
      mutateResolved: undefined,
      mutateResponse: (response: GrpcTypes.SimulateTransactionResponse) => {
        const argument = firstMoveCall(responseTransaction(response)).arguments[0]!;
        (argument as unknown as Record<string, unknown>).legacyIndex = 0;
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
  ])('fails over a $boundary in the raw resolution response', async ({ mutateResponse }) => {
    const malformed = vi.fn<RawSimulate>(currentResolution(undefined, mutateResponse));
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
  ])('fails over valid but $boundary', async ({ mutateResponse }) => {
    const unexpected = vi.fn<RawSimulate>(currentResolution(undefined, mutateResponse));
    const current = vi.fn<RawSimulate>(currentResolution());

    await expect(
      buildSuiTransaction(createSuiEndpointSnapshot([endpoint(unexpected), endpoint(current)]), {
        transaction: transaction(),
      }),
    ).resolves.toBeInstanceOf(Uint8Array);
    expect(unexpected).toHaveBeenCalledTimes(1);
    expect(current).toHaveBeenCalledTimes(1);
  });

  it('fails over a malformed command-output item before accepting an empty current response', async () => {
    const malformed = vi.fn<RawSimulate>(
      currentResolution(undefined, (response) => {
        response.commandOutputs = [{} as GrpcTypes.CommandResult];
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
