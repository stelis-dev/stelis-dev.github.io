import { GrpcTypes, type SuiGrpcClient } from '@mysten/sui/grpc';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { bcs } from '@mysten/sui/bcs';
import { Transaction, TransactionDataBuilder } from '@mysten/sui/transactions';
import { fromBase64 } from '@mysten/sui/utils';
import { describe, expect, it, vi } from 'vitest';
// Test fixtures reuse the installed SDK's current proto converter instead of
// maintaining a second production conversion authority.
// @ts-expect-error The installed internal module has no exported declaration path.
import { grpcTransactionToTransactionData } from '../../../node_modules/@mysten/sui/dist/client/transaction-resolver.mjs';
import { createSuiEndpointSnapshot } from '../src/sui/suiOperation.js';
import {
  executeSuiTransaction,
  getSuiTransactionBalanceChanges,
  getSuiTransactionEffects,
  getSuiTransactionEvents,
  simulateSuiMoveView,
  simulateSuiTransaction,
} from '../src/sui/suiTransactionGateways.js';

const ID = `0x${'11'.repeat(32)}`;
const GAS_DIGEST = 'CesHefDJFsgXEipkQmK6zbmWvicG5YLtAKqwZBYN4J6';
const testTransaction = new Transaction();
testTransaction.splitCoins(testTransaction.gas, [testTransaction.pure.u64(1)]);
testTransaction.setSender(ID);
testTransaction.setGasOwner(ID);
testTransaction.setGasPrice(1);
testTransaction.setGasBudget(1_000);
testTransaction.setGasPayment([{ objectId: ID, version: '1', digest: GAS_DIGEST }]);
const BYTES = await testTransaction.build();
const DIGEST = TransactionDataBuilder.getDigestFromBytes(BYTES);
const EVENT_DIGEST = TransactionDataBuilder.getDigestFromBytes(new Uint8Array([4, 5, 6]));
const SIGNER = Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(7));
const ZERO_ADDRESS = `0x${'00'.repeat(32)}`;
const VIEW_PACKAGE = `0x${'22'.repeat(32)}`;

function rawTransaction(includeDigest: boolean, events = false): GrpcTypes.ExecutedTransaction {
  return GrpcTypes.ExecutedTransaction.create({
    ...(includeDigest ? { digest: DIGEST } : {}),
    effects: {
      version: 2,
      transactionDigest: DIGEST,
      status: { success: true },
      gasUsed: {
        computationCost: 3n,
        storageCost: 2n,
        storageRebate: 1n,
        nonRefundableStorageFee: 0n,
      },
    },
    ...(events ? { events: { events: [] } } : {}),
  });
}

function simulationResponse(
  transaction: GrpcTypes.ExecutedTransaction,
  commandOutputs: readonly GrpcTypes.CommandResult[] = [],
): GrpcTypes.SimulateTransactionResponse {
  return GrpcTypes.SimulateTransactionResponse.create({
    transaction,
    commandOutputs: [...commandOutputs],
  });
}

function client(services: Record<string, unknown>): SuiGrpcClient {
  return { network: 'testnet', ...services } as unknown as SuiGrpcClient;
}

function moveViewTransaction(): Transaction {
  const transaction = new Transaction();
  transaction.moveCall({
    target: `${VIEW_PACKAGE}::views::read`,
    arguments: [transaction.object(ID)],
  });
  return transaction;
}

type MoveViewResponseFactory = (
  transaction: GrpcTypes.ExecutedTransaction,
  defaultOutputs: readonly GrpcTypes.CommandResult[],
) => GrpcTypes.SimulateTransactionResponse | Record<string, unknown>;

function moveViewEndpoint(
  factory: MoveViewResponseFactory,
  mutateResolution?: (transaction: GrpcTypes.Transaction) => void,
) {
  const simulate = vi.fn(async (request: GrpcTypes.SimulateTransactionRequest) => {
    const paths = request.readMask?.paths ?? [];
    if (!paths.includes('transaction.transaction.bcs')) {
      const resolved = structuredClone(request.transaction!);
      resolved.kind!.kind = GrpcTypes.TransactionKind_Kind.PROGRAMMABLE_TRANSACTION;
      const programmable = resolved.kind?.data;
      if (programmable?.oneofKind !== 'programmableTransaction') {
        throw new Error('fixture requires a programmable transaction');
      }
      for (const input of programmable.programmableTransaction.inputs) {
        if (input.kind === undefined && input.objectId === ID) {
          input.kind = GrpcTypes.Input_InputKind.IMMUTABLE_OR_OWNED;
          input.version = 1n;
          input.digest = GAS_DIGEST;
        }
      }
      // Current public gRPC resolution materializes these non-kind defaults
      // even with doGasSelection=false. The installed SDK discards them for
      // onlyTransactionKind; the Move-view gateway must do the same rather
      // than forwarding them into the actual view request.
      resolved.gasPayment ??= { objects: [] };
      resolved.gasPayment.price = 1_000n;
      resolved.gasPayment.budget = 50_000_000_000_000n;
      resolved.expiration = {
        kind: GrpcTypes.TransactionExpiration_TransactionExpirationKind.NONE,
      };
      mutateResolution?.(resolved);
      return {
        response: GrpcTypes.SimulateTransactionResponse.create({
          transaction: {
            transaction: resolved,
            effects: { status: { success: true } },
          },
        }),
      };
    }

    const fullTransaction = structuredClone(request.transaction!);
    fullTransaction.gasPayment = {
      objects: [],
      owner: ZERO_ADDRESS,
      price: 1_000n,
      budget: 50_000_000n,
    };
    const transactionBytes = TransactionDataBuilder.restore(
      grpcTransactionToTransactionData(fullTransaction),
    ).build();
    const transactionDigest = TransactionDataBuilder.getDigestFromBytes(transactionBytes);
    const executed = GrpcTypes.ExecutedTransaction.create({
      transaction: {
        digest: transactionDigest,
        bcs: { name: 'TransactionData', value: transactionBytes },
      },
      effects: {
        version: 2,
        // Current checks-disabled simulation effects carry a simulation digest
        // that is distinct from the returned TransactionData identity.
        transactionDigest: DIGEST,
        status: { success: true },
        gasUsed: {
          computationCost: 0n,
          storageCost: 0n,
          storageRebate: 0n,
          nonRefundableStorageFee: 0n,
        },
      },
    });
    const commandOutputs = [
      GrpcTypes.CommandResult.create({
        returnValues: [{ value: { name: 'u64', value: new Uint8Array([7]) } }],
        mutatedByRef: [],
      }),
    ];
    return { response: factory(executed, commandOutputs) };
  });
  return {
    client: client({ transactionExecutionService: { simulateTransaction: simulate } }),
    simulate,
  };
}

function replaceMoveViewBcs(
  transaction: GrpcTypes.ExecutedTransaction,
  mutate: (data: ReturnType<TransactionDataBuilder['snapshot']>) => void,
): void {
  const currentBytes = transaction.transaction!.bcs!.value!;
  const data = TransactionDataBuilder.fromBytes(currentBytes).snapshot();
  mutate(data);
  const bytes = TransactionDataBuilder.restore(data).build();
  transaction.transaction!.bcs!.value = bytes;
  transaction.transaction!.digest = TransactionDataBuilder.getDigestFromBytes(bytes);
}

function replaceMoveViewRawBcs(
  transaction: GrpcTypes.ExecutedTransaction,
  mutate: (data: ReturnType<typeof bcs.TransactionData.parse>) => void,
): void {
  const currentBytes = transaction.transaction!.bcs!.value!;
  const data = bcs.TransactionData.parse(currentBytes);
  mutate(data);
  const bytes = bcs.TransactionData.serialize(data).toBytes();
  transaction.transaction!.bcs!.value = bytes;
  transaction.transaction!.digest = TransactionDataBuilder.getDigestFromBytes(bytes);
}

describe('current Sui transaction gateways', () => {
  it('fails over a malformed simulation response without changing request identity', async () => {
    const firstSimulate = vi.fn(async () => ({ response: {} }));
    const secondSimulate = vi.fn(async (_request: unknown) => ({
      response: simulationResponse(rawTransaction(false)),
    }));
    const snapshot = createSuiEndpointSnapshot([
      client({ transactionExecutionService: { simulateTransaction: firstSimulate } }),
      client({ transactionExecutionService: { simulateTransaction: secondSimulate } }),
    ]);

    const result = await simulateSuiTransaction(snapshot, { transaction: BYTES });
    expect(result).toMatchObject({ outcome: 'success', digest: DIGEST });
    expect('events' in result).toBe(false);
    expect(firstSimulate).toHaveBeenCalledTimes(1);
    expect(secondSimulate).toHaveBeenCalledTimes(1);
    expect(secondSimulate.mock.calls[0]![0]).toMatchObject({
      checks: GrpcTypes.SimulateTransactionRequest_TransactionChecks.ENABLED,
      doGasSelection: false,
    });
  });

  it('rejects non-TransactionData bytes before any simulation or execution RPC', async () => {
    const simulate = vi.fn();
    const execute = vi.fn();
    const snapshot = createSuiEndpointSnapshot([
      client({
        transactionExecutionService: {
          simulateTransaction: simulate,
          executeTransaction: execute,
        },
      }),
    ]);

    expect(() =>
      simulateSuiTransaction(snapshot, { transaction: new Uint8Array([1, 2, 3]) }),
    ).toThrow('current full TransactionData BCS');
    expect(() =>
      executeSuiTransaction(snapshot, {
        transaction: new Uint8Array([1, 2, 3]),
        signatures: ['not-reached'],
      }),
    ).toThrow('current full TransactionData BCS');
    expect(simulate).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('fails over omitted or malformed mandatory ExecutedTransaction arrays', async () => {
    const omittedResponse = simulationResponse(rawTransaction(false));
    delete (omittedResponse.transaction as unknown as Record<string, unknown>).signatures;
    const malformedResponse = simulationResponse(rawTransaction(false));
    (malformedResponse.transaction as unknown as Record<string, unknown>).balanceChanges = {};

    const omitted = vi.fn(async () => ({
      response: omittedResponse,
    }));
    const malformed = vi.fn(async () => ({
      response: malformedResponse,
    }));
    const current = vi.fn(async () => ({
      response: simulationResponse(rawTransaction(false)),
    }));

    await expect(
      simulateSuiTransaction(
        createSuiEndpointSnapshot([
          client({ transactionExecutionService: { simulateTransaction: omitted } }),
          client({ transactionExecutionService: { simulateTransaction: malformed } }),
          client({ transactionExecutionService: { simulateTransaction: current } }),
        ]),
        { transaction: BYTES },
      ),
    ).resolves.toMatchObject({ outcome: 'success', digest: DIGEST });
    expect(omitted).toHaveBeenCalledTimes(1);
    expect(malformed).toHaveBeenCalledTimes(1);
    expect(current).toHaveBeenCalledTimes(1);
  });

  it('fails over an omitted mandatory simulation command-output array', async () => {
    const omitted = vi.fn(async () => ({
      response: { transaction: rawTransaction(false) },
    }));
    const current = vi.fn(async () => ({
      response: simulationResponse(rawTransaction(false)),
    }));

    await expect(
      simulateSuiTransaction(
        createSuiEndpointSnapshot([
          client({ transactionExecutionService: { simulateTransaction: omitted } }),
          client({ transactionExecutionService: { simulateTransaction: current } }),
        ]),
        { transaction: BYTES },
      ),
    ).resolves.toMatchObject({ outcome: 'success', digest: DIGEST });
    expect(omitted).toHaveBeenCalledTimes(1);
    expect(current).toHaveBeenCalledTimes(1);
  });

  it('returns command outputs only from the Move-view gateway', async () => {
    const endpoint = moveViewEndpoint((transaction, commandOutputs) =>
      simulationResponse(transaction, commandOutputs),
    );
    const result = await simulateSuiMoveView(createSuiEndpointSnapshot([endpoint.client]), {
      transaction: moveViewTransaction(),
    });

    expect(result.outcome).toBe('success');
    if (result.outcome === 'success') {
      expect(result.commandResults[0]?.returnValues[0]?.bcs).toEqual(new Uint8Array([7]));
    }
    expect(endpoint.simulate).toHaveBeenCalledTimes(2);
    const resolutionRequest = endpoint.simulate.mock.calls[0]![0];
    expect(resolutionRequest.checks).toBe(
      GrpcTypes.SimulateTransactionRequest_TransactionChecks.DISABLED,
    );
    expect(resolutionRequest.doGasSelection).toBe(false);
    const viewRequest = endpoint.simulate.mock.calls[1]![0];
    expect(viewRequest.transaction).toMatchObject({ sender: ZERO_ADDRESS });
    expect(viewRequest.transaction?.gasPayment).toBeUndefined();
    expect(viewRequest.transaction?.expiration).toBeUndefined();
    expect(viewRequest.checks).toBe(
      GrpcTypes.SimulateTransactionRequest_TransactionChecks.DISABLED,
    );
  });

  it.each([
    {
      boundary: 'sender',
      preset: (transaction: Transaction) => transaction.setSender(ID),
    },
    {
      boundary: 'gas',
      preset: (transaction: Transaction) => transaction.setGasPrice(1),
    },
    {
      boundary: 'expiration',
      preset: (transaction: Transaction) => transaction.setExpiration({ Epoch: 1 }),
    },
  ])('rejects caller-owned Move-view $boundary before any RPC', async ({ preset }) => {
    const transaction = moveViewTransaction();
    preset(transaction);
    const first = moveViewEndpoint((resolved, outputs) => simulationResponse(resolved, outputs));
    const second = moveViewEndpoint((resolved, outputs) => simulationResponse(resolved, outputs));

    await expect(
      simulateSuiMoveView(createSuiEndpointSnapshot([first.client, second.client]), {
        transaction,
      }),
    ).rejects.toMatchObject({
      kind: 'invalid_request',
      diagnostic: { attempt: 1, maxAttempts: 2 },
    });
    expect(first.simulate).not.toHaveBeenCalled();
    expect(second.simulate).not.toHaveBeenCalled();
  });

  it.each([
    {
      boundary: 'gas owner',
      mutate: (transaction: GrpcTypes.Transaction) => {
        transaction.gasPayment!.owner = ID;
      },
    },
    {
      boundary: 'gas payment object',
      mutate: (transaction: GrpcTypes.Transaction) => {
        transaction.gasPayment!.objects = [{ objectId: ID, version: 1n, digest: GAS_DIGEST }];
      },
    },
    {
      boundary: 'non-neutral expiration',
      mutate: (transaction: GrpcTypes.Transaction) => {
        transaction.expiration = {
          kind: GrpcTypes.TransactionExpiration_TransactionExpirationKind.EPOCH,
          epoch: 1n,
        };
      },
    },
  ])('fails over a resolver-authored Move-view $boundary', async ({ mutate }) => {
    const malformed = moveViewEndpoint(
      (transaction, outputs) => simulationResponse(transaction, outputs),
      mutate,
    );
    const current = moveViewEndpoint((transaction, outputs) =>
      simulationResponse(transaction, outputs),
    );

    await expect(
      simulateSuiMoveView(createSuiEndpointSnapshot([malformed.client, current.client]), {
        transaction: moveViewTransaction(),
      }),
    ).resolves.toMatchObject({ outcome: 'success' });
    expect(malformed.simulate).toHaveBeenCalledTimes(1);
    expect(current.simulate).toHaveBeenCalledTimes(2);
  });

  it('validates the mandatory command-output array even when Move-view execution fails', async () => {
    const fail = (transaction: GrpcTypes.ExecutedTransaction) => {
      transaction.effects!.status = {
        success: false,
        error: {
          kind: GrpcTypes.ExecutionError_ExecutionErrorKind.INSUFFICIENT_GAS,
          errorDetails: { oneofKind: undefined },
        },
      };
      return transaction;
    };
    const omitted = moveViewEndpoint((transaction) => ({ transaction: fail(transaction) }));
    const malformed = moveViewEndpoint((transaction) => ({
      transaction: fail(transaction),
      commandOutputs: {},
    }));
    const currentFailure = moveViewEndpoint((transaction) => simulationResponse(fail(transaction)));

    await expect(
      simulateSuiMoveView(
        createSuiEndpointSnapshot([omitted.client, malformed.client, currentFailure.client]),
        { transaction: moveViewTransaction() },
      ),
    ).resolves.toMatchObject({ outcome: 'failure', error: { kind: 'InsufficientGas' } });
    expect(omitted.simulate).toHaveBeenCalledTimes(2);
    expect(malformed.simulate).toHaveBeenCalledTimes(2);
    expect(currentFailure.simulate).toHaveBeenCalledTimes(2);
  });

  it('binds Move-view command-result cardinality to the submitted PTB', async () => {
    const omitted = moveViewEndpoint((transaction) => simulationResponse(transaction));
    const extra = moveViewEndpoint((transaction) =>
      simulationResponse(transaction, [
        GrpcTypes.CommandResult.create({ returnValues: [], mutatedByRef: [] }),
        GrpcTypes.CommandResult.create({ returnValues: [], mutatedByRef: [] }),
      ]),
    );

    await expect(
      simulateSuiMoveView(createSuiEndpointSnapshot([omitted.client, extra.client]), {
        transaction: moveViewTransaction(),
      }),
    ).rejects.toMatchObject({ kind: 'malformed_response' });
    expect(omitted.simulate).toHaveBeenCalledTimes(2);
    expect(extra.simulate).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      boundary: 'sender',
      mutate: (transaction: GrpcTypes.ExecutedTransaction) =>
        replaceMoveViewBcs(transaction, (data) => {
          data.sender = ID;
        }),
    },
    {
      boundary: 'resolved PTB command',
      mutate: (transaction: GrpcTypes.ExecutedTransaction) =>
        replaceMoveViewBcs(transaction, (data) => {
          const command = data.commands[0];
          if (command?.$kind !== 'MoveCall') throw new Error('fixture requires MoveCall');
          command.MoveCall.function = 'tampered';
        }),
    },
    {
      boundary: 'resolved PTB input',
      mutate: (transaction: GrpcTypes.ExecutedTransaction) =>
        replaceMoveViewBcs(transaction, (data) => {
          const input = data.inputs[0];
          if (input?.$kind !== 'Object' || input.Object.$kind !== 'ImmOrOwnedObject') {
            throw new Error('fixture requires an owned-object input');
          }
          input.Object.ImmOrOwnedObject.objectId = VIEW_PACKAGE;
        }),
    },
    {
      boundary: 'gas owner',
      mutate: (transaction: GrpcTypes.ExecutedTransaction) =>
        replaceMoveViewBcs(transaction, (data) => {
          data.gasData.owner = ID;
        }),
    },
    {
      boundary: 'gas payment',
      mutate: (transaction: GrpcTypes.ExecutedTransaction) =>
        replaceMoveViewBcs(transaction, (data) => {
          data.gasData.payment = [{ objectId: ID, version: '1', digest: GAS_DIGEST }];
        }),
    },
    {
      boundary: 'expiration',
      mutate: (transaction: GrpcTypes.ExecutedTransaction) =>
        replaceMoveViewBcs(transaction, (data) => {
          data.expiration = { $kind: 'Epoch', Epoch: 1 };
        }),
    },
    {
      boundary: 'zero gas price',
      mutate: (transaction: GrpcTypes.ExecutedTransaction) =>
        replaceMoveViewRawBcs(transaction, (data) => {
          data.V1.gasData.price = '0';
        }),
    },
    {
      boundary: 'zero gas budget',
      mutate: (transaction: GrpcTypes.ExecutedTransaction) =>
        replaceMoveViewRawBcs(transaction, (data) => {
          data.V1.gasData.budget = '0';
        }),
    },
    {
      boundary: 'omitted TransactionData digest',
      mutate: (transaction: GrpcTypes.ExecutedTransaction) => {
        delete transaction.transaction!.digest;
      },
    },
    {
      boundary: 'mismatched TransactionData digest',
      mutate: (transaction: GrpcTypes.ExecutedTransaction) => {
        transaction.transaction!.digest = DIGEST;
      },
    },
    {
      boundary: 'malformed effects simulation digest',
      mutate: (transaction: GrpcTypes.ExecutedTransaction) => {
        transaction.effects!.transactionDigest = 'not-a-sui-digest';
      },
    },
    {
      boundary: 'TransactionData evidence name',
      mutate: (transaction: GrpcTypes.ExecutedTransaction) => {
        transaction.transaction!.bcs!.name = 'LegacyTransactionData';
      },
    },
  ])(
    'fails over a self-contained Move-view response with changed $boundary',
    async ({ mutate }) => {
      const changed = moveViewEndpoint((transaction, outputs) => {
        mutate(transaction);
        return simulationResponse(transaction, outputs);
      });
      const current = moveViewEndpoint((transaction, outputs) =>
        simulationResponse(transaction, outputs),
      );

      await expect(
        simulateSuiMoveView(createSuiEndpointSnapshot([changed.client, current.client]), {
          transaction: moveViewTransaction(),
        }),
      ).resolves.toMatchObject({ outcome: 'success' });
      expect(changed.simulate).toHaveBeenCalledTimes(2);
      expect(current.simulate).toHaveBeenCalledTimes(2);
    },
  );

  it.each([
    {
      boundary: 'argument discriminant',
      mutate: (output: GrpcTypes.CommandOutput) => {
        output.argument = { kind: GrpcTypes.Argument_ArgumentKind.INPUT };
      },
    },
    {
      boundary: 'BCS name type',
      mutate: (output: GrpcTypes.CommandOutput) => {
        (output.value as unknown as { name: unknown }).name = 7;
      },
    },
    {
      boundary: 'JSON Value discriminant',
      mutate: (output: GrpcTypes.CommandOutput) => {
        output.json = {
          kind: { oneofKind: 'stringValue', stringValue: 'ok', boolValue: true },
        } as never;
      },
    },
  ])('fails over malformed current command-output $boundary', async ({ mutate }) => {
    const malformed = moveViewEndpoint((transaction, outputs) => {
      mutate(outputs[0]!.returnValues[0]!);
      return simulationResponse(transaction, outputs);
    });
    const current = moveViewEndpoint((transaction, outputs) =>
      simulationResponse(transaction, outputs),
    );

    await expect(
      simulateSuiMoveView(createSuiEndpointSnapshot([malformed.client, current.client]), {
        transaction: moveViewTransaction(),
      }),
    ).resolves.toMatchObject({ outcome: 'success' });
    expect(malformed.simulate).toHaveBeenCalledTimes(2);
    expect(current.simulate).toHaveBeenCalledTimes(2);
  });

  it('submits signed bytes to the primary once and keeps events on the execution result', async () => {
    const validSerializedSignature = (await SIGNER.signTransaction(BYTES)).signature;
    const primaryExecute = vi.fn(async (_request: unknown, _callOptions: unknown) => ({
      response: { transaction: rawTransaction(true, false) },
    }));
    const secondaryExecute = vi.fn();
    const result = await executeSuiTransaction(
      createSuiEndpointSnapshot([
        client({ transactionExecutionService: { executeTransaction: primaryExecute } }),
        client({ transactionExecutionService: { executeTransaction: secondaryExecute } }),
      ]),
      { transaction: BYTES, signatures: [validSerializedSignature] },
    );

    expect(result).toMatchObject({ outcome: 'success', digest: DIGEST, events: [] });
    expect(primaryExecute).toHaveBeenCalledTimes(1);
    expect(secondaryExecute).not.toHaveBeenCalled();
    expect(primaryExecute).toHaveBeenCalledWith(
      expect.objectContaining({
        readMask: expect.objectContaining({
          paths: expect.arrayContaining([
            'digest',
            'effects.status',
            'events.digest',
            'events.events.event_type',
          ]),
        }),
      }),
      expect.anything(),
    );
    const executeRequest = primaryExecute.mock.calls[0]![0] as {
      readMask: { paths: string[] };
      signatures: Array<{ bcs?: { value?: Uint8Array } }>;
    };
    expect(executeRequest.readMask.paths).not.toContain('transaction.effects.status');
    expect(executeRequest.signatures[0]?.bcs?.value).toEqual(fromBase64(validSerializedSignature));
  });

  it('binds the event envelope digest to effects while allowing nested event type identity', async () => {
    const topLevelPackage = `0x${'22'.repeat(32)}`;
    const eventPackage = `0x${'33'.repeat(32)}`;
    const event = {
      packageId: topLevelPackage,
      module: 'entry',
      sender: ID,
      eventType: `${eventPackage}::events::Settled`,
      contents: { value: new Uint8Array([7]) },
    };
    const current = vi.fn(async () => {
      const transaction = rawTransaction(true, false);
      return {
        response: {
          transaction: {
            ...transaction,
            effects: { ...transaction.effects, eventsDigest: EVENT_DIGEST },
            events: { digest: EVENT_DIGEST, events: [event] },
          },
        },
      };
    });
    const tampered = vi.fn(async () => {
      const transaction = rawTransaction(true, false);
      return {
        response: {
          transaction: {
            ...transaction,
            effects: { ...transaction.effects, eventsDigest: EVENT_DIGEST },
            events: { digest: DIGEST, events: [event] },
          },
        },
      };
    });

    const result = await getSuiTransactionEvents(
      createSuiEndpointSnapshot([
        client({ ledgerService: { getTransaction: tampered } }),
        client({ ledgerService: { getTransaction: current } }),
      ]),
      { digest: DIGEST },
    );

    expect(result).toMatchObject({
      outcome: 'success',
      events: [
        {
          packageId: topLevelPackage,
          module: 'entry',
          eventType: `${eventPackage}::events::Settled`,
        },
      ],
    });
    expect(tampered).toHaveBeenCalledTimes(1);
    expect(current).toHaveBeenCalledTimes(1);
  });

  it('accepts the current omitted event envelope only when effects prove there are no events', async () => {
    const validSerializedSignature = (await SIGNER.signTransaction(BYTES)).signature;
    const execute = vi.fn(async () => ({
      response: { transaction: rawTransaction(true, false) },
    }));
    await expect(
      executeSuiTransaction(
        createSuiEndpointSnapshot([
          client({ transactionExecutionService: { executeTransaction: execute } }),
        ]),
        { transaction: BYTES, signatures: [validSerializedSignature] },
      ),
    ).resolves.toMatchObject({ outcome: 'success', events: [] });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('rejects canonical base64 that is not a current serialized Sui signature', async () => {
    const execute = vi.fn();
    expect(() =>
      executeSuiTransaction(
        createSuiEndpointSnapshot([
          client({ transactionExecutionService: { executeTransaction: execute } }),
        ]),
        { transaction: BYTES, signatures: ['AQ=='] },
      ),
    ).toThrow('current serialized signature format');
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects a sparse signature array before signed execution', () => {
    const execute = vi.fn();
    expect(() =>
      executeSuiTransaction(
        createSuiEndpointSnapshot([
          client({ transactionExecutionService: { executeTransaction: execute } }),
        ]),
        { transaction: BYTES, signatures: new Array<string>(1) },
      ),
    ).toThrow('signatures: expected a dense array');
    expect(execute).not.toHaveBeenCalled();
  });

  it('keeps an effects lookup free of unrequested event placeholders', async () => {
    const getTransaction = vi.fn(async (_request: unknown, _callOptions: unknown) => ({
      response: { transaction: rawTransaction(true) },
    }));
    const result = await getSuiTransactionEffects(
      createSuiEndpointSnapshot([client({ ledgerService: { getTransaction } })]),
      { digest: DIGEST },
    );

    expect(result.outcome).toBe('success');
    expect('events' in result).toBe(false);
    const effectsRequest = getTransaction.mock.calls[0]![0] as {
      readMask: { paths: string[] };
    };
    expect(effectsRequest.readMask.paths).toContain('effects.status');
    expect(effectsRequest.readMask.paths).not.toContain('transaction.effects.status');
  });

  it('does not fail over the current omitted envelope when effects prove there are no events', async () => {
    const omitted = vi.fn(async (_request: unknown, _callOptions: unknown) => ({
      response: { transaction: rawTransaction(true, false) },
    }));
    const current = vi.fn(async (_request: unknown, _callOptions: unknown) => ({
      response: { transaction: rawTransaction(true, false) },
    }));
    const result = await getSuiTransactionEvents(
      createSuiEndpointSnapshot([
        client({ ledgerService: { getTransaction: omitted } }),
        client({ ledgerService: { getTransaction: current } }),
      ]),
      { digest: DIGEST },
    );

    expect(result).toMatchObject({ outcome: 'success', digest: DIGEST, events: [] });
    expect(omitted).toHaveBeenCalledTimes(1);
    expect(current).not.toHaveBeenCalled();
    const request = omitted.mock.calls[0]![0] as { readMask: { paths: string[] } };
    expect(request.readMask.paths).toContain('events.events.event_type');
    expect(request.readMask.paths).toContain('events.digest');
    expect(request.readMask.paths).not.toContain('transaction.events.events.event_type');
  });

  it('fails over when an event digest exists but the requested envelope is missing', async () => {
    const malformed = vi.fn(async (_request: unknown, _callOptions: unknown) => {
      const transaction = rawTransaction(true, false);
      return {
        response: {
          transaction: {
            ...transaction,
            effects: { ...transaction.effects, eventsDigest: DIGEST },
          },
        },
      };
    });
    const current = vi.fn(async (_request: unknown, _callOptions: unknown) => ({
      response: { transaction: rawTransaction(true, false) },
    }));

    await expect(
      getSuiTransactionEvents(
        createSuiEndpointSnapshot([
          client({ ledgerService: { getTransaction: malformed } }),
          client({ ledgerService: { getTransaction: current } }),
        ]),
        { digest: DIGEST },
      ),
    ).resolves.toMatchObject({ outcome: 'success', events: [] });
    expect(malformed).toHaveBeenCalledTimes(1);
    expect(current).toHaveBeenCalledTimes(1);
  });

  it('returns exact balance changes and fails over malformed current entries', async () => {
    const omittedTransaction = GrpcTypes.ExecutedTransaction.create({
      digest: DIGEST,
      balanceChanges: [{ address: ID, coinType: '0x2::sui::SUI', amount: '-7' }],
    });
    delete (omittedTransaction as unknown as Record<string, unknown>).signatures;
    const omitted = vi.fn(async (_request: unknown, _callOptions: unknown) => ({
      response: { transaction: omittedTransaction },
    }));
    const malformed = vi.fn(async (_request: unknown, _callOptions: unknown) => ({
      response: {
        transaction: GrpcTypes.ExecutedTransaction.create({
          digest: DIGEST,
          balanceChanges: [{ address: ID, coinType: '0x2::sui::SUI', amount: '-0' }],
        }),
      },
    }));
    const current = vi.fn(async (_request: unknown, _callOptions: unknown) => ({
      response: {
        transaction: GrpcTypes.ExecutedTransaction.create({
          digest: DIGEST,
          balanceChanges: [{ address: ID, coinType: '0x2::sui::SUI', amount: '-7' }],
        }),
      },
    }));
    const result = await getSuiTransactionBalanceChanges(
      createSuiEndpointSnapshot([
        client({ ledgerService: { getTransaction: omitted } }),
        client({ ledgerService: { getTransaction: malformed } }),
        client({ ledgerService: { getTransaction: current } }),
      ]),
      { digest: DIGEST },
    );

    expect(result).toEqual({
      digest: DIGEST,
      balanceChanges: [
        {
          address: ID,
          coinType: `0x${'0'.repeat(63)}2::sui::SUI`,
          amount: '-7',
        },
      ],
    });
    expect(omitted).toHaveBeenCalledTimes(1);
    expect(malformed).toHaveBeenCalledTimes(1);
    expect(current).toHaveBeenCalledTimes(1);
    const balanceRequest = current.mock.calls[0]![0] as {
      readMask: { paths: string[] };
    };
    expect(balanceRequest.readMask.paths).toEqual(['digest', 'balance_changes']);
  });
});
